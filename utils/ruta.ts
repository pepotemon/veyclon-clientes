// utils/ruta.ts
import { db } from '../firebase/firebaseConfig';
import {
  collectionGroup,
  getDocs,
  query,
  where,
  writeBatch,
  type DocumentReference,
} from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';

/* ============================================================================
   🔐 STORAGE LOCAL DEL ORDEN POR ADMIN (compatibilidad)
   ============================================================================ */

const STORAGE_PREFIX_LEGACY = 'ruta:';     // compat histórico
const STORAGE_PREFIX_V2      = 'ruta:v2:'; // recomendado (permite namespace)

/** Lee el orden guardado localmente (IDs). Si pasas `ns`, aísla por tenant/entorno. */
export async function loadRutaOrder(admin?: string, ns?: string): Promise<string[]> {
  if (!admin) return [];
  const keyV2 = ns ? `${STORAGE_PREFIX_V2}${ns}:${admin}` : `${STORAGE_PREFIX_V2}${admin}`;
  const keyLegacy = `${STORAGE_PREFIX_LEGACY}${admin}`;

  const readKey = async (k: string) => {
    const raw = await AsyncStorage.getItem(k);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };

  const v2 = await readKey(keyV2);
  if (v2.length) return v2;

  const legacy = await readKey(keyLegacy);
  if (legacy.length) {
    try { await AsyncStorage.setItem(keyV2, JSON.stringify(legacy)); } catch {}
  }
  return legacy;
}

/** Guarda el orden de IDs. Si pasas `ns`, lo aísla por tenant/entorno. */
export async function saveRutaOrder(admin: string | undefined, orderedIds: string[], ns?: string) {
  if (!admin) return;
  const clean = Array.from(new Set(orderedIds.filter(Boolean)));
  const key = ns ? `${STORAGE_PREFIX_V2}${ns}:${admin}` : `${STORAGE_PREFIX_V2}${admin}`;
  await AsyncStorage.setItem(key, JSON.stringify(clean));
}

/**
 * Aplica un orden dado por IDs (orderIds) sobre una colección de items { id }.
 * Los que no estén en orderIds quedan al final (fallback por nombre / tieBreaker).
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
  for (const it of items) (pos.has(it.id) ? inList : notInList).push(it);

  inList.sort((a, b) => (pos.get(a.id)! - pos.get(b.id)!));
  if (tieBreaker) notInList.sort(tieBreaker);
  else notInList.sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'));

  return [...inList, ...notInList];
}

/* ============================================================================
   📦 FIRESTORE (orden oficial **en préstamos** por cliente)
   ============================================================================ */

/**
 * Asegura que los clientes del ADMIN que tienen préstamos ACTIVOS (restante > 0)
 * tengan un `routeOrder` **en todos sus préstamos activos**.
 *
 * - Respeta `routeOrder` existente por cliente (toma el menor de sus préstamos).
 * - Completa sólo los que no tienen, estable (alfabético por “concepto”).
 * - Escribe el MISMO `routeOrder` en todos los préstamos activos del cliente.
 *
 * Opcional: `tenantId`/`rutaId` si esos campos están denormalizados en el préstamo.
 */
