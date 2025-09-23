// utils/outbox.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';

// ➕ IMPORTS para reenvío real
import { db } from '../firebase/firebaseConfig';
import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  getDoc,
  getDocs,
} from 'firebase/firestore';
import { logAudit, pick } from './auditLogs';
import { pickTZ, todayInTZ } from './timezone';
import { recordAbonoFromOutbox, addMovimientoIdempotente } from './caja';
import { calcularDiasAtraso } from './atrasoHelper';

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
  /** Nombre visible para UI/Informes; queda top-level para no perderlo en outbox/caja */
  clienteNombre?: string;
  alsoCajaDiaria?: boolean;
  cajaPayload?: { tipo: 'abono'; clienteNombre?: string };
  createdAtMs?: number; // opcional, por compat
};

export type VentaPayload = {
  admin: string;
  clienteId: string;
  /** Nombre visible del cliente para UI/Informes y caja */
  clienteNombre?: string;

  // Campos del préstamo
  valorCuota: number;
  cuotas: number;
  totalPrestamo?: number; // alias opcional
  montoTotal?: number;   // alias opcional
  fechaInicio: string;   // YYYY-MM-DD
  tz: string;
  operationalDate: string;

  /** Monto que sale de caja al crear el préstamo */
  retiroCaja: number;

  /** Metadatos adicionales opcionales */
  meta?: Record<string, any>;
};

export type NoPagoPayload = {
  admin: string;
  clienteId: string;
  prestamoId: string;
  reason: ReasonNoPago;
  nota?: string;
  promesaFecha?: string; // YYYY-MM-DD
  promesaMonto?: number;
  createdAtMs?: number; // opcional, por compat
};

/** ✅ NUEVO: Movimiento genérico offline (no asociado a un préstamo específico) */
export type MovSubkind = 'ingreso' | 'retiro' | 'gasto_admin' | 'gasto_cobrador';
export type MovPayload = {
  admin: string;
  subkind: MovSubkind;
  monto: number;
  operationalDate: string; // YYYY-MM-DD
  tz: string;
  nota?: string | null;
  /** Categoría solo aplica para gasto_admin (ej. “papelería”) */
  categoria?: string;

  /** Datos de cliente opcionales para reportes (si aplica) */
  clienteId?: string;
  prestamoId?: string;
  clienteNombre?: string;

  /** Metadatos libres */
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
/** ✅ NUEVO: item “mov” */
export type OutboxMov = OutboxBase & { kind: 'mov'; payload: MovPayload };
// Por si quieres poner otras cosas (logs, etc.)
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

export function subscribeOutbox(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitOutboxChanged() {
  for (const l of listeners) {
    try {
      l();
    } catch {}
  }
}

/* 🔔 Evento global para que Home/Pagos recarguen al terminar un envío */
export const OUTBOX_FLUSHED = 'outbox:flushed';
export function emitOutboxFlushed() {
  try { DeviceEventEmitter.emit(OUTBOX_FLUSHED); } catch {}
}

/* ============ Storage helpers ============ */
export async function loadOutbox(): Promise<OutboxItem[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: any[] = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as OutboxItem[]) : [];
  } catch {
    return [];
  }
}

