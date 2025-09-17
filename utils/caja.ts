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
  DocumentReference,
} from 'firebase/firestore';
import { db } from '../firebase/firebaseConfig';
import { logAudit, pick } from './auditLogs';

// 👇 Fase 2: tipos e intérprete canónico
import {
  canonicalTipo,
  type MovimientoTipo,
} from './movimientoHelper';

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

// =============== Escritura clásica (no idempotente) ===============
/** Escribe un movimiento en 'cajaDiaria'. Acepta tipos legacy y los mapea a canónicos. */
export async function addMovimiento(
  _admin: string,
  data: Omit<MovimientoCaja, 'tipo' | 'admin' | 'createdAt' | 'createdAtMs' | 'source'> &
        { tipo: AnyMovimientoTipo; admin?: string; source?: MovimientoCaja['source'] }
) {
  const refCol = collection(db, 'cajaDiaria');
  const tip = canonicalTipo(data.tipo as string);
  if (!tip) throw new Error(`Tipo de movimiento inválido: ${data.tipo}`);

  const payload = {
    ...data,
    tipo: tip, // 👈 siempre canónico
    admin: data.admin || _admin,
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
    source: data.source || 'manual',
  };

  const docRef = await addDoc(refCol, payload);

  // ---- AUDIT
  await logAudit({
    userId: _admin,
    action: 'create',
    ref: doc(db, 'cajaDiaria', docRef.id),
    before: null,
    after: {
      ...pick(payload, ['tipo', 'admin', 'monto', 'operationalDate', 'tz', 'nota', 'categoria', 'meta', 'source']),
    },
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

  const tip = canonicalTipo(data.tipo as string);
  if (!tip) throw new Error(`Tipo de movimiento inválido: ${data.tipo}`);

  const payload = {
    ...data,
    tipo: tip, // 👈 canónico
    admin: data.admin || _admin,
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
    source: data.source || 'manual',
  };

  await setDoc(ref, payload);

  // ---- AUDIT
  await logAudit({
    userId: _admin,
    action: 'create',
    ref,
    before: null,
    after: {
      ...pick(payload, ['tipo', 'admin', 'monto', 'operationalDate', 'tz', 'nota', 'categoria', 'meta', 'source']),
    },
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

  // Mapear a canónico
  const tip = canonicalTipo(tipo);
  if (!tip) throw new Error(`Tipo inválido para outbox: ${tipo}`);

  return addMovimientoIdempotente(
    admin,
    {
      tipo: tip, // 'abono' canónico
      monto: Number(monto),
      operationalDate,
      tz,
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
