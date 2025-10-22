/* Outbox (refactor P1)
   - Contador de pendientes 100% **event-driven** (sin polling).
   - Emisión **acelerada** (throttle 150ms) para evitar cascadas de renders.
   - Mirror en memoria para lecturas rápidas (sin JSON.stringify ni re-parses).
   - API compatible: subscribeCount(cb) sigue existiendo y devuelve unsubscribe().
*/

import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';

import { db } from '../firebase/firebaseConfig';
import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  getDoc,
} from 'firebase/firestore';
import { logAudit, pick } from './auditLogs';
import { pickTZ, todayInTZ } from './timezone';
import { addMovimientoIdempotente } from './caja';

export const STORAGE_KEY = 'outbox:pending';

export type OutboxStatus = 'pending' | 'processing' | 'done' | 'error';

export type ReasonNoPago =
  | 'no_contesto'
  | 'no_en_casa'
  | 'promesa'
  | 'dinero'
  | 'enfermedad'
  | 'viaje'
  | 'se_mudo'
  | 'otro';

export type AbonoPayload = {
  admin: string;
  clienteId: string;
  prestamoId: string;
  monto: number;
  tz: string;
  operationalDate: string;

  /** UI/Informes */
  clienteNombre?: string;

  /** CajaDiaria (legacy, ya no se usa porque lo hace la CF) */
  alsoCajaDiaria?: boolean;
  cajaPayload?: {
    tipo: 'abono';
    clienteNombre?: string;
    tenantId?: string | null;
    rutaId?: string | null;
  };

  /** Metadatos */
  source?: 'app' | 'outbox' | string;
  tenantId?: string | null;
  rutaId?: string | null;

  createdAtMs?: number; // opcional
};

export type VentaCajaPayload = {
  tipo: 'prestamo';
  admin: string;
  clienteId: string;
  prestamoId?: string;
  clienteNombre?: string;
  monto: number;
  tz: string;
  operationalDate: string;
  meta?: Record<string, any>;
  tenantId?: string | null;
  rutaId?: string | null;
};

export type VentaPayload = {
  admin: string;
  clienteId: string;
  clienteNombre?: string;

  // Campos del préstamo
  valorCuota: number;
  cuotas: number;
  totalPrestamo?: number;
  montoTotal?: number;
  fechaInicio: string;       // YYYY-MM-DD
  tz: string;
  operationalDate: string;

  /** Monto que sale de caja al crear el préstamo (lo registrará CF) */
  retiroCaja: number;

  meta?: Record<string, any>;

  source?: 'app' | 'outbox' | string;
  tenantId?: string | null;
  rutaId?: string | null;

  alsoCajaDiaria?: boolean;  // ignorado (CF hace caja)
  cajaPayload?: VentaCajaPayload; // ignorado (CF hace caja)
};

export type NoPagoPayload = {
  admin: string;
  clienteId: string;
  prestamoId: string;
  reason: ReasonNoPago;
  nota?: string;
  promesaFecha?: string; // YYYY-MM-DD
  promesaMonto?: number;
  createdAtMs?: number;
};

/** ✅ Movimiento genérico offline (no asociado a un préstamo específico) */
export type MovSubkind = 'ingreso' | 'retiro' | 'gasto_admin' | 'gasto_cobrador';
export type MovPayload = {
  admin: string;
  subkind: MovSubkind;
  monto: number;
  operationalDate: string; // YYYY-MM-DD
  tz: string;
  nota?: string | null;
  categoria?: string;

  clienteId?: string;
  prestamoId?: string;
  clienteNombre?: string;

  meta?: Record<string, any>;
};

type OutboxBase = {
  id: string;
  createdAtMs: number;
  attempts: number;
  status: OutboxStatus;
  lastError?: string;
  nextRetryAt?: number;
};

export type OutboxAbono = OutboxBase & { kind: 'abono'; payload: AbonoPayload };
export type OutboxVenta = OutboxBase & { kind: 'venta'; payload: VentaPayload };
export type OutboxNoPago = OutboxBase & { kind: 'no_pago'; payload: NoPagoPayload };
export type OutboxMov = OutboxBase & { kind: 'mov'; payload: MovPayload };
export type OutboxOtro = OutboxBase & { kind: 'otro'; payload: any };

