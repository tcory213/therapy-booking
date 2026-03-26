import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBThNaSPvvIfCZIJVUEEy_Pelfp4LkWB1I",
  authDomain: "clinic-booking-277e7.firebaseapp.com",
  projectId: "clinic-booking-277e7",
  storageBucket: "clinic-booking-277e7.firebasestorage.app",
  messagingSenderId: "81315921281",
  appId: "1:81315921281:web:1be51d4e503addea25bc80"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
