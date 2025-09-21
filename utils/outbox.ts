// utils/outbox.ts
import AsyncStorage from '@react-native-async-storage/async-storage';

// ➕ IMPORTS para reenvío real
import { db } from '../firebase/firebaseConfig';
import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  getDoc,
  addDoc,
  deleteDoc,
  updateDoc,
  setDoc,
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
  // 👇 Para informes/UI y caja
  clienteNombre?: string;
  alsoCajaDiaria?: boolean;
  cajaPayload?: { tipo: 'abono'; clienteNombre?: string };
  createdAtMs?: number; // opcional, por compat
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

// —— Nuevos payloads simples para movimientos de caja offline —— //
export type MovimientoCajaOfflinePayload = {
  admin: string;
  monto: number;
  tz: string;
  operationalDate: string;
  nota?: string | null;
  categoria?: string; // solo gastos
  meta?: Record<string, any>;
  createdAtMs?: number;
};

// Venta offline (nuevo préstamo + asiento en caja como retiro)
export type VentaOutboxPayload = {
  _subkind: 'venta';
  admin: string;
  targetClienteId: string;
  clienteData?: {
    nombre?: string;
    alias?: string;
    direccion1?: string;
    telefono1?: string;
    barrio?: string;
  };
  prestamoData?: {
    concepto?: string;
    clienteNombre?: string;
    modalidad?: string;
    interes?: number;
    valorNeto?: number;
    montoTotal?: number;
    totalPrestamo?: number;
    cuotas?: number;
    valorCuota?: number;
    fechaInicio?: string;
    diasHabiles?: number[];
    feriados?: string[];
    pausas?: any[];
    modoAtraso?: 'porPresencia' | 'porCuota';
    permitirAdelantar?: boolean;
    restante?: number;
  };
  caja: { monto: number; clienteNombre?: string };
  tz: string;
  operationalDate: string;
  createdAtMs?: number;
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
export type OutboxNoPago = OutboxBase & { kind: 'no_pago'; payload: NoPagoPayload };
// Para ventas y otros movimientos, mantenemos 'otro' + _subkind para no romper pantallas/hooks existentes.
export type OutboxOtro = OutboxBase & { kind: 'otro'; payload: any };

export type OutboxItem = OutboxAbono | OutboxNoPago | OutboxOtro;

// 👇 Tipos expuestos para el hook de badge/contadores
export type OutboxKind = 'abono' | 'no_pago' | 'otro';
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
  const byKind: Record<OutboxKind, number> = { abono: 0, no_pago: 0, otro: 0 };
  for (const it of pending) {
    const k = it.kind;
    if (k === 'abono' || k === 'no_pago' || k === 'otro') {
      byKind[k] += 1;
    } else {
      byKind.otro += 1;
    }
  }
  return { totalPending: pending.length, byKind };
}

/* ============ Add helpers (con overloads) ============ */

// Overloads
export async function addToOutbox(params: { kind: 'abono'; payload: AbonoPayload }): Promise<void>;
export async function addToOutbox(params: { kind: 'no_pago'; payload: NoPagoPayload }): Promise<void>;
export async function addToOutbox(params: { kind: 'otro'; payload: any }): Promise<void>;

// Implementación
export async function addToOutbox(
  params:
    | { kind: 'abono'; payload: AbonoPayload }
    | { kind: 'no_pago'; payload: NoPagoPayload }
    | { kind: 'otro'; payload: any }
): Promise<void> {
  const base: OutboxBase = {
    id: genLocalId(),
    createdAtMs: Date.now(),
    attempts: 0,
    status: 'pending',
  };

  // 🔒 Regla: SOLO 1 pago pendiente por CLIENTE
  if (params.kind === 'abono') {
    const list = await loadOutbox();
    const existsForClient = list.some(
      (x) =>
        x.kind === 'abono' &&
        (x.status === 'pending' || x.status === 'processing' || x.status === 'error') &&
        (x as OutboxAbono).payload?.clienteId === params.payload.clienteId
    );
    if (existsForClient) {
      const err = new Error('Ya hay un pago pendiente para este cliente.');
      err.name = 'PAGO_PENDIENTE_EXISTE';
      throw err;
    }
  }

  let full: OutboxItem;
  if (params.kind === 'abono') {
    full = {
      ...base,
      kind: 'abono',
      payload: { ...params.payload },
    };
  } else if (params.kind === 'no_pago') {
    full = {
      ...base,
      kind: 'no_pago',
      payload: { ...params.payload },
    };
  } else {
    full = {
      ...base,
      kind: 'otro',
      payload: params.payload,
    };
  }

  const list = await loadOutbox();
  list.push(full);
  await saveOutbox(list);

  try {
    await logAudit({
      userId: (full as any)?.payload?.admin ?? 'unknown',
      action: 'outbox_enqueue',
      docPath: `outbox/local/${full.id}`,
      after: pick(full, ['id', 'createdAtMs', 'attempts']),
    });
  } catch {}

  // 🚀 intenta procesar pronto
  scheduleDebouncedFlush();
}