export type OutboxItem = OutboxAbono | OutboxVenta | OutboxNoPago | OutboxMov | OutboxOtro;

// 👇 Tipos expuestos para el hook de badge/contadores
export type OutboxKind = 'abono' | 'venta' | 'no_pago' | 'mov' | 'otro';
export type OutboxStatusCounts = {
  totalPending: number;
  byKind: Record<OutboxKind, number>;
};

/* ============ Event Emitter para UI (badge, etc.) ============ */
type Listener = () => void;
const listeners = new Set<Listener>();

// 🔄 Mirror en memoria (evita JSON.parse repetidos)
let memoryOutbox: OutboxItem[] | null = null;

// ⏱️ Emisión acelerada para evitar cascadas de renders
const NOTIFY_THROTTLE_MS = 150;
let notifyTimer: any = null;
function notifyOutboxChangedThrottled() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const l of listeners) {
      try { l(); } catch {}
    }
  }, NOTIFY_THROTTLE_MS);
}

export function subscribeOutbox(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitOutboxChanged() {
  notifyOutboxChangedThrottled();
}

/* 🔔 Evento global para que Home/Pagos recarguen al terminar un envío */
export const OUTBOX_FLUSHED = 'outbox:flushed';
export function emitOutboxFlushed() {
  try { DeviceEventEmitter.emit(OUTBOX_FLUSHED); } catch {}
}

/* ============ Storage helpers ============ */
export async function loadOutbox(): Promise<OutboxItem[]> {
  if (memoryOutbox) return memoryOutbox;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: any[] = raw ? JSON.parse(raw) : [];
    memoryOutbox = Array.isArray(parsed) ? (parsed as OutboxItem[]) : [];
    return memoryOutbox;
  } catch {
    memoryOutbox = [];
    return memoryOutbox;
  }
}

export async function saveOutbox(list: OutboxItem[]): Promise<void> {
  memoryOutbox = list;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } finally {
    emitOutboxChanged();
  }
}

// (alias) lectura directa (usa mirror si ya está cargado)
export async function listOutbox(): Promise<OutboxItem[]> {
  return loadOutbox();
}

/* ============ Contadores para badge ============ */
export async function getOutboxCounts(): Promise<OutboxStatusCounts> {
  const list = await loadOutbox();
  const pending = list.filter((x) => (x.status ?? 'pending') !== 'done');
  const byKind: Record<OutboxKind, number> = {
    abono: 0, venta: 0, no_pago: 0, mov: 0, otro: 0,
  };
  for (const it of pending) {
    const k = it.kind as OutboxKind;
    if (byKind[k] != null) byKind[k] += 1;
    else byKind.otro += 1;
  }
  return { totalPending: pending.length, byKind };
}

/* ============ Helper duplicados ============ */
function hasBlockingAbonoForCliente(list: OutboxItem[], clienteId: string): boolean {
  return list.some(
    (x) =>
      x.kind === 'abono' &&
      ((x.status ?? 'pending') === 'pending' ||
        (x.status ?? 'pending') === 'processing' ||
        (x.status ?? 'pending') === 'error') &&
      (x as OutboxAbono).payload?.clienteId === clienteId
  );
}

/* ============ Add helper: unión discriminada (sin overloads) ============ */

export type AddToOutboxParams =
  | { kind: 'abono'; payload: AbonoPayload }
  | { kind: 'venta'; payload: VentaPayload }
  | { kind: 'no_pago'; payload: NoPagoPayload }
  | { kind: 'mov'; payload: MovPayload }
  | { kind: 'otro'; payload: any };