export async function saveOutbox(list: OutboxItem[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  // 🔔 Notifica a la UI (badge/pendientes) en cada cambio
  emitOutboxChanged();
}

// (alias opcional) lectura directa
export async function listOutbox(): Promise<OutboxItem[]> {
  return loadOutbox();
}

/* ============ Contadores para badge ============ */
export async function getOutboxCounts(): Promise<OutboxStatusCounts> {
  const list = await loadOutbox();
  const pending = list.filter((x) => (x.status ?? 'pending') !== 'done');
  const byKind: Record<OutboxKind, number> = { abono: 0, venta: 0, no_pago: 0, mov: 0, otro: 0 };
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

/* ============ Add helpers (con overloads) ============ */

// Overloads
export async function addToOutbox(params: { kind: 'abono'; payload: AbonoPayload }): Promise<void>;
export async function addToOutbox(params: { kind: 'venta'; payload: VentaPayload }): Promise<void>;
export async function addToOutbox(params: { kind: 'no_pago'; payload: NoPagoPayload }): Promise<void>;
export async function addToOutbox(params: { kind: 'mov'; payload: MovPayload }): Promise<void>;
export async function addToOutbox(params: { kind: 'otro'; payload: any }): Promise<void>;

// Implementación
export async function addToOutbox(
  params:
    | { kind: 'abono'; payload: AbonoPayload }
    | { kind: 'venta'; payload: VentaPayload }
    | { kind: 'no_pago'; payload: NoPagoPayload }
    | { kind: 'mov'; payload: MovPayload }
    | { kind: 'otro'; payload: any }
): Promise<void> {
  const base: OutboxBase = {
    id: genLocalId(),
    createdAtMs: Date.now(),
    attempts: 0,
    status: 'pending' as OutboxStatus,
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
      payload: {
        ...params.payload,
        clienteNombre: clienteNombreNorm,
      },
    };
    const list = await loadOutbox();
    list.push(full);
    await saveOutbox(list);
  } else if (params.kind === 'venta') {
    const clienteNombreNorm = params.payload?.clienteNombre ?? undefined;
    full = {
      ...base,
      kind: 'venta',
      payload: { ...params.payload, clienteNombre: clienteNombreNorm },
    };
    const list = await loadOutbox();
    list.push(full);
    await saveOutbox(list);
  } else if (params.kind === 'no_pago') {
    full = {
      ...base,
      kind: 'no_pago',
      payload: { ...params.payload },
    };
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
    full = {
      ...base,
      kind: 'otro',
      payload: params.payload,
    };
    const list = await loadOutbox();
    list.push(full);
    await saveOutbox(list);
  }

  // (Opcional) auditar encolado
  try {
    await logAudit({
      userId: (full as any)?.payload?.admin ?? 'unknown',
      action: 'outbox_enqueue',
      docPath: `outbox/local/${full.id}`,
      after: pick(full, ['id', 'createdAtMs', 'attempts']),
    });
  } catch {}

  // 🚀 Si acabamos de encolar algo, intenta procesar pronto (debounced)
  scheduleDebouncedFlush();
}

/* ============ Utilidades varias ============ */

export function genLocalId(): string {
  return 'loc_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Sencillo “contador en vivo” por polling (cada 1.5s). Mantén por compat.
// Devuelve una función para desuscribirte.
export function subscribeCount(cb: (n: number) => void): () => void {
  let alive = true;
  const interval = setInterval(async () => {
    if (!alive) return;
    try {
      const list = await loadOutbox();
      cb(list.length);
    } catch {
      // ignore
    }
  }, 1500);

  return () => {
    alive = false;
    clearInterval(interval);
  };
}

/* ============ Reenvío real (implementación) ============ */

// Abono → transacción idempotente usando docId determinístico: abonos/ox_<outboxId>
// + asiento de caja idempotente en cajaDiaria/ox_<outboxId>
// + actualización de restante y diasAtraso
async function reenviarAbono(item: OutboxAbono): Promise<void> {
  const p = item.payload;
  const {
    admin,
    clienteId,
    prestamoId,
    monto,
    tz,
    operationalDate,
    alsoCajaDiaria,
    cajaPayload,
    clienteNombre,
  } = p;

  if (!admin || !clienteId || !prestamoId || !Number.isFinite(monto)) {
    throw new Error('Payload de abono incompleto');
  }

  const prestamoRef = doc(db, 'clientes', clienteId, 'prestamos', prestamoId);
  const abonosCol = collection(prestamoRef, 'abonos');
  const abonoDocId = `ox_${item.id}`; // 👈 clave idempotente
  const abonoDocRef = doc(abonosCol, abonoDocId);

  const abonoDoc = {
    monto: Number(monto),
    registradoPor: admin,
    tz,
    operationalDate, // YYYY-MM-DD
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
    source: 'outbox',
    fromOutboxId: item.id, // trazabilidad
  };

  // 1) Transacción idempotente: si ya existe el abono, no hacer nada.
  let nuevoRestante: number | null = null;
  const created = await runTransaction(db, async (tx) => {
    const existing = await tx.get(abonoDocRef);
    if (existing.exists()) {
      // Ya aplicado previamente
      return false as const;
    }

    // Descontar restante una sola vez
    const snapPrestamo = await tx.get(prestamoRef);
    if (!snapPrestamo.exists()) throw new Error('Préstamo no existe (abono)');

    const data = snapPrestamo.data() as any;
    const restanteActual =
      typeof data.restante === 'number'
        ? data.restante
        : (data.montoTotal || data.totalPrestamo || 0);

    const nextRestante = Math.max(0, Number(restanteActual) - Number(monto));
    nuevoRestante = nextRestante;

    tx.update(prestamoRef, {
      restante: nextRestante,
      updatedAt: serverTimestamp(),
    });

    // Crear el abono con ID determinístico
    tx.set(abonoDocRef, abonoDoc);

    return true as const;
  });

  // 2) Si NO se creó (ya existía), salir sin duplicar caja ni auditoría.
  if (!created) return;

  // 3) Recalcular y actualizar diasAtraso/faltas en el préstamo (best-effort)
  try {
    const loanSnap = await getDoc(prestamoRef);
    if (loanSnap.exists()) {
      const d = loanSnap.data() as any;

      // Construir array de abonos desde la subcolección para el cálculo
      const abonosSnap = await getDocs(collection(prestamoRef, 'abonos'));
      const abonos = abonosSnap.docs.map((docu) => {
        const a = docu.data() as any;
        return {
          monto: Number(a?.monto) || 0,
          operationalDate: a?.operationalDate,
          fecha: a?.fecha, // por compat si existiera
        };
      });

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

      const res = calcularDiasAtraso({
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

      await runTransaction(db, async (tx) => {
        const snapAgain = await tx.get(prestamoRef);
        if (!snapAgain.exists()) return;
        const updates: any = {
          diasAtraso: res.atraso,
          faltas: res.faltas || [],
          ultimaReconciliacion: serverTimestamp(),
          lastAbonoAt: serverTimestamp(),
        };
        if (typeof nuevoRestante === 'number') {
          updates.restante = nuevoRestante;
        }
        tx.update(prestamoRef, updates);
      });
    }
  } catch {
    // tolerante a fallos de recálculo; el restante ya quedó consistente
  }

  // 4) Caja — idempotente con 'ox_<outboxId>' (con top-level nombre/ids)
  if (alsoCajaDiaria) {
    await recordAbonoFromOutbox({
      admin,
      outboxId: item.id,
      monto: Number(monto),
      operationalDate,
      tz,
      clienteNombre: clienteNombre ?? cajaPayload?.clienteNombre,
      clienteId,
      prestamoId,
      meta: {
        abonoRefPath: abonoDocRef.path,
      },
    });
  }

  // 5) Audit log — solo si se creó ahora
  await logAudit({
    userId: admin,
    action: 'abono_outbox',
    docPath: abonoDocRef.path,
    after: pick(
      {
        admin,
        clienteId,
        prestamoId,
        monto: Number(monto),
        tz,
        operationalDate,
        fromOutboxId: item.id,
      },
      ['admin', 'clienteId', 'prestamoId', 'monto', 'tz', 'operationalDate', 'fromOutboxId']
    ),
  });
}

// Venta → crear préstamo idempotente con ID 'ox_<outboxId>'
// y registrar retiro en caja con ID 'oxsale_<outboxId>'
async function reenviarVenta(item: OutboxVenta): Promise<void> {
  const p = item.payload;
  const {
    admin,
    clienteId,
    clienteNombre,
    valorCuota,
    cuotas,
    totalPrestamo,
    montoTotal,
    fechaInicio,
    tz,
    operationalDate,
    retiroCaja,
    meta,
  } = p;

  if (!admin || !clienteId || !Number.isFinite(valorCuota) || !Number.isFinite(cuotas) || !fechaInicio) {
    throw new Error('Payload de venta incompleto');
  }

  const total = Number(
    (typeof totalPrestamo === 'number' ? totalPrestamo : undefined) ??
      (typeof montoTotal === 'number' ? montoTotal : undefined) ??
      valorCuota * cuotas
  );

  const prestamosCol = collection(doc(db, 'clientes', clienteId), 'prestamos');
  const prestamoId = `ox_${item.id}`; // 👈 idempotente
  const prestamoRef = doc(prestamosCol, prestamoId);

  const created = await runTransaction(db, async (tx) => {
    const exists = await tx.get(prestamoRef);
    if (exists.exists()) return false as const;

    const payloadPrestamo: any = {
      creadoPor: admin,
      clienteId,
      concepto: (clienteNombre || '').trim() || 'Sin nombre',
      valorCuota: Number(valorCuota),
      cuotas: Number(cuotas),
      totalPrestamo: Number(total),
      montoTotal: Number(total), // mantener ambos por compat
      restante: Number(total),
      fechaInicio,
      tz,
      operationalDate,
      createdAt: serverTimestamp(),
      createdAtMs: Date.now(),
      fromOutboxId: item.id,
      ...(meta || {}),
    };

    tx.set(prestamoRef, payloadPrestamo);
    return true as const;
  });

  // Si ya existía, no volver a registrar caja ni auditar
  if (!created) return;

  // Caja: retiro por desembolso, idempotente con 'oxsale_<outboxId>'
  try {
    await addMovimientoIdempotente(
      admin,
      {
        tipo: 'retiro',
        admin,
        monto: Number(retiroCaja || total),
        operationalDate,
        tz,
        clienteId,
        prestamoId,
        clienteNombre,
        meta: {
          clienteId,
          prestamoId,
          clienteNombre,
          fromOutboxId: item.id,
        },
      } as any,
      `oxsale_${item.id}`
    );
  } catch {
    // best-effort: si caja falla, el préstamo igualmente quedó creado idempotentemente
  }

  await logAudit({
    userId: admin,
    action: 'venta_outbox',
    docPath: prestamoRef.path,
    after: {
      admin,
      clienteId,
      prestamoId,
      clienteNombre,
      valorCuota: Number(valorCuota),
      cuotas: Number(cuotas),
      totalPrestamo: Number(total),
      retiroCaja: Number(retiroCaja || total),
      operationalDate,
      tz,
      fromOutboxId: item.id,
    },
  });
}

// No-pago → idempotente con docId determinístico: reportesNoPago/ox_<outboxId>
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
  const noPagoDocId = `ox_${item.id}`; // 👈 clave idempotente
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

  // Transacción idempotente: si ya existe, no recrear
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
      ['tipo', 'reason', 'fechaOperacion', 'clienteId', 'prestamoId', 'valorCuota', 'saldo', 'promesaFecha', 'promesaMonto', 'nota', 'fromOutboxId']
    ),
  });
}

