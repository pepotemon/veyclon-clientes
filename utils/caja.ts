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
  source?: 'manual' | 'auto' | 'system';
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
}) {
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

  const nota = (data.nota ?? '').toString().trim() || null;          // null OK en Firestore
  const categoria = (data.categoria ?? '').toString().trim() || undefined; // undefined será removido
  const meta = data.meta && typeof data.meta === 'object' ? data.meta : undefined;
  const source: MovimientoCaja['source'] = data.source || 'manual';

  return { tip, admin, monto, operationalDate, tz, nota, categoria, meta, source };
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
  };

  const docRef = await addDoc(refCol, stripUndefined(payload));

  // ---- AUDIT
  await logAudit({
    userId: s.admin,
    action: 'create',
    ref: doc(db, 'cajaDiaria', docRef.id),
    before: null,
    after: pick(payload, ['tipo','admin','monto','operationalDate','tz','nota','categoria','meta','source']),
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
  };

  await setDoc(ref, stripUndefined(payload));

  // ---- AUDIT
  await logAudit({
    userId: s.admin,
    action: 'create',
    ref,
    before: null,
    after: pick(payload, ['tipo','admin','monto','operationalDate','tz','nota','categoria','meta','source']),
  });

  return { created: true, id: ref.id };
}

/**
 * Helper para registrar un ABONO proveniente de la outbox:
 * - Acepta 'pago' o 'abono' (alias legacy admitido).
 * - ID determinístico: 'ox_<outboxId>'.
 * - Adjunta meta útil (clienteId, prestamoId, monto, etc.)
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

  // Mapear a canónico + reutilizar saneo
  const { tip, admin: adm, monto: m, operationalDate: od, tz: tzOk } = sanitizeInput(admin, {
    tipo,
    admin,
    monto,
    operationalDate,
    tz,
    meta,
    source: 'system',
  });

  return addMovimientoIdempotente(
    adm,
    {
      tipo: tip,        // 'abono' canónico
      monto: m,
      operationalDate: od,
      tz: tzOk,
      meta: { fromOutboxId: outboxId, ...(meta || {}) },
      source: 'system',
    },
    `ox_${outboxId}`
  );
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

  const rows = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as MovimientoCaja[];
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

  const rows = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as MovimientoCaja[];
  return rows
    .map(r => ({ ...r, tipo: (canonicalTipo((r as any).tipo) || (r as any).tipo) as MovimientoTipo }))
    .filter(r => canonicalTipo((r as any).tipo) === 'gasto_cobrador');
}
