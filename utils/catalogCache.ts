// utils/catalogCache.ts
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = (admin: string) => `cache:catalog:${admin}`;

export type CatalogSnapshot = {
  ts: number; // Date.now()
  clientes: Array<any>;
  prestamos: Array<any>;
};

export async function saveCatalogSnapshot(admin: string, data: Omit<CatalogSnapshot, 'ts'>) {
  const payload: CatalogSnapshot = { ts: Date.now(), ...data };
  try {
    await AsyncStorage.setItem(KEY(admin), JSON.stringify(payload));
  } catch (e) {
    // opcional: console.warn('[cache] saveCatalogSnapshot error', e);
  }
}

export async function loadCatalogSnapshot(admin: string): Promise<CatalogSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY(admin));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.clientes || !parsed?.prestamos) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearCatalogSnapshot(admin: string) {
  try { await AsyncStorage.removeItem(KEY(admin)); } catch {}
}
