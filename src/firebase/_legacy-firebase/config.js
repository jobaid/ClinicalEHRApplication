import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";

// No Cloud Storage here — Firebase requires the project to be on the Blaze billing plan to
// provision a Storage bucket (or a Realtime Database instance) at all, even for free-tier usage.
// ID documents are instead stored inline on their Firestore document as a base64 data URL (see
// uploadIdDocument in app.jsx) — works fully on the free Spark plan.
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Local dev talks to the Firebase Local Emulator Suite by default (see firebase.json for ports),
// so the app works fully offline against seeded fake data without touching a real project. Set
// VITE_USE_FIREBASE_EMULATOR=false in .env.local to point a dev server at a real project instead.
// Exported so other modules (e.g. authService's secondary-app helper for creating users) know
// whether to point their own Firebase instances at the emulators too.
export const useEmulator = import.meta.env.DEV && import.meta.env.VITE_USE_FIREBASE_EMULATOR !== "false";
if (useEmulator && !globalThis.__FIREBASE_EMULATORS_CONNECTED__) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  globalThis.__FIREBASE_EMULATORS_CONNECTED__ = true;
}
