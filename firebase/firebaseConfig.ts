// firebase/firebaseConfig.ts
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyAm0ZZWZ0MrGTj0HsgG8LdRLJs-ezv2PLQ',
  authDomain: 'cobrox-43ba7.firebaseapp.com',
  projectId: 'cobrox-43ba7',
  storageBucket: 'cobrox-43ba7.appspot.com',
  messagingSenderId: '665435358844',
  appId: '1:665435358844:web:20ff368ef6cfb8c8b62bf9',
  measurementId: 'G-TP2W5FVB8P',
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export { app, db };
