// utils/caja.ts
import {
  addDoc,
  collection,
  serverTimestamp,
  query,
  where,
  getDocs,
  doc,
  getDoc,
  setDoc,
} from 'firebase/firestore';
import { db } from '../firebase/firebaseConfig';
import { logAudit, pick } from './auditLogs';

// 👇 Fase 2: tipos e intérprete canónico
import {
  canonicalTipo,
  type MovimientoTipo,
} from './movimientoHelper';

// 👇 Normalización de fecha/TZ y redondeos seguros
import { pickTZ, normYYYYMMDD } from './timezone';

// ===== Tipos =====
type LegacyMovimientoTipo = 'gasto' | 'gastoAdmin' | 'pago' | 'aperturaAuto';
type AnyMovimientoTipo = MovimientoTipo | LegacyMovimientoTipo;

export type MovimientoCaja = {
  // Ya canónico al SALIR/LEER de este módulo
  tipo: MovimientoTipo;
  admin: string;
  monto: number;
  nota?: string | null;
  operationalDate: string; // 'YYYY-MM-DD'
  tz: string;              // 'America/Sao_Paulo'
  createdAt?: any;
  createdAtMs?: number;
  meta?: Record<string, any>;
  categoria?: string;      // para gasto_admin / gasto_cobrador
  source?: 'manual' | 'auto' | 'system' | 'app' | 'cobrador'; // 👈 añade 'cobrador'

  // 👇 Campos de identidad del movimiento (para informes/UI)
  clienteId?: string;
  prestamoId?: string;
  clienteNombre?: string;
};

const MIN_AMOUNT = 0.01;
const round2 = (n: number) => {
  const v = Math.round(Number(n) * 100) / 100;
  return Math.abs(v) < 0.005 ? 0 : v; // evita -0.00
};

// 🚿 Quita claves con valor undefined (Firestore no las admite)
function stripUndefined<T extends Record<string, any>>(obj: T): T {
  const out: any = {};
  for (const k in obj) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function sanitizeInput(_admin: string, data: {
  tipo: AnyMovimientoTipo;
  admin?: string;
  monto: any;
  operationalDate: any;
  tz?: string | null;
  nota?: string | null;
  categoria?: string;
  meta?: Record<string, any>;
  source?: MovimientoCaja['source'];

  // 👇 opcionales para informes/UI
  clienteId?: string;
  prestamoId?: string;
  clienteNombre?: string;
}) {
  // mapear legacy → canónico (p.ej. 'pago' → 'abono')
  const tip = canonicalTipo(String(data.tipo));
  if (!tip) throw new Error(`Tipo de movimiento inválido: ${String(data.tipo)}`);

  const monto = round2(Number(data.monto ?? NaN));
  if (!Number.isFinite(monto) || monto < MIN_AMOUNT) {
    throw new Error(`Monto inválido (< ${MIN_AMOUNT.toFixed(2)}): ${data.monto}`);
  }

  const operationalDate = normYYYYMMDD(data.operationalDate);
  if (!operationalDate) throw new Error('operationalDate inválido');

  const tz = pickTZ(data.tz || undefined);
  const admin = (data.admin || _admin || '').trim();
  if (!admin) throw new Error('admin requerido');

  const nota = (data.nota ?? '').toString().trim() || null;                 // null OK en Firestore
  const categoria = (data.categoria ?? '').toString().trim() || undefined;  // undefined será removido
  const meta = data.meta && typeof data.meta === 'object' ? data.meta : undefined;
  const source: MovimientoCaja['source'] = data.source || 'manual';

  // identidad opcional (se persiste en top-level para UI/consultas)
  const clienteId = (data.clienteId ?? '').toString().trim() || undefined;
  const prestamoId = (data.prestamoId ?? '').toString().trim() || undefined;
  const clienteNombreRaw = (data.clienteNombre ?? '').toString().trim();
  const clienteNombre = clienteNombreRaw ? clienteNombreRaw : undefined;

  return { tip, admin, monto, operationalDate, tz, nota, categoria, meta, source, clienteId, prestamoId, clienteNombre };
}

// =============== Escritura clásica (no idempotente) ===============
/** Escribe un movimiento en 'cajaDiaria'. Acepta tipos legacy y los mapea a canónicos. */
export async function addMovimiento(
  _admin: string,
  data: Omit<MovimientoCaja, 'tipo' | 'admin' | 'createdAt' | 'createdAtMs' | 'source'> &
        { tipo: AnyMovimientoTipo; admin?: string; source?: MovimientoCaja['source'] }
) {
  const refCol = collection(db, 'cajaDiaria');
  const s = sanitizeInput(_admin, data);

  const payload = {
    tipo: s.tip,                 // 👈 siempre canónico
    admin: s.admin,
    monto: s.monto,
    operationalDate: s.operationalDate,
    tz: s.tz,
    nota: s.nota,
    categoria: s.categoria,
    meta: s.meta,
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
    source: s.source,

    // identidad para UI/informes
    clienteId: s.clienteId,
    prestamoId: s.prestamoId,
    clienteNombre: s.clienteNombre,
  };

  const docRef = await addDoc(refCol, stripUndefined(payload));

  // ---- AUDIT
  await logAudit({
    userId: s.admin,
    action: 'create',
    ref: doc(db, 'cajaDiaria', docRef.id),
    before: null,
    after: pick(payload, ['tipo','admin','monto','operationalDate','tz','nota','categoria','meta','source','clienteId','prestamoId','clienteNombre']),
  });

  return docRef.id;
}

// =============== Escritura idempotente ===============
/**
 * Crea/actualiza un movimiento con ID fijo en 'cajaDiaria'.
 * - Si el documento ya existe (mismo docId), NO duplica (y no vuelve a auditar).
 * - Devuelve { created: boolean, id: string }
 * - Acepta tipos legacy y los mapea a canónicos.
 */
export async function addMovimientoIdempotente(
  _admin: string,
  data: Omit<MovimientoCaja, 'tipo' | 'admin' | 'createdAt' | 'createdAtMs' | 'source'> &
        { tipo: AnyMovimientoTipo; admin?: string; source?: MovimientoCaja['source'] },
  docId: string
): Promise<{ created: boolean; id: string }> {
  const ref = doc(db, 'cajaDiaria', docId);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    return { created: false, id: ref.id };
  }

  const s = sanitizeInput(_admin, data);

  const payload = {
    tipo: s.tip,                 // 👈 canónico
    admin: s.admin,
    monto: s.monto,
    operationalDate: s.operationalDate,
    tz: s.tz,
    nota: s.nota,
    categoria: s.categoria,
    meta: s.meta,
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
    source: s.source,

    // identidad para UI/informes
    clienteId: s.clienteId,
    prestamoId: s.prestamoId,
    clienteNombre: s.clienteNombre,
  };

  await setDoc(ref, stripUndefined(payload));

  // ---- AUDIT
  await logAudit({
    userId: s.admin,
    action: 'create',
    ref,
    before: null,
    after: pick(payload, ['tipo','admin','monto','operationalDate','tz','nota','categoria','meta','source','clienteId','prestamoId','clienteNombre']),
  });

  return { created: true, id: ref.id };
}

