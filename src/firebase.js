import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithCustomToken,
  signOut,
  setPersistence,
  browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export const firebaseConfig = {
  apiKey: "AIzaSyA5EVkg2K1YoP65Ej3HBGgfHDBOOwnKbSs",
  authDomain: "inworkcosmo.firebaseapp.com",
  projectId: "inworkcosmo",
  storageBucket: "inworkcosmo.firebasestorage.app",
  messagingSenderId: "384225621712",
  appId: "1:384225621712:web:5767b990f5b588a43350d5",
  measurementId: "G-TJH9MJCZHC"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

setPersistence(auth, browserSessionPersistence);

export {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onAuthStateChanged,
  query,
  signInWithCustomToken,
  signOut,
  where
};
