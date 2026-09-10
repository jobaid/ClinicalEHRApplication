import { useEffect, useState } from "react";
import {
  collection, doc, onSnapshot, setDoc, updateDoc, addDoc, deleteDoc, writeBatch,
} from "firebase/firestore";
import { db } from "./config";

export function colRef(name) {
  return collection(db, name);
}

export function docRef(name, id) {
  return doc(db, name, id);
}

// Real-time collection read — every part of the app that used to hold a seeded array in
// useState now holds this instead, so a write from anywhere (this tab, another tab, another
// user) shows up immediately without any manual local-state merging.
//
// `enabled` (default true) skips subscribing entirely — pass false for a collection whose
// security rules only some callers can list (e.g. "users", which only account admins may read
// in full per firestore.rules). Subscribing unconditionally there would throw a permission-denied
// error for everyone else instead of just not reading it. Disabled reads resolve as [], loaded.
export function useFirestoreCollection(name, enabled = true) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = onSnapshot(colRef(name), (snap) => {
      setData(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    return unsubscribe;
  }, [name, enabled]);

  // Disabled reads are presented as [] / not-loading regardless of internal state, rather than
  // ever calling setState synchronously from the effect body for the disabled case.
  return enabled ? [data, loading] : [[], false];
}

// Writes with a caller-chosen id (the app's existing uid("PREFIX") scheme) rather than a
// Firestore auto-id — every screen already treats these ids as opaque, human-readable strings
// (patient MRNs, charge/claim numbers), so preserving them keeps the rest of the app unchanged.
export function setDocument(name, id, data) {
  return setDoc(docRef(name, id), data);
}

export function updateDocument(name, id, updates) {
  return updateDoc(docRef(name, id), updates);
}

export async function addDocument(name, data, id) {
  if (id) {
    await setDoc(docRef(name, id), data);
    return id;
  }
  const ref = await addDoc(colRef(name), data);
  return ref.id;
}

export function deleteDocument(name, id) {
  return deleteDoc(docRef(name, id));
}

// Multi-document writes (a charge update alongside its transaction/audit records, for example)
// go through one batch so they commit atomically, the way the old in-memory version did "for
// free" by updating several useState arrays inside one function call.
export function newBatch() {
  return writeBatch(db);
}
