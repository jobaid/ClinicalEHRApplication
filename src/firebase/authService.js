// Authentication for the medical billing app.
//
// BACKEND: Go REST API + PostgreSQL. Previously Firebase Auth. Every exported function keeps its
// original name, arguments and return shape so src/app.jsx is untouched - signIn still resolves
// to something with `.user.uid` and `.user.email`, fetchUserProfile still returns the users
// record, and createUserAccount still returns the new uid without disturbing the admin's session.
//
// Accounts migrated out of Firebase kept their original scrypt password hashes, so everyone
// signs in with the password they already had. The original Firebase implementation is preserved
// for reference in src/firebase/_legacy-firebase/.

import { api, setToken, getToken } from "./apiClient";
import { getCache, refetch, clearAll } from "./collectionStore";

// Resolves to a Firebase-shaped credential: { user: { uid, email } }.
export async function signIn(email, password) {
  const res = await api("/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
  setToken(res.token); // also opens the change feed
  return { user: { uid: res.user.uid, email: res.user.email } };
}

export async function signOutUser() {
  setToken(null); // also closes the change feed
  clearAll();
}

// Firebase called back with the restored user on page load. src/app.jsx does not use this - it
// restores its own session from localStorage - but the export is kept so the module's contract
// is unchanged. It reports the currently stored session, if any.
export function onAuthState(callback) {
  let cancelled = false;
  if (!getToken()) {
    callback(null);
  } else {
    api("/api/auth/me")
      .then((me) => !cancelled && callback({ uid: me.uid, email: me.email }))
      .catch(() => !cancelled && callback(null));
  }
  return () => {
    cancelled = true;
  };
}

// The credential only carries uid/email - role and display name live in the users table, keyed
// by uid, written by the seed/migration or the in-app "add user" admin flow.
export async function fetchUserProfile(uid) {
  const cache = getCache("users");
  if (cache.loading) await refetch("users");
  const found = cache.data.find((u) => u.id === uid);
  if (!found) return null;
  return { uid, ...found };
}

// Creates a new account without signing the calling admin out of their own session. The Firebase
// client SDK needed a throwaway secondary app to achieve that; the Go API simply creates the
// credential as an admin operation. As before, the caller is responsible for writing the new
// user's profile row (see addUserAccount in app.jsx), because that write must happen as the
// ADMIN, whose role authorises it.
export async function createUserAccount(email, password) {
  const res = await api("/api/auth/users", {
    method: "POST",
    body: { email, password },
  });
  return res.uid;
}