export async function ensureRouteOrder(
  admin: string,
  opts?: { tenantId?: string | null; rutaId?: string | null }
) {
  if (!admin) return;

  // 1) Traer préstamos activos del admin
  const qPrest = query(
    collectionGroup(db, 'prestamos'),
    where('creadoPor', '==', admin),
    where('restante', '>', 0)
  );
  const sPrest = await getDocs(qPrest);

  type PrestamoMini = {
    ref: DocumentReference;
    clienteId: string;
    nombre: string;                 // usamos "concepto" como nombre visible
    routeOrder?: number;
    tenantId?: string | null;
    rutaId?: string | null;
  };

  const activos: PrestamoMini[] = [];
  sPrest.forEach((d) => {
    const p: any = d.data();
    const clienteId = String(p?.clienteId || '');
    if (!clienteId) return;

    // filtros opcionales si están denormalizados en el préstamo
    if (opts?.tenantId != null && String(p?.tenantId ?? '') !== String(opts.tenantId ?? '')) return;
    if (opts?.rutaId != null && String(p?.rutaId ?? '') !== String(opts.rutaId ?? '')) return;

    const ro = Number(p?.routeOrder);
    activos.push({
      ref: d.ref,
      clienteId,
      nombre: (p?.concepto || 'Cliente').toString().trim() || 'Cliente',
      routeOrder: Number.isFinite(ro) ? ro : undefined,
      tenantId: p?.tenantId ?? null,
      rutaId: p?.rutaId ?? null,
    });
  });

  if (!activos.length) return;

  // 2) Agrupar por cliente para asignar un único routeOrder por cliente
  const byCliente = new Map<
    string,
    { nombre: string; refs: DocumentReference[]; existing?: number }
  >();

  for (const pr of activos) {
    if (!byCliente.has(pr.clienteId)) {
      byCliente.set(pr.clienteId, {
        nombre: pr.nombre,
        refs: [pr.ref],
        existing: pr.routeOrder,
      });
    } else {
      const g = byCliente.get(pr.clienteId)!;
      g.refs.push(pr.ref);
      // si alguno tiene orden, tomamos el menor
      if (Number.isFinite(pr.routeOrder)) {
        g.existing = Number.isFinite(g.existing) ? Math.min(g.existing!, pr.routeOrder!) : pr.routeOrder!;
      }
    }
  }

  const grupos = Array.from(byCliente.entries()).map(([clienteId, v]) => ({
    clienteId, nombre: v.nombre, refs: v.refs, existing: v.existing,
  }));

  const conOrden = grupos.filter(g => Number.isFinite(g.existing)) as Array<
    typeof grupos[number] & { existing: number }
  >;
  const sinOrden = grupos.filter(g => !Number.isFinite(g.existing));
  const maxOrden = conOrden.length ? Math.max(...conOrden.map(x => x.existing)) : -1;

  if (!sinOrden.length) return; // todo tenía orden

  // 3) Asignar orden estable a los que no tienen (alfabético por nombre)
  sinOrden.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

  // Empezamos después del mayor existente; compactos (0..N) o continuamos (max+1..)
  let next = Math.max(0, maxOrden + 1);

  // 4) Persistir: mismo routeOrder para TODOS los préstamos activos del cliente
  const BATCH_LIMIT = 450;
  const updates: Array<{ refs: DocumentReference[]; order: number }> = [];

  for (const g of sinOrden) {
    updates.push({ refs: g.refs, order: next++ });
  }

  for (let i = 0; i < updates.length; i += BATCH_LIMIT) {
    const slice = updates.slice(i, i + BATCH_LIMIT);
    const batch = writeBatch(db);
    for (const u of slice) {
      for (const ref of u.refs) {
        batch.update(ref, { routeOrder: u.order });
      }
    }
    await batch.commit();
  }
}

/** Utilidad: sort por routeOrder asc, y por nombre como backup (para listas locales) */
export function sortByRouteOrder<T extends { routeOrder?: number; nombre?: string }>(arr: T[]) {
  return [...arr].sort((a, b) => {
    const ra = Number.isFinite(a.routeOrder) ? (a.routeOrder as number) : Number.POSITIVE_INFINITY;
    const rb = Number.isFinite(b.routeOrder) ? (b.routeOrder as number) : Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es');
  });
}

/* ============================================================================
   🔎 Helpers opcionales para listas de UI (sin romper APIs existentes)
   ============================================================================ */

/** Filtra por tenant/ruta en memoria (si tenés estos campos en objetos de UI). */
export function filterClientesByScope<T extends { tenantId?: string | null; rutaId?: string | null }>(
  list: T[],
  opts?: { tenantId?: string | null; rutaId?: string | null }
): T[] {
  if (!opts) return list;
  return list.filter((c) => {
    if (opts.tenantId != null && String(c.tenantId ?? '') !== String(opts.tenantId ?? '')) return false;
    if (opts.rutaId != null && String(c.rutaId ?? '') !== String(opts.rutaId ?? '')) return false;
    return true;
  });
}