export async function addToOutbox(params: AddToOutboxParams): Promise<void> {
  const base: OutboxBase = {
    id: genLocalId(),
    createdAtMs: Date.now(),
    attempts: 0,
    status: 'pending',
  };

  let full: OutboxItem;

  if (params.kind === 'abono') {
    const clienteId = params.payload?.clienteId;
    if (!clienteId) throw new Error('Falta clienteId en el payload de abono.');
    const current = await loadOutbox();
    if (hasBlockingAbonoForCliente(current, clienteId)) {
      throw new Error('Este cliente ya tiene un pago pendiente sin enviar.');
    }

    const clienteNombreNorm =
      params.payload?.clienteNombre ?? params.payload?.cajaPayload?.clienteNombre ?? undefined;

    full = {
      ...base,
      kind: 'abono',
      payload: { ...params.payload, clienteNombre: clienteNombreNorm },
    };
    const list = await loadOutbox();
    list.push(full);
    await saveOutbox(list);

  } else if (params.kind === 'venta') {
    const p = params.payload;
    const clienteNombreNorm = p?.clienteNombre ?? undefined;
    // (cajaPayload ignorado; CF hace caja)
    full = {
      ...base,
      kind: 'venta',
      payload: { ...p, clienteNombre: clienteNombreNorm },
    };
    const list = await loadOutbox();
    list.push(full);
    await saveOutbox(list);

  } else if (params.kind === 'no_pago') {
    full = { ...base, kind: 'no_pago', payload: { ...params.payload } };
    const list = await loadOutbox();
    list.push(full);
    await saveOutbox(list);

  } else if (params.kind === 'mov') {
    const sk = params.payload.subkind;
    if (!['ingreso', 'retiro', 'gasto_admin', 'gasto_cobrador'].includes(sk)) {
      throw new Error(`Movimiento subkind inválido: ${sk}`);
    }
    full = { ...base, kind: 'mov', payload: { ...params.payload } };
    const list = await loadOutbox();
    list.push(full);
    await saveOutbox(list);

  } else {
    full = { ...base, kind: 'otro', payload: params.payload };
    const list = await loadOutbox();
    list.push(full);
    await saveOutbox(list);
  }

  try {
    await logAudit({
      userId: (full as any)?.payload?.admin ?? 'unknown',
      action: 'outbox_enqueue',
      docPath: `outbox/local/${full.id}`,
      after: pick(full, ['id', 'createdAtMs', 'attempts']),
    });
  } catch {}

  scheduleDebouncedFlush();
}

/* ============ Utilidades varias ============ */

