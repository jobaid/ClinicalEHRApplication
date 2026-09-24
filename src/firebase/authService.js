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

import { api, setToken, getToken, setTokenProvider } from "./apiClient";
import { firebaseAuthEnabled, firebaseSignIn, firebaseSignOut, firebaseCurrentToken } from "./firebaseAuth";
import { getCache, refetch, clearAll } from "./collectionStore";

// Resolves to a Firebase-shaped credential: { user: { uid, email } } when sign-in is complete.
//
// When a second factor is outstanding it resolves to { mfa: {...} } instead and NO session token
// is stored - the caller must finish through verifyMfa() or confirmEnrollment(). Keeping the
// success shape unchanged means every existing caller still works.
export async function signIn(email, password) {
  // Firebase path: Google verifies the password and issues an ID token; the Go API verifies that
  // token and answers with the account's role. Sign-in fails here if the account is unknown to
  // this practice, so a Firebase account by itself grants no access.
  if (firebaseAuthEnabled()) {
    const cred = await firebaseSignIn(email, password);
    // Every later request resolves a freshly refreshed token through this provider.
    setTokenProvider(() => firebaseCurrentToken());
    setToken(await cred.getToken());
    const me = await api("/api/auth/me");
    return { user: { uid: me.uid, email: me.email, isDemo: !!me.isDemo } };
  }

  const res = await api("/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
  if (res.mfaRequired || res.mfaEnrollRequired) {
    return {
      mfa: {
        challenge: res.challenge,
        enroll: !!res.mfaEnrollRequired,
        email: res.email || email,
        backupCodesLeft: res.backupCodes ?? null,
      },
    };
  }
  setToken(res.token); // also opens the change feed
  return { user: { uid: res.user.uid, email: res.user.email, isDemo: !!res.user.isDemo } };
}

/**
 * Credentials for the demonstration account, or {enabled: false}.
 *
 * Unauthenticated, because the login page calls it before anyone has signed in. It returns a
 * password, which is safe for this one account and this one account only: it exists to be signed
 * into by strangers and its password is printed on the page. The server confirms against the
 * database that the address really is a demo account before answering, so a stale environment
 * variable can never cause a real user's address to be shown next to a password.
 */
export async function demoInfo() {
  try {
    return await api("/api/auth/demo");
  } catch {
    // A demo panel that fails to load should leave the normal login form working.
    return { enabled: false };
  }
}

// ---------- multi-factor authentication ----------
//
// Each of these carries the challenge token explicitly rather than through the stored session,
// because during sign-in there is no session yet - that is the whole point of the challenge.

export async function verifyMfa(challenge, code, trustDevice) {
  const res = await api("/api/auth/mfa/verify", {
    method: "POST",
    authToken: challenge,
    body: { code, trustDevice: !!trustDevice },
  });
  setToken(res.token);
  return { user: { uid: res.user.uid, email: res.user.email } };
}

export async function startMfaEnrollment(challenge) {
  return api("/api/auth/mfa/enroll/start", { method: "POST", authToken: challenge });
}

export async function confirmMfaEnrollment(challenge, code, trustDevice) {
  const res = await api("/api/auth/mfa/enroll/confirm", {
    method: "POST",
    authToken: challenge,
    body: { code, trustDevice: !!trustDevice },
  });
  // Enrolling during sign-in completes it; enrolling from Settings returns no token and leaves
  // the existing session alone.
  if (res.token) setToken(res.token);
  return res;
}

export async function securityStatus() {
  return api("/api/auth/mfa/status");
}

export async function disableMfa(password) {
  return api("/api/auth/mfa/disable", { method: "POST", body: { password } });
}

export async function listTrustedDevices() {
  const res = await api("/api/auth/devices");
  return res.devices || [];
}

export async function revokeTrustedDevice(id) {
  return api(`/api/auth/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function revokeAllTrustedDevices() {
  return api("/api/auth/devices", { method: "DELETE" });
}

export async function signOutUser() {
  setTokenProvider(null);
  if (firebaseAuthEnabled()) await firebaseSignOut();
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

// Changes the signed-in user's own password. The server re-verifies currentPassword before
// accepting the change, so this cannot be used to take over an unattended session.
export async function changeOwnPassword(currentPassword, newPassword) {
  await api("/api/auth/password", {
    method: "POST",
    body: { currentPassword, newPassword },
  });
}

// SUPER_ADMIN only: sets another account's password. There is no email in this app, so this is
// the recovery path for someone who is locked out.
export async function adminResetPassword(uid, newPassword) {
  await api(`/api/auth/users/${uid}/password`, {
    method: "POST",
    body: { newPassword },
  });
}
