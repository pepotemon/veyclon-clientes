// utils/session.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CommonActions } from '@react-navigation/native';
import { navigationRef } from '../navigation/navigationRef';

const SESSION_KEY = '@veyclon/session';
const ADMIN_KEY   = '@veyclon/admin';

// 🔁 Flag: mostrar Decoy antes de Login tras logout por inactividad (una sola vez)
export const DECOY_FLAG = '@veyclon/decoy:showOnce';

export type SessionData = {
  uid: string;
  email: string;
  tenantId: string | null;
  role: 'collector' | 'admin' | 'superadmin' | null;
  rutaId: string | null;
  nombre?: string | null;
  ciudad?: string | null;
};

export type FullSession = SessionData & { admin: string };

/** Guarda la sesión (admin string + payload sin secretos) */
export async function setSessionUser(admin: string, data: SessionData): Promise<void> {
  // 🧹 Limpieza de claves legadas para evitar inconsistencias
  try { await AsyncStorage.multiRemove(['usuarioSesion', 'usuarioPerfil']); } catch {}

  await AsyncStorage.multiSet([
    [ADMIN_KEY, admin],
    [SESSION_KEY, JSON.stringify({ admin, ...data })],
  ]);

  // 🧷 Compatibilidad legacy (pantallas antiguas que leen `usuarioSesion`)
  try { await AsyncStorage.setItem('usuarioSesion', admin); } catch {}
  // (Opcional) perfíl mínimo para legacy que lo use:
  try { await AsyncStorage.setItem('usuarioPerfil', JSON.stringify({ admin })); } catch {}
}

/** Admin string (con fallback a legacy) */
export async function getSessionUser(): Promise<string | null> {
  const v = await AsyncStorage.getItem(ADMIN_KEY);
  if (v) return v;

  // ⏮️ Fallback legacy
  const legacy = await AsyncStorage.getItem('usuarioSesion');
  return legacy || null;
}

/** Payload completo (admin + tenant/rol/ruta/etc.) */
export async function getFullSession(): Promise<FullSession | null> {
  const raw = await AsyncStorage.getItem(SESSION_KEY);
  if (raw) {
    try { return JSON.parse(raw) as FullSession; } catch {}
  }

  // ⏮️ Fallback legacy: si solo existe `usuarioSesion`, fabricamos un payload mínimo
  const admin = await AsyncStorage.getItem('usuarioSesion');
  if (admin) {
    return {
      admin,
      uid: '',
      email: '',
      tenantId: null,
      role: null,
      rutaId: null,
      nombre: null,
      ciudad: null,
    };
  }

  return null;
}

/** Alias legible (compat) */
export async function getSessionPayload(): Promise<FullSession | null> {
  return getFullSession();
}

/** Limpia toda la sesión local (y claves legadas) */
export async function clearSession(): Promise<void> {
  await AsyncStorage.multiRemove([SESSION_KEY, ADMIN_KEY, 'usuarioSesion', 'usuarioPerfil']);
}

/** Compat */
export async function clearSessionUser(): Promise<void> {
  await clearSession();
}

/**
 * Logout por inactividad:
 * - Marca flag para mostrar Decoy una sola vez.
 * - Limpia sesión.
 * - Resetea navegación a Login (Login leerá el flag y navegará a Decoy).
 */
export async function logoutAndGoToDecoy(reason?: string): Promise<void> {
  try { await AsyncStorage.setItem(DECOY_FLAG, '1'); } catch {}
  try { await clearSession(); } catch {}

  if (navigationRef?.isReady?.()) {
    navigationRef.dispatch(
      CommonActions.reset({ index: 0, routes: [{ name: 'Login' as never }] })
    );
  }
  // opcional: enviar `reason` a telemetría
}

/** Helper para scoping (tenant/rol/ruta) */
export async function getAuthCtx(): Promise<{
  tenantId: string | null;
  role: 'collector' | 'admin' | 'superadmin' | null;
  rutaId: string | null;
} | null> {
  const s = await getFullSession();
  if (!s) return null;
  return {
    tenantId: s.tenantId ?? null,
    role: s.role ?? null,
    rutaId: s.rutaId ?? null,
  };
}
