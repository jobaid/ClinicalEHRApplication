// Low-level transport for the Go API.
//
// This module owns the session token and the raw fetch calls. Nothing above it needs to know
// that the backend changed from Firebase to Go/PostgreSQL - authService.js and
// firestoreService.js keep the exact function signatures src/app.jsx already imports.

// Default to the API on port 8080 of whatever host is serving this page. Hardcoding
// "localhost" breaks the moment you open the app through Vite's Network URL
// (http://192.168.x.x:5173) or from another device, because "localhost" would then mean the
// *browser's* machine. Override with VITE_API_BASE when the API lives elsewhere.
const defaultApiBase =
  typeof window !== "undefined" && window.location?.hostname
    ? `${window.location.protocol}//${window.location.hostname}:8080`
    : "http://localhost:8080";

// An unset VITE_API_BASE keeps the host-derived default above. Setting it to the empty string is
// meaningful and different: it means "same origin", which is how the Docker image is built —
// nginx serves the app and proxies /api to the API container, so requests never leave the origin
// and CORS stops being part of the deployment at all. Hence the explicit undefined check rather
// than `||`, which would treat the empty string as "unset" and silently reintroduce cross-origin
// calls to port 8080.
const configuredApiBase = import.meta.env.VITE_API_BASE;
export const API_BASE =
  configuredApiBase === undefined ? defaultApiBase : configuredApiBase.replace(/\/$/, "");

// The token lives in localStorage so a page reload keeps the session, the same way the Firebase
// SDK used to persist its own credentials. src/app.jsx separately persists its `clinic_session`
// object with the user's name and role; the two are cleared together on sign-out.
const TOKEN_KEY = "medbill_token";

let token = null;
try {
  token = localStorage.getItem(TOKEN_KEY);
} catch {
  token = null; // private mode / storage disabled
}

const tokenListeners = new Set();

export function getToken() {
  return token;
}

export function setToken(next) {
  token = next;
  try {
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Non-persistent session is still usable for this tab.
  }
  tokenListeners.forEach((fn) => fn(next));
}

// Lets the collection store reopen its change-feed when the session changes.
export function onTokenChange(fn) {
  tokenListeners.add(fn);
  return () => tokenListeners.delete(fn);
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let tokenProvider = null;

/**
 * Installs a function that returns the current bearer token.
 *
 * Used when Firebase is the identity provider: its ID tokens expire after an hour and the SDK
 * only refreshes them on request, so the token must be resolved per call rather than captured
 * once at sign-in.
 */
export function setTokenProvider(fn) {
  tokenProvider = fn;
}

export async function api(path, { method = "GET", body, signal, authToken } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // `authToken` carries the short-lived MFA challenge, which is deliberately NOT the stored
  // session token - the stored one does not exist yet at that point in the sign-in.
  // A provider lets Firebase hand over a freshly refreshed ID token per request; without one the
  // stored token is used, which is how the Go API's own 12-hour session works.
  const bearer = authToken ?? (tokenProvider ? await tokenProvider() : null) ?? token;
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      // The trusted-device cookie is httpOnly, so script cannot attach it by hand; the browser
      // only sends it when the request is made with credentials. Without this, "trust this
      // device" would appear to work and then never be recognised.
      credentials: "include",
    });
  } catch (err) {
    // A network-level failure (API down, or this page's origin rejected by CORS) reaches the
    // login screen through a bare catch and is displayed as "Invalid email or password", which
    // sends people hunting for the wrong problem. Say what actually happened, here.
    if (err?.name !== "AbortError") {
      console.error(
        `[medbill] cannot reach the API at ${API_BASE}${path}
  - is it running?    npm run api
  - page origin is ${window.location.origin}; the API must allow that origin
  - underlying error: ${err?.message}`
      );
    }
    throw new ApiError(0, `Cannot reach the API at ${API_BASE}. Is the server running?`);
  }

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // Non-JSON error body; keep the status line.
    }
    if (res.status === 401) expireSession();
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return null;
  return res.json();
}

// A 401 means the stored token is no longer accepted - it expired, the account was disabled, or
// the API restarted with a new signing secret. Dropping the token here fires onTokenChange, which
// closes the change-feed and lets the app fall back to the sign-in screen.
//
// Without this the session looked alive while every read failed: collections resolved to "loaded
// and empty", the app rendered a shell with no data, and any screen restored from the saved
// navigation position - a patient's billing page, say - looked up an id that was no longer there.
// A blank page is a worse answer to "your session ended" than a login form.
function expireSession() {
  if (token !== null) setToken(null);
}

// Same transport as api(), but for endpoints that answer with a file rather than JSON.
//
// Kept as a separate function instead of a flag on api() so the JSON path stays the simple one
// every existing caller already relies on. Errors still arrive as JSON - the server sends an
// {error} body on failure and only switches to the binary content type once it has something to
// send - so the failure branch is shared and callers get the same ApiError they are used to.
export async function apiBlob(path, { method = "POST", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, `Cannot reach the API at ${API_BASE}. Is the server running?`);
  }

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // Non-JSON error body; keep the status line.
    }
    throw new ApiError(res.status, message);
  }

  // The server names the file in Content-Disposition; honouring it keeps the downloaded name the
  // same as the one the audit log refers to.
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob: await res.blob(), filename: match ? match[1] : "download.pdf" };
}

// Same transport again, for sending a file up.
//
// Note what is deliberately absent: a Content-Type header. A multipart body has to carry a
// boundary string in its content type, and that boundary is generated by FormData. Setting the
// header by hand omits it, and the server then rejects a body it cannot split. Letting fetch
// derive the header from the FormData is the only way this works.
export async function apiUpload(path, file, { field = "file", extra } = {}) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const form = new FormData();
  form.append(field, file, file.name);
  // Optional companion fields, so one multipart request can carry a file plus the metadata that
  // describes it. Existing callers pass none and behave exactly as before.
  if (extra) for (const [k, v] of Object.entries(extra)) form.append(k, v ?? "");

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: "POST", headers, body: form });
  } catch {
    throw new ApiError(0, `Cannot reach the API at ${API_BASE}. Is the server running?`);
  }

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // Non-JSON error body; keep the status line.
    }
    if (res.status === 401) expireSession();
    throw new ApiError(res.status, message);
  }
  return res.json();
}
