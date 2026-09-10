// Live collection cache - the replacement for Firestore's onSnapshot.
//
// Firestore pushed every change to every listening client, which is why src/app.jsx never merges
// local state after a write: it just writes, and the snapshot comes back. To keep that exact
// behaviour, this module holds one shared cache per collection plus a single Server-Sent Events
// connection for the whole app. When the API reports that a collection changed - because of this
// tab, another tab, or another user - the affected collection is refetched and every subscribed
// component re-renders.
//
// One connection and one cache are shared across all 22 useFirestoreCollection() call sites, so
// mounting the app opens a single stream, not 22.

import { API_BASE, api, getToken, onTokenChange } from "./apiClient";

const caches = new Map(); // name -> { data, loading, subs:Set<fn>, inflight:Promise|null }

function entry(name) {
  let e = caches.get(name);
  if (!e) {
    e = { data: [], loading: true, subs: new Set(), inflight: null };
    caches.set(name, e);
  }
  return e;
}

function emit(e) {
  e.subs.forEach((fn) => fn());
}

// refetch pulls a whole collection. Concurrent calls share one request, and a change that lands
// while a fetch is in flight schedules exactly one more so the cache cannot settle on stale data.
export function refetch(name) {
  const e = entry(name);
  if (e.inflight) {
    e.pending = true;
    return e.inflight;
  }
  e.inflight = api(`/api/collections/${name}`)
    .then((docs) => {
      e.data = Array.isArray(docs) ? docs : [];
      e.loading = false;
      emit(e);
    })
    .catch((err) => {
      // A failed read leaves the previous data in place rather than blanking the UI; the app
      // treats "loaded but empty" as real data, so blanking would look like deletion.
      e.loading = false;
      if (err?.status !== 401) console.error(`[medbill] failed to load ${name}:`, err.message);
      emit(e);
    })
    .finally(() => {
      e.inflight = null;
      if (e.pending) {
        e.pending = false;
        refetch(name);
      }
    });
  return e.inflight;
}

export function getCache(name) {
  return entry(name);
}

export function subscribe(name, fn) {
  const e = entry(name);
  e.subs.add(fn);
  return () => e.subs.delete(fn);
}

// Called by every write helper so the UI updates immediately, without waiting for the change to
// come back around through the event stream.
export function invalidate(names) {
  const list = Array.isArray(names) ? names : [names];
  [...new Set(list)].forEach((n) => {
    if (caches.has(n)) refetch(n);
  });
}

export function clearAll() {
  caches.forEach((e) => {
    e.data = [];
    e.loading = true;
    emit(e);
  });
}

// ---------- change feed ----------

let stream = null;
let retry = null;

function closeStream() {
  if (stream) {
    stream.close();
    stream = null;
  }
  if (retry) {
    clearTimeout(retry);
    retry = null;
  }
}

export function openStream() {
  closeStream();
  const token = getToken();
  if (!token) return;

  // EventSource cannot set an Authorization header, so the token rides as a query parameter -
  // the API accepts it there for this endpoint only.
  stream = new EventSource(`${API_BASE}/api/stream?access_token=${encodeURIComponent(token)}`);

  stream.addEventListener("change", (ev) => {
    try {
      const { collection } = JSON.parse(ev.data);
      // Only refetch collections this client actually reads.
      if (collection && caches.has(collection)) refetch(collection);
    } catch {
      // Ignore malformed frames.
    }
  });

  stream.onerror = () => {
    // EventSource retries on its own, but a dropped connection may have hidden changes, so on
    // reconnect everything currently cached is refetched. Backoff is fixed and short because
    // this is a same-origin local API.
    closeStream();
    retry = setTimeout(() => {
      openStream();
      caches.forEach((_, name) => refetch(name));
    }, 3000);
  };
}

// Reopen the feed whenever the session changes: a fresh sign-in needs a stream, a sign-out must
// drop it so the server stops pushing to a client that is no longer authorised.
onTokenChange((next) => {
  if (next) openStream();
  else closeStream();
});

if (getToken()) openStream();
