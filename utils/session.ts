// utils/session.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CommonActions } from '@react-navigation/native';

export const SESSION_USER_KEY = 'usuarioSesion';      // string del usuario / id
export const SESSION_PROFILE_KEY = 'usuarioPerfil';   // opcional: cache del perfil sin campos sensibles

export async function setSessionUser(usernameOrId: string, profile?: any) {
  await AsyncStorage.setItem(SESSION_USER_KEY, String(usernameOrId));
  if (profile) {
    // Nunca guardes password ni hashes en el perfil local
    const { password, pass, hash, ...safe } = profile || {};
    await AsyncStorage.setItem(SESSION_PROFILE_KEY, JSON.stringify(safe));
  }
}

export async function getSessionUser(): Promise<string | null> {
  try {
    return (await AsyncStorage.getItem(SESSION_USER_KEY)) || null;
  } catch {
    return null;
  }
}

export async function getSessionProfile(): Promise<any | null> {
  try {
    const raw = await AsyncStorage.getItem(SESSION_PROFILE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function clearSession() {
  await AsyncStorage.multiRemove([SESSION_USER_KEY, SESSION_PROFILE_KEY]);
}

/**
 * Helper central: cierra sesión y resetea el stack a la pantalla señuelo.
 * Úsalo en Ajustes (Salir) y en cualquier otro lugar donde quieras “salir del todo”.
 */
export async function logoutAndGoToDecoy(navigation: any) {
  try {
    await clearSession();
  } finally {
    navigation.dispatch(
      CommonActions.reset({
        index: 0,
        routes: [{ name: 'DecoyRetro' as never }],
      })
    );
  }
}