export function genLocalId(): string {
  return 'loc_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Suscripción **event-driven** al conteo de items (sin polling).
 */
export function subscribeCount(cb: (n: number) => void): () => void {
  let alive = true;
  const fire = async () => {
    if (!alive) return;
    const list = await listOutbox();
    cb(list.length);
  };
  const unsubscribe = subscribeOutbox(() => { fire().catch(() => {}); });
  fire().catch(() => {});
  return () => { alive = false; unsubscribe(); };
}

/* ============ Reenvío real (implementación) ============ */

/** Abono → SOLO crear subdoc permitido por reglas; CF hace el resto. */
async function reenviarAbono(item: OutboxAbono): Promise<void> {
  const p = item.payload;
  const { admin, clienteId, prestamoId, monto, tz, operationalDate } = p;
  if (!admin || !clienteId || !prestamoId || !Number.isFinite(monto)) {
    throw new Error('Payload de abono incompleto');
  }

  const abonosCol = collection(doc(db, 'clientes', clienteId, 'prestamos', prestamoId), 'abonos');
  const abonoDocId = `ox_${item.id}`; // idempotente
  const abonoRef = doc(abonosCol, abonoDocId);

  // ⚠️ SOLO claves permitidas por isValidAbonoCreate()
  const payload = {
    monto: Number(monto),
    registradoPor: admin,
    tz,
    operationalDate,                   // YYYY-MM-DD
    createdAtMs: Date.now(),
    createdAt: serverTimestamp(),
    source: 'outbox',
    tenantId: p.tenantId ?? null,
    rutaId: p.rutaId ?? null,
  };

  await runTransaction(db, async (tx) => {
    const existing = await tx.get(abonoRef);
    if (existing.exists()) return;     // idempotencia
    tx.set(abonoRef, payload);
  });

  await logAudit({
    userId: admin,
    action: 'abono_outbox',
    docPath: abonoRef.path,
    after: pick(payload, [
      'monto','registradoPor','tz','operationalDate','createdAtMs','source','tenantId','rutaId'
    ]),
  });
}

/** Venta → crear préstamo idempotente; CF onPrestamoCreated hará cajaDiaria/loan_* */
async function reenviarVenta(item: OutboxVenta): Promise<void> {
  const p = item.payload;
  const {
    admin, clienteId, clienteNombre, valorCuota, cuotas,
    totalPrestamo, montoTotal, fechaInicio, tz, operationalDate, meta,
    tenantId, rutaId
  } = p;

  if (!admin || !clienteId || !Number.isFinite(valorCuota) || !Number.isFinite(cuotas) || !fechaInicio) {
    throw new Error('Payload de venta incompleto');
  }

  const total = Number(
    (typeof totalPrestamo === 'number' ? totalPrestamo : undefined) ??
    (typeof montoTotal === 'number' ? montoTotal : undefined) ??
    valorCuota * cuotas
  );

  const prestamoRef = doc(collection(doc(db, 'clientes', clienteId), 'prestamos'), `ox_${item.id}`);

  const created = await runTransaction(db, async (tx) => {
    const exists = await tx.get(prestamoRef);
    if (exists.exists()) return false as const;

    const payloadPrestamo: any = {
      creadoPor: admin,
      creadoEn: serverTimestamp(),
      createdAtMs: Date.now(),
      createdDate: operationalDate,              // CF lo usa para cajaDiaria
      clienteId,
      clienteNombre: (clienteNombre || '').trim() || 'Sin nombre',
      concepto: (clienteNombre || '').trim() || 'Sin nombre',
      valorCuota: Number(valorCuota),
      cuotas: Number(cuotas),
      cuotasTotales: Number(cuotas),
      cuotasPagadas: 0,
      totalPrestamo: Number(total),
      montoTotal: Number(total),
      restante: Number(total),
      fechaInicio,
      tz,
      diasHabiles: [1,2,3,4,5,6],
      feriados: [],
      pausas: [],
      proximoVencimiento: fechaInicio,
      dueToday: false,
      status: 'activo',
      tenantId: tenantId ?? null,
      rutaId: rutaId ?? null,
      ...(meta || {}),
    };

    tx.set(prestamoRef, payloadPrestamo);
    return true as const;
  });

  if (!created) return;

  await logAudit({
    userId: admin,
    action: 'venta_outbox',
    docPath: prestamoRef.path,
    after: {
      admin, clienteId, clienteNombre,
      valorCuota: Number(valorCuota),
      cuotas: Number(cuotas),
      totalPrestamo: Number(total),
      operationalDate, tz,
    },
  });
}

/** No-pago → idempotente con docId determinístico: reportesNoPago/ox_<outboxId> */
async function reenviarNoPago(item: OutboxNoPago): Promise<void> {
  const p = item.payload;
  const { admin, clienteId, prestamoId, reason, nota, promesaFecha, promesaMonto } = p;

  if (!admin || !clienteId || !prestamoId || !reason) {
    throw new Error('Payload de no_pago incompleto');
  }

  const prestamoRef = doc(db, 'clientes', clienteId, 'prestamos', prestamoId);
  const snap = await getDoc(prestamoRef);
  if (!snap.exists()) throw new Error('Préstamo no existe (no_pago)');

  const data = snap.data() as any;
  const tzPrestamo = pickTZ(data?.tz, 'America/Sao_Paulo');
  const fechaOperacion = todayInTZ(tzPrestamo);

  const col = collection(prestamoRef, 'reportesNoPago');
  const noPagoDocId = `ox_${item.id}`;
  const noPagoRef = doc(col, noPagoDocId);

  const base: any = {
    tipo: 'no_pago',
    reason,
    fechaOperacion,
    creadoPor: admin,
    tz: tzPrestamo,
    clienteId,
    prestamoId,
    clienteNombre: (data?.concepto ?? '').trim() || 'Sin nombre',
    valorCuota: Number(data?.valorCuota || 0),
    saldo: Number(data?.restante || 0),
    createdAt: serverTimestamp(),
    fromOutboxId: item.id,
    source: 'outbox',
  };
  if (nota && nota.trim()) base.nota = nota.trim();
  if (promesaFecha && promesaFecha.trim()) base.promesaFecha = promesaFecha.trim();
  if (typeof promesaMonto === 'number' && isFinite(promesaMonto)) base.promesaMonto = promesaMonto;

  const created = await runTransaction(db, async (tx) => {
    const existing = await tx.get(noPagoRef);
    if (existing.exists()) return false as const;
    tx.set(noPagoRef, base);
    return true as const;
  });

  if (!created) return;

  await logAudit({
    userId: admin,
    action: 'no_pago_outbox',
    docPath: noPagoRef.path,
    after: pick(
      base,
      [
        'tipo',
        'reason',
        'fechaOperacion',
        'clienteId',
        'prestamoId',
        'valorCuota',
        'saldo',
        'promesaFecha',
        'promesaMonto',
        'nota',
        'fromOutboxId',
      ]
    ),
  });
}

/** ✅ Mov genérico → usar addMovimientoIdempotente con id 'oxmov_<subkind>_<outboxId>' */
async function reenviarMov(item: OutboxMov): Promise<void> {
  const p = item.payload;
  const {
    admin,
    subkind,
    monto,
    operationalDate,
    tz,
    nota,
    categoria,
    clienteId,
    prestamoId,
    clienteNombre,
    meta,
  } = p;

  if (!admin || !subkind || !Number.isFinite(monto) || !operationalDate || !tz) {
    throw new Error('Payload de movimiento incompleto');
  }
  if (!['ingreso', 'retiro', 'gasto_admin', 'gasto_cobrador'].includes(subkind)) {
    throw new Error(`Movimiento subkind inválido: ${subkind}`);
  }

  const docId = `oxmov_${subkind}_${item.id}`;

  await addMovimientoIdempotente(
    admin,
    {
      tipo: subkind as any,
      admin,
      monto: Number(monto),
      operationalDate,
      tz,
      nota: (nota ?? null) || null,
      categoria: subkind === 'gasto_admin' ? (categoria || undefined) : undefined,
      clienteId: clienteId || undefined,
      prestamoId: prestamoId || undefined,
      clienteNombre: clienteNombre || undefined,
      meta: {
        ...(meta || {}),
        fromOutboxId: item.id,
        _kind: 'mov',
        _subkind: subkind,
        ...(clienteId ? { clienteId } : {}),
        ...(prestamoId ? { prestamoId } : {}),
        ...(clienteNombre ? { clienteNombre } : {}),
      },
    } as any,
    docId
  );

  await logAudit({
    userId: admin,
    action: 'mov_outbox',
    docPath: `cajaDiaria/${docId}`,
    after: pick(
      {
        tipo: subkind,
        admin,
        monto: Number(monto),
        operationalDate,
        tz,
        nota: (nota ?? null) || null,
        categoria: subkind === 'gasto_admin' ? (categoria || undefined) : undefined,
        clienteId,
        prestamoId,
        clienteNombre,
        fromOutboxId: item.id,
      },
      [
        'tipo',
        'admin',
        'monto',
        'operationalDate',
        'tz',
        'nota',
        'categoria',
        'clienteId',
        'prestamoId',
        'clienteNombre',
        'fromOutboxId',
      ]
    ),
  });
}

/* ============ (expuesto) ============ */
// Debe lanzar error si falla; true si ok.
export async function processOutboxItem(item: OutboxItem): Promise<boolean> {
  if (item.kind === 'abono') {
    await reenviarAbono(item as OutboxAbono);
    return true;
  }
  if (item.kind === 'venta') {
    await reenviarVenta(item as OutboxVenta);
    return true;
  }
  if (item.kind === 'no_pago') {
    await reenviarNoPago(item as OutboxNoPago);
    return true;
  }
  if (item.kind === 'mov') {
    await reenviarMov(item as OutboxMov);
    return true;
  }
  return true;
}

/* ============ Motor de procesamiento con backoff + límites ============ */

// Backoff exponencial: 1s → 2s → 4s → 8s → 16s → 32s → 60s (tope)
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const MAX_ATTEMPTS = 8;

function computeNextBackoff(attempts: number): number {
  const exp = Math.max(0, attempts - 1);
  const ms = BACKOFF_BASE_MS * Math.pow(2, exp);
  return Math.min(BACKOFF_MAX_MS, ms);
}

async function markProcessing(list: OutboxItem[], ids: Set<string>): Promise<OutboxItem[]> {
  const next: OutboxItem[] = list.map((it): OutboxItem =>
    ids.has(it.id) ? { ...it, status: 'processing', lastError: undefined } : it
  );
  await saveOutbox(next);
  return next;
}

async function applyResult(
  list: OutboxItem[],
  id: string,
  result: { ok: true } | { ok: false; errorMsg?: string }
): Promise<OutboxItem[]> {
  if (result.ok) {
    const filtered: OutboxItem[] = list.filter((x) => x.id !== id);
    await saveOutbox(filtered);
    emitOutboxFlushed();
    return filtered;
  }
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) return list;
  const curr = list[idx];
  const attempts = (curr.attempts ?? 0) + 1;

  let updated: OutboxItem;
  if (attempts >= MAX_ATTEMPTS) {
    updated = { ...curr, attempts, status: 'error', lastError: result.errorMsg || 'Fallo al reenviar (límite de intentos)', nextRetryAt: undefined };
  } else {
    const backoff = computeNextBackoff(attempts);
    updated = { ...curr, attempts, status: 'error', lastError: result.errorMsg || 'Fallo al reenviar', nextRetryAt: Date.now() + backoff };
  }

  const next: OutboxItem[] = [...list];
  next[idx] = updated;
  await saveOutbox(next);
  return next;
}