/* ============ Wrappers para encolar movimientos de caja (offline) ============ */

export async function addToOutboxRetiro(payload: MovimientoCajaOfflinePayload): Promise<void> {
  await addToOutbox({ kind: 'otro', payload: { _subkind: 'retiro', ...payload } });
}

export async function addToOutboxIngreso(payload: MovimientoCajaOfflinePayload): Promise<void> {
  await addToOutbox({ kind: 'otro', payload: { _subkind: 'ingreso', ...payload } });
}

export async function addToOutboxGastoAdmin(payload: MovimientoCajaOfflinePayload): Promise<void> {
  await addToOutbox({ kind: 'otro', payload: { _subkind: 'gasto_admin', ...payload } });
}

export async function addToOutboxGastoCobrador(payload: MovimientoCajaOfflinePayload): Promise<void> {
  await addToOutbox({ kind: 'otro', payload: { _subkind: 'gasto_cobrador', ...payload } });
}

/* ============ Utilidades varias ============ */

export function genLocalId(): string {
  return 'loc_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Sencillo “contador en vivo” por polling (cada 1.5s). Mantén por compat.
export function subscribeCount(cb: (n: number) => void): () => void {
  let alive = true;
  const interval = setInterval(async () => {
    if (!alive) return;
    try {
      const list = await loadOutbox();
      cb(list.length);
    } catch {}
  }, 1500);

  return () => {
    alive = false;
    clearInterval(interval);
  };
}

/* ============ Reenvío real (implementación) ============ */

// -------- ABONO (igual que ya tenías en esencia) --------
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
  const abonoDocId = `ox_${item.id}`;
  const abonoDocRef = doc(abonosCol, abonoDocId);

  const createdAtMs =
    (typeof p.createdAtMs === 'number' && isFinite(p.createdAtMs) ? p.createdAtMs : undefined) ??
    (typeof item.createdAtMs === 'number' ? item.createdAtMs : Date.now());

  const txRes = await runTransaction(db, async (tx) => {
    const existing = await tx.get(abonoDocRef);
    if (existing.exists()) {
      return { created: false as const };
    }

    const snapPrestamo = await tx.get(prestamoRef);
    if (!snapPrestamo.exists()) throw new Error('Préstamo no existe (abono)');

    const data = snapPrestamo.data() as any;
    const restanteActual = Number(data?.restante ?? 0);
    const nuevoRestante = Math.max(0, restanteActual - Number(monto));

    const abPrev: any[] = Array.isArray(data?.abonos) ? data.abonos : [];
    const abEntry = {
      monto: Number(monto),
      registradoPor: admin,
      tz,
      operationalDate,
      createdAtMs,
      createdAtIso: new Date(createdAtMs).toISOString(),
    };
    const nuevosAbonos = [...abPrev, abEntry];

    const abonoDoc = {
      monto: Number(monto),
      registradoPor: admin,
      tz,
      operationalDate,
      createdAt: serverTimestamp(),
      createdAtMs,
      createdAtIso: new Date(createdAtMs).toISOString(),
      fromOutboxId: item.id,
    };
    tx.set(abonoDocRef, abonoDoc);

    tx.update(prestamoRef, {
      restante: nuevoRestante,
      abonos: nuevosAbonos,
      updatedAt: serverTimestamp(),
    });

    return {
      created: true as const,
      prestamoData: { ...data, abonos: nuevosAbonos, restante: nuevoRestante },
      tzPrestamo: pickTZ(data?.tz, tz || 'America/Sao_Paulo'),
      operativoHoy: operationalDate,
      nuevoRestante,
    };
  });

  if (!txRes.created) return;

  const { prestamoData, tzPrestamo, operativoHoy, nuevoRestante } = txRes;

  if (alsoCajaDiaria) {
    await recordAbonoFromOutbox({
      admin,
      outboxId: item.id,
      monto: Number(monto),
      operationalDate: operativoHoy,
      tz: tzPrestamo,
      meta: {
        clienteId,
        prestamoId,
        abonoRefPath: abonoDocRef.path,
        clienteNombre: cajaPayload?.clienteNombre ?? clienteNombre ?? (prestamoData?.concepto ?? '').trim(),
      },
    });
  }

  try {
    const pData = prestamoData || {};
    const hoy = operativoHoy || todayInTZ(tzPrestamo);

    const diasHabiles =
      Array.isArray(pData?.diasHabiles) && pData.diasHabiles.length ? pData.diasHabiles : [1, 2, 3, 4, 5, 6];
    const feriados = Array.isArray(pData?.feriados) ? pData.feriados : [];
    const pausas = Array.isArray(pData?.pausas) ? pData.pausas : [];
    const modo = (pData?.modoAtraso as 'porPresencia' | 'porCuota') ?? 'porPresencia';
    const permitirAdelantar = !!pData?.permitirAdelantar;
    const cuotas =
      Number(pData?.cuotas || 0) ||
      Math.ceil(Number(pData.totalPrestamo || pData.montoTotal || 0) / (Number(pData.valorCuota) || 1));

    const res = calcularDiasAtraso({
      fechaInicio: pData?.fechaInicio || hoy,
      hoy,
      cuotas,
      valorCuota: Number(pData?.valorCuota || 0),
      abonos: (pData?.abonos || []).map((a: any) => ({
        monto: Number(a.monto) || 0,
        operationalDate: a.operationalDate,
        fecha: a.fecha,
      })),
      diasHabiles,
      feriados,
      pausas,
      modo,
      permitirAdelantar,
    });

    if (nuevoRestante > 0) {
      await updateDoc(prestamoRef, {
        diasAtraso: res.atraso,
        faltas: res.faltas || [],
        ultimaReconciliacion: serverTimestamp(),
      });

      await logAudit({
        userId: admin,
        action: 'update',
        ref: prestamoRef,
        before: pick(prestamoData, ['restante']),
        after: { restante: nuevoRestante },
      });
    }

    if (nuevoRestante === 0) {
      const historialRef = collection(db, 'clientes', clienteId, 'historialPrestamos');
      const histRef = await addDoc(historialRef, {
        ...pData,
        restante: 0,
        diasAtraso: 0,
        faltas: [],
        finalizadoEn: serverTimestamp(),
        finalizadoPor: admin,
      });

      await logAudit({
        userId: admin,
        action: 'create',
        ref: histRef,
        after: { clienteId, prestamoId, restante: 0, finalizadoPor: admin },
      });

      await deleteDoc(prestamoRef);

      await logAudit({
        userId: admin,
        action: 'delete',
        ref: prestamoRef,
        before: pick(prestamoData, ['restante', 'valorCuota', 'totalPrestamo', 'clienteId', 'concepto']),
        after: null,
      });
    }
  } catch (e) {
    try {
      await logAudit({
        userId: admin,
        action: 'update',
        docPath: prestamoRef.path,
        before: null,
        after: { note: 'recalculo_atraso_fallo', error: String(e), fromOutboxId: item.id },
      });
    } catch {}
  }

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

// -------- VENTA / NUEVO PRÉSTAMO (offline → online) --------
// Espera item.kind === 'otro' con payload._subkind === 'venta'
async function reenviarVenta(item: OutboxOtro): Promise<void> {
  const p = item.payload || {};
  if (p._subkind !== 'venta') return;

  const admin: string = p.admin;
  const clienteId: string = p.targetClienteId;
  const clienteData: any = p.clienteData || {};
  const prestamoData: any = p.prestamoData || {};
  const tz: string = pickTZ(p.tz || 'America/Sao_Paulo'); // ✅ sin mezclar ?? y ||
  const operationalDate: string = p.operationalDate || todayInTZ(tz);
  const createdAtMs: number =
    (typeof p.createdAtMs === 'number' && isFinite(p.createdAtMs) ? p.createdAtMs : undefined) ??
    (typeof item.createdAtMs === 'number' ? item.createdAtMs : Date.now());
  const caja: { monto: number; clienteNombre?: string } = p.caja || { monto: 0 };

  if (!admin || !clienteId) throw new Error('Payload de venta incompleto: admin/clienteId faltan');
  if (!Number.isFinite(caja.monto) || caja.monto <= 0) throw new Error('Monto de caja inválido para venta');

  // 1) Upsert cliente (solo campos básicos, sin pisar createdAt)
  const clienteRef = doc(db, 'clientes', clienteId);
  await setDoc(
    clienteRef,
    {
      ...(clienteData?.nombre ? { nombre: clienteData.nombre } : {}),
      ...(clienteData?.alias ? { alias: clienteData.alias } : {}),
      ...(clienteData?.direccion1 ? { direccion1: clienteData.direccion1 } : {}),
      ...(clienteData?.telefono1 ? { telefono1: clienteData.telefono1 } : {}),
      actualizadoEn: serverTimestamp(),
    },
    { merge: true }
  );

  await logAudit({
    userId: admin,
    action: 'update',
    ref: clienteRef,
    after: pick(clienteData || {}, ['nombre', 'alias', 'direccion1', 'telefono1']),
  });

  // 2) Crear préstamo idempotente con ID 'ox_<outboxId>'
  const prestamoRef = doc(collection(clienteRef, 'prestamos'), `ox_${item.id}`);
  const prestamoSnap = await getDoc(prestamoRef);
  let prestamoCreated = false;

  if (!prestamoSnap.exists()) {
    const basePrestamo = {
      // denormalizados visibles en tus pantallas/consultas
      concepto: String(prestamoData?.concepto || caja?.clienteNombre || clienteData?.nombre || 'Sin nombre').trim(),
      cobradorId: admin,
      montoTotal: Number(prestamoData?.montoTotal || 0),
      restante: Number(prestamoData?.restante ?? (prestamoData?.montoTotal || 0)),

      creadoPor: admin,
      creadoEn: serverTimestamp(),
      createdAtMs: createdAtMs,
      createdDate: operationalDate,

      // denormalizados del cliente
      clienteNombre:
        String(prestamoData?.clienteNombre || caja?.clienteNombre || clienteData?.nombre || '').trim() ||
        'Sin nombre',
      clienteAlias: clienteData?.alias ?? '',
      clienteDireccion1: clienteData?.direccion1 ?? '',
      clienteTelefono1: clienteData?.telefono1 ?? '',

      modalidad: prestamoData?.modalidad,
      interes: Number(prestamoData?.interes || 0),
      valorNeto: Number(prestamoData?.valorNeto || 0),
      totalPrestamo: Number(prestamoData?.totalPrestamo || prestamoData?.montoTotal || 0),
      cuotas: Number(prestamoData?.cuotas || 0),
      valorCuota: Number(prestamoData?.valorCuota || 0),

      // calendario/tz
      fechaInicio: prestamoData?.fechaInicio || operationalDate,
      clienteId,
      tz,
      diasHabiles: Array.isArray(prestamoData?.diasHabiles) ? prestamoData.diasHabiles : [1, 2, 3, 4, 5, 6],
      feriados: Array.isArray(prestamoData?.feriados) ? prestamoData.feriados : [],
      pausas: Array.isArray(prestamoData?.pausas) ? prestamoData.pausas : [],

      modoAtraso: prestamoData?.modoAtraso || 'porPresencia',
      permitirAdelantar: prestamoData?.permitirAdelantar ?? true,
    };

    await setDoc(prestamoRef, basePrestamo);
    prestamoCreated = true;

    await logAudit({
      userId: admin,
      action: 'create',
      ref: prestamoRef,
      after: pick(basePrestamo, [
        'concepto',
        'cobradorId',
        'montoTotal',
        'restante',
        'valorCuota',
        'cuotas',
        'clienteId',
        'modalidad',
        'interes',
        'valorNeto',
        'fechaInicio',
        'tz',
        'permitirAdelantar',
        'createdDate',
      ]),
    });

    // 2.b) Índice clientesDisponibles
    const idxRef = doc(db, 'clientesDisponibles', clienteId);
    const idxPayload = {
      id: clienteId,
      disponible: false,
      actualizadoEn: serverTimestamp(),
      creadoPor: admin,
      alias: clienteData?.alias ?? '',
      nombre:
        String(prestamoData?.clienteNombre || caja?.clienteNombre || clienteData?.nombre || '').trim() || 'Sin nombre',
      barrio: clienteData?.barrio ?? '',
      telefono1: clienteData?.telefono1 ?? '',
    };
    await setDoc(idxRef, idxPayload, { merge: true });

    await logAudit({
      userId: admin,
      action: 'update',
      ref: idxRef,
      after: pick(idxPayload, ['id', 'disponible', 'alias', 'nombre', 'barrio', 'telefono1']),
    });
  }

  // 3) Caja diaria: asiento idempotente como RETIRO (desembolso)
  await addMovimientoIdempotente(
    admin,
    {
      tipo: 'retiro', // 👈 IMPORTANTE: venta => retiro
      monto: Number(caja.monto || prestamoData?.valorNeto || 0),
      operationalDate,
      tz,
      nota: String(prestamoData?.modalidad || '').trim() || undefined,
      meta: {
        fromOutboxId: item.id,
        clienteId,
        prestamoId: `ox_${item.id}`,
        clienteNombre:
          String(prestamoData?.clienteNombre || caja?.clienteNombre || clienteData?.nombre || '').trim() ||
          'Sin nombre',
      },
      source: 'system',
    },
    `oxsale_${item.id}`
  );

  // 4) Audit del asiento (opcional, útil para trazabilidad)
  if (prestamoCreated) {
    await logAudit({
      userId: admin,
      action: 'create',
      docPath: `cajaDiaria/oxsale_${item.id}`,
      after: {
        tipo: 'retiro',
        admin,
        clienteId,
        prestamoId: `ox_${item.id}`,
        monto: Number(caja.monto || prestamoData?.valorNeto || 0),
        tz,
        operationalDate,
        fromOutboxId: item.id,
      },
    });
  }
}

// -------- Movimientos simples de caja: retiro/ingreso/gasto_admin/gasto_cobrador --------
async function reenviarMovimientoCaja(item: OutboxOtro): Promise<void> {
  const p = item.payload || {};
  const sub: string | undefined = p._subkind;
  if (!sub || !['retiro', 'ingreso', 'gasto_admin', 'gasto_cobrador'].includes(sub)) return;

  const admin: string = p.admin;
  const monto: number = Number(p.monto);
  const tz: string = pickTZ(p.tz || 'America/Sao_Paulo');
  const operationalDate: string = p.operationalDate || todayInTZ(tz);
  const nota: string | undefined = (p.nota ?? '').toString().trim() || undefined;
  const categoria: string | undefined =
    (p.categoria ?? '').toString().trim() || undefined; // relevante para gastos
  const meta: Record<string, any> | undefined = p.meta && typeof p.meta === 'object' ? p.meta : undefined;

  if (!admin || !Number.isFinite(monto) || monto <= 0) {
    throw new Error('Payload de movimiento de caja incompleto/invalid');
  }

  // Mapeo directo: subkind → tipo canónico de caja
  const tipo = sub as 'retiro' | 'ingreso' | 'gasto_admin' | 'gasto_cobrador';

  // ID determinístico por subkind
  const docId = `oxmov_${sub}_${item.id}`;

  await addMovimientoIdempotente(
    admin,
    {
      tipo,
      monto,
      operationalDate,
      tz,
      nota,
      categoria,
      meta: { ...(meta || {}), fromOutboxId: item.id },
      // 👇 coherencia con online:
      // - para gasto_cobrador mostramos que vino del cobrador
      // - el resto queda como 'system' (generado por el motor)
      source: tipo === 'gasto_cobrador' ? 'cobrador' : 'system',
    },
    docId
  );

  await logAudit({
    userId: admin,
    action: 'create',
    docPath: `cajaDiaria/${docId}`,
    after: {
      tipo,
      admin,
      monto,
      tz,
      operationalDate,
      nota: nota || undefined,
      categoria: categoria || undefined,
      fromOutboxId: item.id,
    },
  });
}

// -------- NO PAGO (igual que ya tenías) --------
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
    after: pick(base, [
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
    ]),
  });
}

