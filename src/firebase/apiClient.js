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

export const API_BASE = import.meta.env.VITE_API_BASE || defaultApiBase;

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

export async function api(path, { method = "GET", body, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
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
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return null;
  return res.json();
}
