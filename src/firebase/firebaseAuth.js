// Firebase Authentication as the identity provider.
//
// Active only when VITE_FIREBASE_PROJECT_ID and VITE_FIREBASE_API_KEY are set. With them unset the
// app keeps signing in against the Go API exactly as before, so this file changes nothing until it
// is configured - the switch is a deployment decision, not a code change.
//
// What Firebase does here: proves who someone is, and issues a short-lived ID token.
// What it does NOT do: decide what they may see. Roles, permissions and the MFA/trusted-device
// rules stay server-side in PostgreSQL, so signing in to the Firebase project grants nothing on
// its own - the Go API still has to recognise the account.

let appPromise = null;

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

/**
 * True only when this build is explicitly told to authenticate through Firebase.
 *
 * Requires VITE_AUTH_PROVIDER=firebase, NOT merely the presence of a Firebase config. Those two
 * are very different things: a project's config often sits in .env.local for Firestore, hosting or
 * a half-finished experiment, and treating that as "route every sign-in through Google" would
 * change how the whole practice logs in as a side effect of an unrelated setting. Changing who
 * authenticates your users should take a deliberate line in a config file, not an accident.
 */
export function firebaseAuthEnabled() {
  return (
    String(import.meta.env.VITE_AUTH_PROVIDER || "").toLowerCase() === "firebase" &&
    Boolean(firebaseConfig.apiKey && firebaseConfig.projectId)
  );
}

/**
 * Loads the Firebase SDK on demand.
 *
 * Imported dynamically so a deployment that does not use Firebase never downloads it: the SDK is
 * several hundred kilobytes, and this app is used all day on clinic machines.
 */
async function getAuthInstance() {
  if (!firebaseAuthEnabled()) throw new Error("Firebase authentication is not configured.");
  if (!appPromise) {
    appPromise = (async () => {
      const { initializeApp, getApps, getApp } = await import("firebase/app");
      const { getAuth, setPersistence, browserLocalPersistence } = await import("firebase/auth");
      const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
      const auth = getAuth(app);
      // Survives a page reload, matching how the app already behaves.
      await setPersistence(auth, browserLocalPersistence).catch(() => {});
      return auth;
    })();
  }
  return appPromise;
}

/** Signs in with email and password. Resolves to { uid, email, getToken }. */
export async function firebaseSignIn(email, password) {
  const auth = await getAuthInstance();
  const { signInWithEmailAndPassword } = await import("firebase/auth");
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return {
    uid: cred.user.uid,
    email: cred.user.email,
    getToken: (force) => cred.user.getIdToken(force),
  };
}

export async function firebaseSignOut() {
  if (!firebaseAuthEnabled() || !appPromise) return;
  const auth = await getAuthInstance();
  const { signOut } = await import("firebase/auth");
  await signOut(auth).catch(() => {});
}

/**
 * Returns a fresh ID token for the signed-in user, or null.
 *
 * Firebase ID tokens last an hour. The SDK refreshes them in the background, but only if asked -
 * so every API call resolves the current token through here rather than reusing one captured at
 * sign-in. Without this, the application would start failing with 401s an hour into a shift.
 */
export async function firebaseCurrentToken(forceRefresh = false) {
  if (!firebaseAuthEnabled()) return null;
  try {
    const auth = await getAuthInstance();
    if (!auth.currentUser) return null;
    return await auth.currentUser.getIdToken(forceRefresh);
  } catch {
    return null;
  }
}

/** Resolves once Firebase has restored (or failed to restore) a session on page load. */
export async function firebaseRestoredUser() {
  if (!firebaseAuthEnabled()) return null;
  const auth = await getAuthInstance();
  const { onAuthStateChanged } = await import("firebase/auth");
  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (user) => {
      stop();
      resolve(user ? { uid: user.uid, email: user.email } : null);
    });
  });
}
