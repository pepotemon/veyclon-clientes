// utils/cajaManual.ts
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase/firebaseConfig';
import { logAudit, pick } from './auditLogs';

/**
 * Estructura base SIN 'admin' (admin se pasa como 1er argumento).
 */
type BaseNoAdmin = {
  operationalDate: string; // 'YYYY-MM-DD'
  tz: string;
  nota?: string | null;
};

function normMonto(n: number): number {
  const x = Number(n || 0);
  if (!Number.isFinite(x) || x < 0) return 0;
  return Math.round(x * 100) / 100;
}

/**
 * Registra una APERTURA manual del día (tipo canónico: 'apertura').
 * - Escribe un documento en 'cajaDiaria'
 * - Deja rastro en 'auditLogs' (caja_apertura)
 * - Devuelve el ID del documento creado
 */
export async function setCajaInicial(
  admin: string,
  monto: number,
  operationalDate: string,
  tz: string,
  nota?: string,
): Promise<string> {
  const payload = {
    tipo: 'apertura' as const, // canónico
    admin,
    monto: normMonto(monto),
    operationalDate,
    tz,
    nota: (nota ?? '').trim() ? nota!.trim() : null,
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
    source: 'manual' as const,
  };

  const ref = await addDoc(collection(db, 'cajaDiaria'), payload);

  await logAudit({
    userId: admin,
    action: 'caja_apertura',
    ref,
    before: null,
    after: pick(payload, ['tipo','admin','monto','operationalDate','tz','nota','source']),
  });

  return ref.id;
}

/**
 * Registra un movimiento MANUAL de 'ingreso' o 'retiro' (tipos canónicos).
 * - Escribe un documento en 'cajaDiaria'
 * - Deja rastro en 'auditLogs' (caja_ingreso / caja_retiro)
 * - Devuelve el ID del documento creado
 */
export async function addMovimientoManual(
  admin: string,
  data: BaseNoAdmin & { tipo: 'ingreso' | 'retiro'; monto: number },
): Promise<string> {
  const payload = {
    tipo: data.tipo, // 'ingreso' | 'retiro' (canónicos)
    admin,
    monto: normMonto(data.monto),
    operationalDate: data.operationalDate,
    tz: data.tz,
    nota: (data.nota ?? '').trim() ? data.nota!.trim() : null,
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
    source: 'manual' as const,
  };

  const ref = await addDoc(collection(db, 'cajaDiaria'), payload);

  await logAudit({
    userId: admin,
    action: data.tipo === 'ingreso' ? 'caja_ingreso' : 'caja_retiro',
    ref,
    before: null,
    after: pick(payload, ['tipo','admin','monto','operationalDate','tz','nota','source']),
  });

  return ref.id;
}

/**
 * (Opcional) Registra un GASTO ADMINISTRATIVO.
 * - Tipo canónico: 'gasto_admin'
 * - Este SÍ se incluye en el cierre.
 */
export async function addGastoAdmin(
  admin: string,
  data: BaseNoAdmin & { categoria?: string; monto: number },
): Promise<string> {
  const payload = {
    tipo: 'gasto_admin' as const, // canónico (cuenta en cierre)
    admin,
    categoria: (data.categoria ?? '').trim() || 'Gasto admin',
    monto: normMonto(data.monto),
    operationalDate: data.operationalDate,
    tz: data.tz,
    nota: (data.nota ?? '').trim() ? data.nota!.trim() : null,
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
    source: 'manual' as const,
  };

  const ref = await addDoc(collection(db, 'cajaDiaria'), payload);

  await logAudit({
    userId: admin,
    action: 'caja_gasto_admin',
    ref,
    before: null,
    after: pick(payload, ['tipo','admin','categoria','monto','operationalDate','tz','nota','source']),
  });

  return ref.id;
}

/**
 * (Opcional) Registra un GASTO DEL COBRADOR.
 * - Tipo canónico: 'gasto_cobrador'
 * - Este NO se incluye en el cierre (solo se lista en pantallas del cobrador).
 */
export async function addGastoCobrador(
  admin: string,
  data: BaseNoAdmin & { categoria?: string; monto: number },
): Promise<string> {
  const payload = {
    tipo: 'gasto_cobrador' as const, // canónico (no cuenta en cierre)
    admin,
    categoria: (data.categoria ?? '').trim() || 'Gasto cobrador',
    monto: normMonto(data.monto),
    operationalDate: data.operationalDate,
    tz: data.tz,
    nota: (data.nota ?? '').trim() ? data.nota!.trim() : null,
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
    source: 'cobrador' as const,
  };

  const ref = await addDoc(collection(db, 'cajaDiaria'), payload);

  await logAudit({
    userId: admin,
    action: 'caja_gasto',
    ref,
    before: null,
    after: pick(payload, ['tipo','admin','categoria','monto','operationalDate','tz','nota','source']),
  });

  return ref.id;
}
