// firebase/firebaseConfig.ts
import { Platform } from 'react-native';
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  initializeAuth,
  inMemoryPersistence,
  type Auth,
} from 'firebase/auth';
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

// ---------- Auth (SIN persistencia al cerrar la app) ----------
let auth: Auth;
try {
  // En React Native usamos persistencia EN MEMORIA para que
  // al cerrar la app la sesión NO quede guardada.
  auth = initializeAuth(app, {
    persistence: inMemoryPersistence,
  });
} catch {
  // Si ya fue inicializado (por HMR), obtenlo
  auth = getAuth(app);
}

// ---------- Firestore ----------
let db: Firestore;

if (Platform.OS !== 'web') {
  // En RN usar long-polling ayuda en redes móviles / emuladores
  try {
    db = initializeFirestore(app, {
      ignoreUndefinedProperties: true,
      experimentalAutoDetectLongPolling: true,
      // experimentalForceLongPolling: true, // <- si tu red es muy restrictiva, habilítalo
    });
  } catch {
    // Si ya fue inicializado (HMR), cae aquí
    db = getFirestore(app);
  }
} else {
  db = getFirestore(app);
}

export { app, auth, db };
