// Data access for the medical billing app.
//
// BACKEND: Go REST API + PostgreSQL. This module previously wrapped the Firestore client SDK;
// every exported function keeps the exact same name, arguments and return type, so src/app.jsx
// is untouched by the migration. The original Firestore implementation is preserved for
// reference in src/firebase/_legacy-firebase/.
//
// Reads come from a shared live cache (see collectionStore.js) that is kept current by a
// Server-Sent Events change feed, reproducing Firestore's onSnapshot behaviour: a write from
// this tab, another tab, or another user shows up without any manual local-state merging.

import { useEffect, useState } from "react";
import { api } from "./apiClient";
import { getCache, subscribe, refetch, invalidate } from "./collectionStore";

// A document reference is just the collection/id pair the batch API needs. It stays an opaque
// value to callers, exactly as Firestore's DocumentReference was.
export function docRef(name, id) {
  return { collection: name, id };
}

export function colRef(name) {
  return { collection: name };
}

// Real-time collection read. Same contract as before: [data, loading], where `enabled=false`
// resolves as [[], false] without subscribing.
export function useFirestoreCollection(name, enabled = true) {
  const cache = getCache(name);
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const unsubscribe = subscribe(name, () => forceRender((n) => n + 1));
    // First mount of this collection anywhere in the app triggers the initial load; later
    // mounts reuse the cache that is already being kept up to date.
    if (cache.loading && !cache.inflight) refetch(name);
    return unsubscribe;
  }, [name, enabled, cache]);

  return enabled ? [cache.data, cache.loading] : [[], false];
}

// Writes with a caller-chosen id (the app's uid("PREFIX") scheme) rather than a generated one -
// every screen treats these ids as opaque, human-readable strings (patient MRNs, charge/claim
// numbers), so preserving them keeps the rest of the app unchanged.
export async function setDocument(name, id, data) {
  const res = await api(`/api/collections/${name}/${id}`, { method: "PUT", body: data });
  invalidate(name);
  return res;
}

export async function updateDocument(name, id, updates) {
  const res = await api(`/api/collections/${name}/${id}`, { method: "PATCH", body: updates });
  invalidate(name);
  return res;
}

export async function addDocument(name, data, id) {
  if (id) {
    await setDocument(name, id, data);
    return id;
  }
  const res = await api(`/api/collections/${name}`, { method: "POST", body: data });
  invalidate(name);
  return res.id;
}

export async function deleteDocument(name, id) {
  const res = await api(`/api/collections/${name}/${id}`, { method: "DELETE" });
  invalidate(name);
  return res;
}

// Multi-document writes (a charge update alongside its transaction/audit records, for example)
// go through one batch so they commit atomically. Firestore's writeBatch became a single SQL
// transaction on the server; the client-side API is unchanged, including the fact that nothing
// is sent until commit() is called.
export function newBatch() {
  const ops = [];
  return {
    set(ref, data) {
      ops.push({ op: "set", collection: ref.collection, id: ref.id, data });
      return this;
    },
    update(ref, data) {
      ops.push({ op: "update", collection: ref.collection, id: ref.id, data });
      return this;
    },
    delete(ref) {
      ops.push({ op: "delete", collection: ref.collection, id: ref.id });
      return this;
    },
    async commit() {
      if (ops.length === 0) return null;
      const res = await api("/api/batch", { method: "POST", body: ops });
      invalidate(ops.map((o) => o.collection));
      return res;
    },
  };
}
