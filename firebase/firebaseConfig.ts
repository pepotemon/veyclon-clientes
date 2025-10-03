// firebase/firebaseConfig.ts
import { Platform } from 'react-native';
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  initializeFirestore,
  Firestore,
} from 'firebase/firestore';

// ⚠️ Tus credenciales (apiKey no es secreta en Firebase Web)
const firebaseConfig = {
  apiKey: 'AIzaSyAm0ZZWZ0MrGTj0HsgG8LdRLJs-ezv2PLQ',
  authDomain: 'cobrox-43ba7.firebaseapp.com',
  projectId: 'cobrox-43ba7',
  storageBucket: 'cobrox-43ba7.appspot.com',
  messagingSenderId: '665435358844',
  appId: '1:665435358844:web:20ff368ef6cfb8c8b62bf9',
  measurementId: 'G-TP2W5FVB8P',
};

// Evita “Firebase App named '[DEFAULT]' already exists” en dev/HMR
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// Inicializa Firestore con settings seguros en RN/Expo.
// Nota: initializeFirestore solo puede llamarse ANTES de la 1ª obtención.
// Si el app ya existía (HMR), no podemos reconfigurar; usamos getFirestore().
let db: Firestore;
if (getApps().length > 1) {
  // HMR muy agresivo; por si acaso
  db = getFirestore(getApp());
} else if (Platform.OS !== 'web') {
  // React Native: long-polling auto y sin undefined
  db = initializeFirestore(app, {
    ignoreUndefinedProperties: true,
    experimentalAutoDetectLongPolling: true,
    // Si tu red es complicada y aún hay problemas, puedes forzar:
    // experimentalForceLongPolling: true,
    // useFetchStreams: false,
  });
} else {
  // Web
  db = getFirestore(app);
}

export { app, db };
