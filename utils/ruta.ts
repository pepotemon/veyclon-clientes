// utils/ruta.ts
import { db } from '../firebase/firebaseConfig';
import {
  collection,
  collectionGroup,
  getDocs,
  query,
  where,
  writeBatch,
  doc,
} from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';

/* ============================================================================
   🔐 STORAGE LOCAL DEL ORDEN POR ADMIN (compatibilidad)
   - Clave: `ruta:<admin>`
   - Guardamos SOLO IDs en orden
   ============================================================================ */

const STORAGE_PREFIX = 'ruta:';

export async function loadRutaOrder(admin?: string): Promise<string[]> {
  if (!admin) return [];
  try {
    const raw = await AsyncStorage.getItem(`${STORAGE_PREFIX}${admin}`);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveRutaOrder(admin: string | undefined, orderedIds: string[]) {
  if (!admin) return;
  const clean = Array.from(new Set(orderedIds.filter(Boolean)));
  await AsyncStorage.setItem(`${STORAGE_PREFIX}${admin}`, JSON.stringify(clean));
}

/**
 * Aplica un orden dado por IDs (orderIds) sobre una colección de items { id }
 * - Los IDs presentes en orderIds se ordenan según su índice.
 * - Los que no estén en orderIds quedan al final.
 * - Fallback: se ordenan alfabéticamente por nombre (o por tieBreaker si lo pasas).
 */
export function applyRutaOrder<T extends { id: string; nombre?: string }>(
  items: T[],
  orderIds: string[],
  tieBreaker?: (a: T, b: T) => number
): T[] {
  if (!items?.length) return [];
  if (!orderIds?.length) {
    const out = [...items];
    out.sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'));
    return out;
  }

  const pos = new Map<string, number>();
  orderIds.forEach((id, idx) => pos.set(id, idx));

  const inList: T[] = [];
  const notInList: T[] = [];
  for (const it of items) {
    (pos.has(it.id) ? inList : notInList).push(it);
  }

  inList.sort((a, b) => (pos.get(a.id)! - pos.get(b.id)!));

  if (tieBreaker) {
    notInList.sort(tieBreaker);
  } else {
    // ✅ Fallback estable: alfabético por nombre
    notInList.sort((a, b) =>
      String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es')
    );
  }

  return [...inList, ...notInList];
}

/* ============================================================================
   📦 FIRESTORE (orden oficial con routeOrder en /clientes)
   ============================================================================ */

/**
 * Asegura que los clientes del ADMIN que tienen préstamos ACTIVOS (restante > 0)
 * tengan un `routeOrder` secuencial.
 * - No toca clientes sin préstamo activo del admin.
 * - Respeta `routeOrder` existente y completa sólo los faltantes,
 *   iniciando desde (max routeOrder existente + 1).
 * - Ordena faltantes alfabéticamente por nombre para asignarles un orden estable.
 */
export async function ensureRouteOrder(admin: string) {
  if (!admin) return;

  // 1) IDs de clientes con PRÉSTAMOS ACTIVOS del admin (restante > 0)
  const qPrest = query(
    collectionGroup(db, 'prestamos'),
    where('creadoPor', '==', admin),
    where('restante', '>', 0)
  );
  const sPrest = await getDocs(qPrest);

  const clienteIdsSet = new Set<string>();
  sPrest.forEach((d) => {
    const p: any = d.data();
    const cid = p?.clienteId;
    if (cid) clienteIdsSet.add(String(cid));
  });

  const clienteIds = Array.from(clienteIdsSet);
  if (clienteIds.length === 0) return;

  // 2) Traer esos clientes en lotes (where '__name__' in [...]) → máx 10 por query
  type ClienteMini = { id: string; nombre: string; routeOrder: number | null };
  const clientes: ClienteMini[] = [];

  for (let i = 0; i < clienteIds.length; i += 10) {
    const batchIds = clienteIds.slice(i, i + 10);
    const qCli = query(
      collection(db, 'clientes'),
      where('__name__', 'in', batchIds as any) // Firestore admite hasta 10
    );
    const sCli = await getDocs(qCli);
    sCli.forEach((docSnap) => {
      const data = docSnap.data() as any;
      const ro = Number(data?.routeOrder);
      clientes.push({
        id: docSnap.id,
        nombre: String(data?.nombre || 'Cliente'),
        routeOrder: Number.isFinite(ro) ? ro : null,
      });
    });
  }

  const conOrden = clientes.filter((c) => c.routeOrder !== null) as Array<
    ClienteMini & { routeOrder: number }
  >;
  const sinOrden = clientes.filter((c) => c.routeOrder === null);

  if (sinOrden.length === 0) return;

  const start = conOrden.length > 0 ? Math.max(...conOrden.map((x) => x.routeOrder)) + 1 : 0;

  // 3) Asignar orden a faltantes por nombre (estable)
  sinOrden.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

  const batch = writeBatch(db);
  sinOrden.forEach((c, i) => {
    batch.update(doc(db, 'clientes', c.id), { routeOrder: start + i });
  });

  await batch.commit();
}

/**
 * Persiste el nuevo orden recibiendo SOLO los IDs en orden.
 * Asigna routeOrder = índice. (Versión Firestore)
 */
export async function persistRouteOrder(orderedIds: string[]) {
  if (!orderedIds?.length) return;
  const batch = writeBatch(db);
  orderedIds.forEach((id, idx) => {
    batch.update(doc(db, 'clientes', id), { routeOrder: idx });
  });
  await batch.commit();
}

/** Utilidad: sort por routeOrder asc, y por nombre como backup */
export function sortByRouteOrder<T extends { routeOrder?: number; nombre?: string }>(arr: T[]) {
  return [...arr].sort((a, b) => {
    const ra = Number.isFinite(a.routeOrder) ? (a.routeOrder as number) : Number.POSITIVE_INFINITY;
    const rb = Number.isFinite(b.routeOrder) ? (b.routeOrder as number) : Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es');
  });
}