async function safeProcessOne(item: OutboxItem): Promise<{ ok: true } | { ok: false; errorMsg?: string }> {
  try {
    const ok = await processOutboxItem(item);
    return ok ? { ok: true } : { ok: false, errorMsg: 'Procesador devolvió false' };
  } catch (e: any) {
    const msg = (e && (e.message || e.code || String(e))) || 'Error desconocido';
    return { ok: false, errorMsg: msg };
  }
}

/** Procesa hasta `maxItems` listos (pending/error cuyo nextRetryAt venció). */
export async function processOutboxBatch(maxItems: number): Promise<void> {
  const all = await loadOutbox();
  if (!all.length || maxItems <= 0) return;

  const now = Date.now();
  const ready = all.filter(
    (it) =>
      (it.status === 'pending' || it.status === 'error') &&
      (it.nextRetryAt == null || it.nextRetryAt <= now)
  );

  const toRun = ready.slice(0, Math.max(0, maxItems));
  if (!toRun.length) return;

  const ids = new Set(toRun.map((x) => x.id));
  let state = await markProcessing(all, ids);

  for (const it of toRun) {
    const currentSnapshot = state.find((x) => x.id === it.id);
    if (!currentSnapshot) continue;
    const result = await safeProcessOne(currentSnapshot);
    state = await applyResult(state, it.id, result);
  }
}

