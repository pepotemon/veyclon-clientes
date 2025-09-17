// utils/cajaManual.ts
import { addMovimiento, addMovimientoIdempotente } from './caja';
import { pickTZ, todayInTZ, normYYYYMMDD } from './timezone';

/**
 * Estructura base SIN 'admin' (admin se pasa como 1er argumento).
 */
type BaseNoAdmin = {
  operationalDate: string; // 'YYYY-MM-DD'
  tz: string;
  nota?: string | null;
};

/**
 * Registra una APERTURA manual del día (tipo canónico: 'apertura').
 * - Escribe un documento en 'cajaDiaria' (idempotente por admin+fecha).
 * - NO modifica cajaEstado.saldoActual (eso se hace en DefinirCajaScreen con setSaldoActual).
 * - Devuelve el ID del documento creado (o existente).
 */
export async function setCajaInicial(
  admin: string,
  monto: number,
  operationalDate: string,
  tz: string,
  nota?: string,
): Promise<string> {
  const tzOk = pickTZ(tz);
  const op = normYYYYMMDD(operationalDate) || todayInTZ(tzOk);

  // Id determinístico → evita aperturas duplicadas el mismo día
  const docId = `ap_${admin}_${op}`;

  const res = await addMovimientoIdempotente(
    admin,
    {
      tipo: 'apertura',
      monto,
      operationalDate: op,
      tz: tzOk,
      nota: (nota ?? '').trim() || undefined,
      source: 'manual',
    },
    docId
  );

  return res.id;
}

/**
 * Registra un movimiento MANUAL de 'ingreso' o 'retiro' (tipos canónicos).
 * - Escribe un documento en 'cajaDiaria'
 * - Devuelve el ID del documento creado
 */
export async function addMovimientoManual(
  admin: string,
  data: BaseNoAdmin & { tipo: 'ingreso' | 'retiro'; monto: number },
): Promise<string> {
  const tzOk = pickTZ(data.tz);
  const op = normYYYYMMDD(data.operationalDate)!;

  return addMovimiento(admin, {
    tipo: data.tipo, // canónico
    monto: data.monto,
    operationalDate: op,
    tz: tzOk,
    nota: (data.nota ?? '').trim() || undefined,
    source: 'manual',
  });
}

/**
 * Registra un GASTO ADMINISTRATIVO.
 * - Tipo canónico: 'gasto_admin'
 * - Este SÍ se incluye en el cierre.
 */
export async function addGastoAdmin(
  admin: string,
  data: BaseNoAdmin & { categoria?: string; monto: number },
): Promise<string> {
  const tzOk = pickTZ(data.tz);
  const op = normYYYYMMDD(data.operationalDate)!;

  return addMovimiento(admin, {
    tipo: 'gasto_admin',
    monto: data.monto,
    operationalDate: op,
    tz: tzOk,
    categoria: (data.categoria ?? '').trim() || 'Gasto admin',
    nota: (data.nota ?? '').trim() || undefined,
    source: 'manual',
  });
}

/**
 * Registra un GASTO DEL COBRADOR.
 * - Tipo canónico: 'gasto_cobrador'
 * - Este NO se incluye en el cierre (solo informativo para el cobrador).
 */
export async function addGastoCobrador(
  admin: string,
  data: BaseNoAdmin & { categoria?: string; monto: number },
): Promise<string> {
  const tzOk = pickTZ(data.tz);
  const op = normYYYYMMDD(data.operationalDate)!;

  return addMovimiento(admin, {
    tipo: 'gasto_cobrador',
    monto: data.monto,
    operationalDate: op,
    tz: tzOk,
    categoria: (data.categoria ?? '').trim() || 'Gasto cobrador',
    nota: (data.nota ?? '').trim() || undefined,
    source: 'manual',
  });
}