/* ============ Procesador ============ */
export async function processOutboxItem(item: OutboxItem): Promise<boolean> {
  if (item.kind === 'abono') {
    await reenviarAbono(item as OutboxAbono);
    return true;
  }
  if (item.kind === 'no_pago') {
    await reenviarNoPago(item as OutboxNoPago);
    return true;
  }
  if (item.kind === 'otro') {
    const sub = (item as OutboxOtro).payload?._subkind;
    if (sub === 'venta') {
      await reenviarVenta(item as OutboxOtro);
      return true;
    }
    if (sub === 'retiro' || sub === 'ingreso' || sub === 'gasto_admin' || sub === 'gasto_cobrador') {
      await reenviarMovimientoCaja(item as OutboxOtro);
      return true;
    }
    // otros subtipos podrían ir aquí
    return true;
  }
  return true;
}

/* ============ Motor con backoff (igual) ============ */

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
    return filtered;
  }
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

export async function processOutboxOne(id: string): Promise<void> {
  const all = await loadOutbox();
  const idx = all.findIndex((x) => x.id === id);
  if (idx < 0) return;

  const item = all[idx];
  const now = Date.now();
  if (item.status !== 'pending' && item.status !== 'error') return;
  if (item.nextRetryAt != null && item.nextRetryAt > now) return;

  all[idx] = { ...item, status: 'processing' as OutboxStatus, lastError: undefined };
  await saveOutbox(all);

  const result = await safeProcessOne(all[idx]);

  const latest = await loadOutbox();
  await applyResult(latest, id, result);
}

/* ============ Auto-worker ============ */
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
  } catch {}

  setInterval(() => {
    scheduleDebouncedFlush();
  }, 60 * 1000);
}

startAutoWorkerOnce().catch(() => {});
