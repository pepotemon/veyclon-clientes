// utils/syncHelper.ts
import NetInfo from '@react-native-community/netinfo';
import {
  addDoc,
  collection,
  collectionGroup,
  doc,
  runTransaction,
  serverTimestamp,
  updateDoc,
  getDoc,
  getDocs,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../firebase/firebaseConfig';
import { todayInTZ, pickTZ } from '../utils/timezone';
import { logAudit, pick } from '../utils/auditLogs';

import {
  loadOutbox,
  saveOutbox,
  OutboxItem,
  OutboxAbono,
  OutboxNoPago,
  // 👇 Delegamos en el motor nuevo
  processOutboxBatch as obProcessOutboxBatch,
  processOutboxItem as obProcessOutboxItem,
} from './outbox';

// 👇 Cache local tras la descarga
import { saveCatalogSnapshot } from './catalogCache';

/* ========== Legacy (mantener por compat, ya no se usa) ========== */
export const MAX_ATTEMPTS = 5; // ya no se usa aquí, lo maneja outbox.ts
export function computeNextRetry(attempts: number): number {
  const base = Math.min(60 * 60 * 1000, 5000 * Math.pow(2, Math.max(0, attempts - 1)));
  const jitter = Math.floor(base * 0.3 * Math.random());
  return Date.now() + base + jitter;
}

/* ===================== Red ===================== */
async function canSyncNow() {
  try {
    const state = await NetInfo.fetch();
    return !!state.isConnected;
  } catch {
    return true; // si NetInfo falla, intentamos igual
  }
}

/* ===================== Helpers mutación local (legacy) ===================== */
async function updateOutboxItem(
  id: string,
  patch: Partial<Pick<OutboxItem, 'status' | 'lastError' | 'attempts' | 'nextRetryAt'>>
) {
  const list = await loadOutbox();
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const current = list[idx];
  list[idx] = { ...current, ...patch } as OutboxItem;
  await saveOutbox(list);
}

async function removeFromOutbox(id: string) {
  const list = await loadOutbox();
  const filtered = list.filter((x) => x.id !== id);
  await saveOutbox(filtered);
}

/* ===================== Handlers de tipos (legacy) ===================== */
/** ⚠️ Estos handlers eran el mecanismo viejo.
 *  Se conservan por compatibilidad, pero ya **NO** los usamos desde fuera.
 *  El motor nuevo vive en utils/outbox.ts (idempotente + backoff robusto).
 */
async function handleAbono(item: OutboxAbono) {
  const p = item.payload;

  const prestamoRef = doc(db, 'clientes', p.clienteId, 'prestamos', p.prestamoId);
  const abonosCol = collection(prestamoRef, 'abonos');

  const res = await runTransaction(db, async (tx) => {
    const snap = await tx.get(prestamoRef);
    if (!snap.exists()) throw new Error('El préstamo ya no existe');

    const data = snap.data() as any;

    const tz = pickTZ(typeof data?.tz === 'string' ? data.tz : undefined, p.tz);
    const hoy = p.operationalDate || todayInTZ(tz);

    const abono = {
      monto: Number(p.monto.toFixed(2)),
      registradoPor: p.admin,
      tz,
      operationalDate: hoy,
      createdAtMs: Date.now(),
      createdAt: serverTimestamp(),
    };

    const abonoDocRef = doc(abonosCol);
    tx.set(abonoDocRef, abono);

    const restanteActual =
      typeof data.restante === 'number'
        ? data.restante
        : (data.montoTotal || data.totalPrestamo || 0);

    const nuevoRestante = Math.max(0, restanteActual - p.monto);

    const abonoCompact = pick(abono, ['monto', 'operationalDate', 'tz', 'createdAtMs']);
    const nuevosAbonos = Array.isArray(data.abonos)
      ? [...data.abonos, abonoCompact]
      : [abonoCompact];

    tx.update(prestamoRef, { restante: nuevoRestante, abonos: nuevosAbonos });

    return {
      abonoDocRef,
      nuevoRestante,
      tz,
      hoy,
      prestamoBefore: pick(data, [
        'restante',
        'valorCuota',
        'totalPrestamo',
        'clienteId',
        'concepto',
      ]),
    };
  });

  if (p.alsoCajaDiaria) {
    try {
      const ref = await addDoc(collection(db, 'cajaDiaria'), {
        tipo: 'abono',
        admin: p.admin,
        clienteId: p.clienteId,
        prestamoId: p.prestamoId,
        clienteNombre: p.cajaPayload?.clienteNombre || 'Cliente',
        monto: Number(p.monto.toFixed(2)),
        tz: res.tz,
        operationalDate: res.hoy,
        createdAtMs: Date.now(),
        createdAt: serverTimestamp(),
        source: 'outbox',
      });
      await logAudit({
        userId: p.admin,
        action: 'create',
        ref,
        after: {
          tipo: 'abono',
          admin: p.admin,
          clienteId: p.clienteId,
          prestamoId: p.prestamoId,
          monto: Number(p.monto.toFixed(2)),
          operationalDate: res.hoy,
        },
      });
    } catch {
      // best-effort
    }
  }

  try {
    await updateDoc(doc(db, 'clientes', p.clienteId, 'prestamos', p.prestamoId), {
      lastAbonoAt: serverTimestamp(),
    });
  } catch {
    // no crítico
  }

  await logAudit({
    userId: p.admin,
    action: 'create',
    docPath: `clientes/${p.clienteId}/prestamos/${p.prestamoId}/abonos/*(outbox)`,
    after: { monto: Number(p.monto.toFixed(2)), operationalDate: res.hoy },
  });
}

async function handleNoPago(item: OutboxNoPago) {
  const p = item.payload;

  let tz: string | undefined;
  try {
    const prestamoSnap = await getDoc(doc(db, 'clientes', p.clienteId, 'prestamos', p.prestamoId));
    const data = prestamoSnap.data() as any | undefined;
    if (data && typeof data.tz === 'string') tz = data.tz;
  } catch {
    // fallback
  }
  tz = pickTZ(tz);
  const fechaOperacion = todayInTZ(tz);

  const ref = await addDoc(
    collection(db, 'clientes', p.clienteId, 'prestamos', p.prestamoId, 'reportesNoPago'),
    {
      tipo: 'no_pago',
      reason: p.reason,
      fechaOperacion,
      creadoPor: p.admin,
      tz,
      clienteId: p.clienteId,
      prestamoId: p.prestamoId,
      nota: p.nota || '',
      promesaFecha: p.promesaFecha || null,
      promesaMonto: typeof p.promesaMonto === 'number' ? p.promesaMonto : null,
      createdAt: serverTimestamp(),
      source: 'outbox',
    }
  );

  await logAudit({
    userId: p.admin,
    action: 'no_pago',
    ref,
    after: { reason: p.reason, fechaOperacion },
  });
}

/* ===================== LEGACY: procesar uno (ya no se usa externamente) ===================== */
async function processOne(item: OutboxItem) {
  await updateOutboxItem(item.id, { status: 'processing', lastError: undefined });

  try {
    if (item.kind === 'abono') {
      await handleAbono(item as OutboxAbono);
    } else if (item.kind === 'no_pago') {
      await handleNoPago(item as OutboxNoPago);
    } else {
      throw new Error('Tipo no soportado');
    }

    await updateOutboxItem(item.id, { status: 'done' });
    // En el motor nuevo los ítems exitosos se eliminan.
    // Aquí lo dejamos por compat; si quisieras:
    // await removeFromOutbox(item.id);
  } catch (e: any) {
    const attempts = (item.attempts || 0) + 1;
    const done = attempts >= MAX_ATTEMPTS;
    const nextRetryAt = done ? undefined : computeNextRetry(attempts);

    await updateOutboxItem(item.id, {
      status: done ? 'error' : 'pending',
      attempts,
      lastError: String(e?.message || e),
      nextRetryAt,
    });
  }
}

/* ===================== EXPORTS NUEVOS (wrappers al motor real) ===================== */
/** Compat: hay código viejo que importaba processOutboxItem desde aquí */
export async function processOutboxItem(item: OutboxItem): Promise<boolean> {
  // Delegamos al motor nuevo (idempotente)
  return obProcessOutboxItem(item as any);
}

/** Compat: hay código viejo que importaba processOutboxBatch desde aquí */
export async function processOutboxBatch(maxItems = 10): Promise<void> {
  // Mantén el chequeo de red si quieres evitar martillar cuando está offline
  const okNet = await canSyncNow();
  if (!okNet) return;
  await obProcessOutboxBatch(maxItems);
}

/* ===================== Sincronización total ===================== */
// Empuja outbox y refresca clientes + préstamos del admin, guardando cache local.
export async function sincronizarTodo(admin: string): Promise<{
  pushed: number;
  remaining: number;
  pulled: { clientes: number; prestamos: number };
  cacheSaved: boolean;
}> {
  // 1) Empujar hasta 100 pendientes (delegado al motor nuevo)
  const before = await loadOutbox();
  const beforeLen = before.length;

  const okNet = await canSyncNow();
  if (okNet) {
    await obProcessOutboxBatch(100);
  }

  const afterPush = await loadOutbox();
  const remaining = afterPush.length;
  const pushed = Math.max(0, beforeLen - remaining); // ✅ ahora correcto (el motor nuevo borra los OK)

  // 2) Descargar catálogos del admin
  const snapClientes = await getDocs(collection(db, 'clientes'));
  const clientes = snapClientes.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

  const qPrestamos = query(collectionGroup(db, 'prestamos'), where('creadoPor', '==', admin));
  const snapPrestamos = await getDocs(qPrestamos);
  const prestamos = snapPrestamos.docs.map((d) => ({
    id: d.id,
    ...(d.data() as any),
    clienteId: d.ref.parent.parent?.id,
  }));

  // 3) Guardar cache local
  let cacheSaved = false;
  try {
    await saveCatalogSnapshot(admin, { clientes, prestamos });
    cacheSaved = true;
  } catch {
    cacheSaved = false;
  }

  return {
    pushed,
    remaining,
    pulled: { clientes: clientes.length, prestamos: prestamos.length },
    cacheSaved,
  };
}
