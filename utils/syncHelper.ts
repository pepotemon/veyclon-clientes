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

// ✅ utilidades locales (rutas corregidas)
import { todayInTZ, pickTZ } from './timezone';
import { logAudit, pick } from './auditLogs';

// ✅ motor NUEVO de outbox (delegamos aquí)
import {
  loadOutbox,
  saveOutbox,
  type OutboxItem,
  type OutboxAbono,
  type OutboxNoPago,
  processOutboxBatch as obProcessOutboxBatch,
  processOutboxItem as obProcessOutboxItem,
} from './outbox';

// ✅ Cálculo de atraso
import { calcularDiasAtraso } from './atrasoHelper';

// (opcional) cache de catálogo
import { saveCatalogSnapshot } from './catalogCache';

/* ========== Legacy (mantener por compat, ya no se usa directamente) ========== */
export const MAX_ATTEMPTS = 5; // (legacy) el motor nuevo usa su propio backoff
export function computeNextRetry(attempts: number): number {
  const base = Math.min(60 * 60 * 1000, 5000 * Math.pow(2, Math.max(0, attempts - 1)));
  const jitter = Math.floor(base * 0.3 * Math.random());
  return Date.now() + base + jitter;
}

/* ===================== Red ===================== */
async function canSyncNow() {
  try {
    const state = await NetInfo.fetch();
    return !!state?.isConnected;
  } catch {
    // si NetInfo falla, intentamos igual
    return true;
  }
}

/* ===================== Mutación local (legacy helpers) ===================== */
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

/* ===================== LEGACY handlers (conservados por compat) ===================== */
/** ⚠️ Mecanismo antiguo (no idempotente). Se conserva por compat pero
 *   NO se usa desde fuera: las llamadas nuevas delegan en utils/outbox.ts
 */