/** ✅ NUEVO: Mov genérico → usar addMovimientoIdempotente con id 'oxmov_<subkind>_<outboxId>' */
async function reenviarMov(item: OutboxMov): Promise<void> {
  const p = item.payload;
  const { admin, subkind, monto, operationalDate, tz, nota, categoria, clienteId, prestamoId, clienteNombre, meta } = p;

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
      ['tipo','admin','monto','operationalDate','tz','nota','categoria','clienteId','prestamoId','clienteNombre','fromOutboxId']
    ),
  });
}

/* ============ (Opcional) procesamiento (expuesto) ============ */
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
  // Otros tipos: márcalos como "procesados" sin acción remota
  return true;
}

/* ============ NUEVO: Motor de procesamiento con backoff + límites ============ */

// Backoff exponencial: 1s → 2s → 4s → 8s → 16s → 32s → 60s (tope)
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
// Límite de reintentos (después queda en 'error' sin nextRetryAt)
const MAX_ATTEMPTS = 8;

function computeNextBackoff(attempts: number): number {
  const exp = Math.max(0, attempts - 1);
  const ms = BACKOFF_BASE_MS * Math.pow(2, exp);
  return Math.min(BACKOFF_MAX_MS, ms);
}

async function markProcessing(list: OutboxItem[], ids: Set<string>): Promise<OutboxItem[]> {
  const next: OutboxItem[] = list.map((it): OutboxItem =>
    ids.has(it.id) ? { ...it, status: 'processing' as OutboxStatus, lastError: undefined } : it
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
    // 🔔 notifica a la UI (Home/Pagos) para refrescar KPIs/listas
    emitOutboxFlushed();
    return filtered;
  }
  // fallo → marcar error + backoff (o detener si excede MAX_ATTEMPTS)
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) return list;
  const curr = list[idx];
  const attempts = (curr.attempts ?? 0) + 1;

  let updated: OutboxItem;
  if (attempts >= MAX_ATTEMPTS) {
    updated = {
      ...curr,
      attempts,
      status: 'error',
      lastError: result.errorMsg || 'Fallo al reenviar (límite de intentos)',
      nextRetryAt: undefined,
    };
  } else {
    const backoff = computeNextBackoff(attempts);
    updated = {
      ...curr,
      attempts,
      status: 'error' as OutboxStatus,
      lastError: result.errorMsg || 'Fallo al reenviar',
      nextRetryAt: Date.now() + backoff,
    };
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

/**
 * Procesa hasta `maxItems` elementos listos (status 'pending' o 'error' cuyo nextRetryAt venció).
 * Marca 'processing' antes de ejecutar. Aplica backoff en fallos y elimina en éxitos.
 */
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

  // Marcar processing
  const ids = new Set(toRun.map((x) => x.id));
  let state = await markProcessing(all, ids);

  // Ejecutar secuencialmente (simple y seguro)
  for (const it of toRun) {
    const currentSnapshot = state.find((x) => x.id === it.id);
    if (!currentSnapshot) continue;
    const result = await safeProcessOne(currentSnapshot);
    state = await applyResult(state, it.id, result);
  }
}