/**
 * ✅ Helper canónico para registrar un ABONO (desde outbox).
 * - Acepta 'pago' o 'abono' (alias legacy admitido).
 * - ID determinístico: 'ox_<outboxId>'.
 * - Escribe `clienteId`, `prestamoId`, `clienteNombre` en top-level (además de `meta`).
 */
export async function recordAbonoFromOutbox(params: {
  admin: string;
  outboxId: string;
  monto: number;
  operationalDate: string;
  tz: string;
  meta?: Record<string, any>;
  tipo?: 'pago' | 'abono';
}): Promise<{ created: boolean; id: string }> {
  const { admin, outboxId, monto, operationalDate, tz, meta, tipo = 'abono' } = params;

  // Extraer identidad útil (si vino en meta)
  const clienteId = meta?.clienteId ? String(meta.clienteId) : undefined;
  const prestamoId = meta?.prestamoId ? String(meta.prestamoId) : undefined;
  const clienteNombre = meta?.clienteNombre ? String(meta.clienteNombre) : undefined;

  return addMovimientoIdempotente(
    admin,
    {
      tipo,            // 'pago' → será mapeado a 'abono'
      monto,
      operationalDate,
      tz,
      meta: { fromOutboxId: outboxId, ...(meta || {}) },
      source: 'system',
      clienteId,
      prestamoId,
      clienteNombre,
    },
    `ox_${outboxId}`
  );
}

/**
 * ✅ Helper genérico para escribir en cajaDiaria con shape unificado.
 *    (Recomendado para reemplazar implementaciones locales como en ModalRegistroPago)
 */
export async function logToCajaDiaria(data: {
  tipo: AnyMovimientoTipo;
  admin: string;
  monto: number;
  operationalDate: string;
  tz: string;
  nota?: string | null;
  categoria?: string;
  meta?: Record<string, any>;
  source?: MovimientoCaja['source'];

  // identidad opcional
  clienteId?: string;
  prestamoId?: string;
  clienteNombre?: string;
}) {
  return addMovimiento(data.admin, data);
}

// =============== Lecturas ===============
// Nota: evitamos where('tipo'...) para no exigir índices y tolerar legacy.
// Leemos por admin+fecha y filtramos en memoria con canonicalTipo(...).

/** Gastos administrativos del día desde 'cajaDiaria' para un admin */
export async function fetchGastosAdminDelDia(admin: string, hoy: string) {
  const qy = query(
    collection(db, 'cajaDiaria'),
    where('admin', '==', admin),
    where('operationalDate', '==', hoy)
  );
  const snap = await getDocs(qy);

  const rows = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
  return rows
    .map(r => ({ ...r, tipo: (canonicalTipo((r as any).tipo) || (r as any).tipo) as MovimientoTipo }))
    .filter(r => canonicalTipo((r as any).tipo) === 'gasto_admin');
}

/** Gastos (del cobrador) del día desde 'cajaDiaria' para un admin */
export async function fetchGastosDelCobradorDelDia(admin: string, hoy: string) {
  const qy = query(
    collection(db, 'cajaDiaria'),
    where('admin', '==', admin),
    where('operationalDate', '==', hoy)
  );
  const snap = await getDocs(qy);

  const rows = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
  return rows
    .map(r => ({ ...r, tipo: (canonicalTipo((r as any).tipo) || (r as any).tipo) as MovimientoTipo }))
    .filter(r => canonicalTipo((r as any).tipo) === 'gasto_cobrador');
}
