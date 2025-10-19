// firebase/firebaseConfig.ts
import { Platform } from 'react-native';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  getFirestore,
  initializeFirestore,
  type Firestore,
} from 'firebase/firestore';

// ⚠️ Credenciales Web (apiKey no es secreta en proyectos Firebase Web)
const firebaseConfig = {
  apiKey: 'AIzaSyAm0ZZWZ0MrGTj0HsgG8LdRLJs-ezv2PLQ',
  authDomain: 'cobrox-43ba7.firebaseapp.com',
  projectId: 'cobrox-43ba7',
  storageBucket: 'cobrox-43ba7.appspot.com',
  messagingSenderId: '665435358844',
  appId: '1:665435358844:web:20ff368ef6cfb8c8b62bf9',
  measurementId: 'G-TP2W5FVB8P',
};

// Evita “Firebase App named '[DEFAULT]' already exists” con HMR
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// ---------- Auth ----------
// Usamos getAuth (sin persistencia RN explícita) para evitar errores de tipos.
// Si en el futuro actualizas el SDK y quieres persistencia en RN:
//   import { initializeAuth, getReactNativePersistence } from 'firebase/auth'
//   import AsyncStorage from '@react-native-async-storage/async-storage'
//   const auth = initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) })
const auth = getAuth(app);

// ---------- Firestore ----------
let db: Firestore;

if (Platform.OS !== 'web') {
  // En RN usar long-polling ayuda en redes móviles / emuladores
  try {
    db = initializeFirestore(app, {
      ignoreUndefinedProperties: true,
      experimentalAutoDetectLongPolling: true,
      // experimentalForceLongPolling: true, // <- si tu red es muy restrictiva, puedes descomentar esta línea
    });
  } catch {
    // Si ya fue inicializado (HMR), cae aquí
    db = getFirestore(app);
  }
} else {
  db = getFirestore(app);
}

export { app, auth, db };