/**
 * Procesa un ítem específico por id, respetando el backoff (si falta tiempo no procesa).
 * Si no existe, no hace nada.
 */
export async function processOutboxOne(id: string): Promise<void> {
  const all = await loadOutbox();
  const idx = all.findIndex((x) => x.id === id);
  if (idx < 0) return;

  const item = all[idx];
  const now = Date.now();
  if (item.status !== 'pending' && item.status !== 'error') return;
  if (item.nextRetryAt != null && item.nextRetryAt > now) return;

  // marcar processing
  all[idx] = { ...item, status: 'processing' as OutboxStatus, lastError: undefined };
  await saveOutbox(all);

  const result = await safeProcessOne(all[idx]);

  // recargar por seguridad y aplicar
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

  // Intenta enganchar reconexión si existe NetInfo (no rompe si no está)
  try {
    const NetInfo: any = await import('@react-native-community/netinfo');
    NetInfo.addEventListener((state: any) => {
      const online = state?.isInternetReachable ?? state?.isConnected;
      if (online) scheduleDebouncedFlush();
    });
  } catch {
    // sin NetInfo, seguimos igual
  }

  // Pulso cada 60s por si algo quedó congelado
  setInterval(() => {
    scheduleDebouncedFlush();
  }, 60 * 1000);
}

// Arranca al importar el módulo
startAutoWorkerOnce().catch(() => {});
