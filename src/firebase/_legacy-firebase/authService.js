import { initializeApp, deleteApp } from "firebase/app";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged, getAuth, createUserWithEmailAndPassword, connectAuthEmulator } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db, firebaseConfig, useEmulator } from "./config";

// Real auth always goes through Firebase — nothing here checks a hardcoded password list.
export function signIn(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function signOutUser() {
  return signOut(auth);
}

export function onAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

// The Firebase Auth user only carries uid/email — role and display name live in Firestore,
// keyed by uid, written once by the seed script or the in-app "add user" admin flow.
export async function fetchUserProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return null;
  return { uid, ...snap.data() };
}

// Creates a brand-new Firebase Auth account without signing the calling admin out of their own
// session. The client SDK's createUserWithEmailAndPassword always signs in as the account it
// just created — undesirable when an admin is adding someone else — so this runs it against a
// throwaway secondary App instance instead, then tears that instance down. The caller is
// responsible for writing the new user's Firestore profile (see addUserAccount in app.jsx),
// since that write needs to happen as the ADMIN (whose role authorizes it under firestore.rules),
// not as the brand-new account.
export async function createUserAccount(email, password) {
  const secondaryApp = initializeApp(firebaseConfig, `secondary-${Date.now()}`);
  const secondaryAuth = getAuth(secondaryApp);
  if (useEmulator) connectAuthEmulator(secondaryAuth, "http://127.0.0.1:9099", { disableWarnings: true });
  try {
    const credential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    return credential.user.uid;
  } finally {
    await signOut(secondaryAuth).catch(() => {});
    await deleteApp(secondaryApp);
  }
}
