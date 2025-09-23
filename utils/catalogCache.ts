// utils/catalogCache.ts
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = (admin: string) => `cache:catalog:${admin}`;
const VERSION = 1; // ← súbelo si cambias el shape

export type CatalogSnapshot = {
  ts: number;         // Date.now()
  version: number;    // ← nuevo
  clientes: Array<any>;
  prestamos: Array<any>;
};

export async function saveCatalogSnapshot(
  admin: string,
  data: Omit<CatalogSnapshot, 'ts' | 'version'>
) {
  const payload: CatalogSnapshot = { ts: Date.now(), version: VERSION, ...data };
  try {
    await AsyncStorage.setItem(KEY(admin), JSON.stringify(payload));
  } catch {}
}

export async function loadCatalogSnapshot(
  admin: string,
  opts?: { maxAgeMs?: number } // ← TTL opcional
): Promise<CatalogSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY(admin));
    if (!raw) return null;
    const parsed: CatalogSnapshot = JSON.parse(raw);

    if (!parsed?.clientes || !parsed?.prestamos) return null;
    if (typeof parsed.version !== 'number' || parsed.version !== VERSION) return null;

    if (opts?.maxAgeMs && typeof parsed.ts === 'number') {
      const age = Date.now() - parsed.ts;
      if (age > opts.maxAgeMs) return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export async function clearCatalogSnapshot(admin: string) {
  try { await AsyncStorage.removeItem(KEY(admin)); } catch {}
}
