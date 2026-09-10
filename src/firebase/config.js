// Backend configuration.
//
// The app now talks to the Go API (see server/) backed by PostgreSQL, instead of Firebase.
// This module is kept at its original path so src/app.jsx and the other modules under
// src/firebase/ do not need their imports rewritten.
//
// The former Firebase configuration is preserved in src/firebase/_legacy-firebase/config.js.
// The Firestore project itself was NOT deleted - the migration only read from it.

export { API_BASE, getToken, setToken } from "./apiClient";

// Set VITE_API_BASE in .env to point the frontend at a different API host.
// Defaults to http://localhost:8080, which is what `npm run api` serves.