async function handleAbono(item: OutboxAbono) {
  const p = item.payload as any;

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

    // ✅ Protección: nunca dejar 'restante' negativo
    const nuevoRestante = Math.max(0, restanteActual - p.monto);

    const abonoCompact = pick(abono, ['monto', 'operationalDate', 'tz', 'createdAtMs']);
    const nuevosAbonos = Array.isArray(data.abonos)
      ? [...data.abonos, abonoCompact]
      : [abonoCompact];

    tx.update(prestamoRef, { restante: nuevoRestante, abonos: nuevosAbonos });

    return {
      nuevoRestante,
      tz,
      hoy,
    };
  });

  // ✅ Recalcular atraso con datos actualizados (best-effort)
  try {
    // Leer préstamo y abonos reales de la subcolección para el cálculo
    const abonosSnap = await getDocs(collection(prestamoRef, 'abonos'));
    const abonos = abonosSnap.docs.map((docu) => {
      const a = docu.data() as any;
      return {
        monto: Number(a?.monto) || 0,
        operationalDate: a?.operationalDate,
        fecha: a?.fecha, // compat si existiera
      };
    });

    const prestamoSnap = await getDoc(prestamoRef);
    if (prestamoSnap.exists()) {
      const d = prestamoSnap.data() as any;
      const tzDoc = pickTZ(d?.tz);
      const hoy = d?.operationalDate || todayInTZ(tzDoc);
      const diasHabiles = Array.isArray(d?.diasHabiles) && d.diasHabiles.length ? d.diasHabiles : [1, 2, 3, 4, 5, 6];
      const feriados = Array.isArray(d?.feriados) ? d.feriados : [];
      const pausas = Array.isArray(d?.pausas) ? d.pausas : [];
      const modo = (d?.modoAtraso as 'porPresencia' | 'porCuota') ?? 'porPresencia';
      const permitirAdelantar = !!d?.permitirAdelantar;
      const cuotas =
        Number(d?.cuotas || 0) ||
        Math.ceil(Number(d?.totalPrestamo || d?.montoTotal || 0) / (Number(d?.valorCuota) || 1));

      const calc = calcularDiasAtraso({
        fechaInicio: d?.fechaInicio || hoy,
        hoy,
        cuotas,
        valorCuota: Number(d?.valorCuota || 0),
        abonos,
        diasHabiles,
        feriados,
        pausas,
        modo,
        permitirAdelantar,
      });

      await updateDoc(prestamoRef, {
        diasAtraso: calc.atraso,
        faltas: calc.faltas || [],
        ultimaReconciliacion: serverTimestamp(),
        restante: Math.max(0, Number(res.nuevoRestante || 0)),
      });
    }
  } catch {
    // tolerante a fallos de recálculo
  }

  if (p.alsoCajaDiaria) {
    try {
      const ref = await addDoc(collection(db, 'cajaDiaria'), {
        tipo: 'abono' as const,
        admin: p.admin,
        clienteId: p.clienteId,
        prestamoId: p.prestamoId,
        clienteNombre: p.cajaPayload?.clienteNombre || p.clienteNombre || 'Cliente',
        monto: Number(p.monto.toFixed(2)),
        tz: res.tz,
        operationalDate: res.hoy,
        createdAtMs: Date.now(),
        createdAt: serverTimestamp(),
        source: 'outbox',
        // 👇 importante para que CajaDiariaScreen (que filtra por scope) los vea
        tenantId: p.tenantId ?? null,
        rutaId: p.rutaId ?? null,
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
          tenantId: p.tenantId ?? null,
          rutaId: p.rutaId ?? null,
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
  const p = item.payload as any;

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
      // 👇 mantener consistencia de scope en no-pagos
      tenantId: p.tenantId ?? null,
      rutaId: p.rutaId ?? null,
    }
  );

  await logAudit({
    userId: p.admin,
    action: 'no_pago',
    ref,
    after: { reason: p.reason, fechaOperacion, tenantId: p.tenantId ?? null, rutaId: p.rutaId ?? null },
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
    // En el motor nuevo los OK se eliminan. Aquí mantenemos compat:
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
/** Compat: había código que importaba processOutboxItem desde aquí */
export async function processOutboxItem(item: OutboxItem): Promise<boolean> {
  return obProcessOutboxItem(item as any);
}

/** Compat: había código que importaba processOutboxBatch desde aquí */
export async function processOutboxBatch(maxItems = 10): Promise<void> {
  const okNet = await canSyncNow();
  if (!okNet) return;
  await obProcessOutboxBatch(maxItems);
}

/* ===================== Sincronización total ===================== */
/**
 * Empuja outbox y refresca clientes + préstamos del admin, guardando cache local.
 * Puedes pasar filtros opcionales para aislar por tenant/ruta en memoria.
 */
export async function sincronizarTodo(
  admin: string,
  opts?: { tenantId?: string | null; rutaId?: string | null }
): Promise<{
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
  const pushed = Math.max(0, beforeLen - remaining);

  // 2) Descargar catálogos
  const snapClientes = await getDocs(collection(db, 'clientes'));
  let clientes = snapClientes.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

  // (Opcional) filtrar por tenant/ruta en memoria para evitar “fugas” de sesión
  if (opts?.tenantId != null) {
    const tid = String(opts.tenantId ?? '');
    clientes = clientes.filter((c) => String(c?.tenantId ?? '') === tid);
  }
  if (opts?.rutaId != null) {
    const rid = String(opts.rutaId ?? '');
    clientes = clientes.filter((c) => String(c?.rutaId ?? '') === rid);
  }

  const qPrestamos = query(collectionGroup(db, 'prestamos'), where('creadoPor', '==', admin));
  const snapPrestamos = await getDocs(qPrestamos);
  let prestamos = snapPrestamos.docs.map((d) => ({
    id: d.id,
    ...(d.data() as any),
    clienteId: d.ref.parent.parent?.id,
  }));

  // (Opcional) si quieres también filtrar préstamos por scope, usa los ids válidos:
  if (opts?.tenantId != null || opts?.rutaId != null) {
    const validIds = new Set(clientes.map((c) => c.id));
    prestamos = prestamos.filter((p) => validIds.has(String(p.clienteId || '')));
  }

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