/** Procesa un ítem específico por id (respeta backoff). */
export async function processOutboxOne(id: string): Promise<void> {
  const all = await loadOutbox();
  const idx = all.findIndex((x) => x.id === id);
  if (idx < 0) return;

  const item = all[idx];
  const now = Date.now();
  if (item.status !== 'pending' && item.status !== 'error') return;
  if (item.nextRetryAt != null && item.nextRetryAt > now) return;

  all[idx] = { ...item, status: 'processing', lastError: undefined };
  await saveOutbox(all);

  const result = await safeProcessOne(all[idx]);

  const latest = await loadOutbox();
  await applyResult(latest, id, result);
}

/* ============ Auto-worker: reconexión con debounce + pulso suave ============ */

let autoStarted = false;
let debounceTimer: any = null;

function scheduleDebouncedFlush() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    processOutboxBatch(50).catch(() => {});
    debounceTimer = null;
  }, 1500);
}

async function startAutoWorkerOnce() {
  if (autoStarted) return;
  autoStarted = true;

  try {
    const NetInfo: any = await import('@react-native-community/netinfo');
    NetInfo.addEventListener((state: any) => {
      const online = state?.isInternetReachable ?? state?.isConnected;
      if (online) scheduleDebouncedFlush();
    });
  } catch {
    // sin NetInfo, seguimos igual
  }

  setInterval(() => {
    scheduleDebouncedFlush();
  }, 60 * 1000);
}

startAutoWorkerOnce().catch(() => {});
