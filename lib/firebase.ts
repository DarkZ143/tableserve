"use client";

import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore";

const values = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
};

export const firebaseConfigured = Object.values(values).every((value) => Boolean(value));
export const firebaseEmulatorsEnabled =
  process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true";

let emulatorsStarted = false;

export function getFirebase(): {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
} {
  if (!firebaseConfigured) {
    throw new Error("Firebase is not configured. Add the NEXT_PUBLIC_FIREBASE_* values from .env.example.");
  }
  const app = getApps().length ? getApp() : initializeApp(values);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const useEmulators = firebaseEmulatorsEnabled;
  if (useEmulators && !emulatorsStarted) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    emulatorsStarted = true;
  }
  return {
    app,
    auth,
    db,
  };
}
