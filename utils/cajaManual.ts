// utils/cajaManual.ts
import NetInfo from '@react-native-community/netinfo';
import { addMovimientoIdempotente } from './caja';
import { pickTZ, todayInTZ, normYYYYMMDD } from './timezone';
import { addToOutbox } from './outbox';

/**
 * Estructura base SIN 'admin' (admin se pasa como 1er argumento).
 */
type BaseNoAdmin = {
  operationalDate: string; // 'YYYY-MM-DD'
  tz: string;
  nota?: string | null;
};

async function isOnline(): Promise<boolean> {
  try {
    const s = await NetInfo.fetch();
    return !!(s?.isInternetReachable ?? s?.isConnected);
  } catch {
    // si NetInfo falla, asumimos online para intentar directo (y si falla, encolamos en catch)
    return true;
  }
}

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
 * - Si hay conexión → escribe directo en 'cajaDiaria' (idempotente con docId).
 * - Si NO hay conexión → encola en outbox (kind 'otro', subkind ingreso/retiro) con el MISMO docId.
 * - Devuelve un ID del doc creado si es online, o 'queued' si se encola.
 */
export async function addMovimientoManual(
  admin: string,
  data: BaseNoAdmin & { tipo: 'ingreso' | 'retiro'; monto: number },
): Promise<string> {
  const tzOk = pickTZ(data.tz);
  const op = normYYYYMMDD(data.operationalDate) || todayInTZ(tzOk);
  const docId = `mov_${admin}_${data.tipo}_${op}_${Date.now()}`;

  if (await isOnline()) {
    try {
      const res = await addMovimientoIdempotente(
        admin,
        {
          tipo: data.tipo, // canónico
          monto: data.monto,
          operationalDate: op,
          tz: tzOk,
          nota: (data.nota ?? '').trim() || undefined,
          source: 'manual',
        },
        docId
      );
      return res.id;
    } catch {
      // caída en medio → encolar
    }
  }

  // Offline → encolar como 'otro' con subkind ingreso/retiro + docId para idempotencia del worker
  await addToOutbox({
    kind: 'otro',
    payload: {
      admin,
      subkind: data.tipo, // 'ingreso' | 'retiro'
      monto: data.monto,
      operationalDate: op,
      tz: tzOk,
      nota: (data.nota ?? '').trim() || null,
      docId,
    },
  });
  return 'queued';
}

/**
 * Registra un GASTO ADMINISTRATIVO.
 * - Tipo canónico: 'gasto_admin'
 * - Este SÍ se incluye en el cierre.
 * - Online → escribe (idempotente); Offline → encola (kind 'otro', subkind 'gasto_admin') con el MISMO docId.
 */
export async function addGastoAdmin(
  admin: string,
  data: BaseNoAdmin & { categoria?: string; monto: number },
): Promise<string> {
  const tzOk = pickTZ(data.tz);
  const op = normYYYYMMDD(data.operationalDate) || todayInTZ(tzOk);
  const categoria = (data.categoria ?? '').trim() || 'Gasto admin';
  const nota = (data.nota ?? '').trim() || undefined;
  const docId = `ga_${admin}_${op}_${Date.now()}`;

  if (await isOnline()) {
    try {
      const res = await addMovimientoIdempotente(
        admin,
        {
          tipo: 'gasto_admin',
          monto: data.monto,
          operationalDate: op,
          tz: tzOk,
          categoria,
          nota,
          source: 'manual',
        },
        docId
      );
      return res.id;
    } catch {
      // si falla, encolamos
    }
  }

  await addToOutbox({
    kind: 'otro',
    payload: {
      admin,
      subkind: 'gasto_admin',
      monto: data.monto,
      operationalDate: op,
      tz: tzOk,
      categoria,
      nota: nota ?? null,
      docId,
    },
  });
  return 'queued';
}

/**
 * Registra un GASTO DEL COBRADOR.
 * - Tipo canónico: 'gasto_cobrador'
 * - Este NO se incluye en el cierre (solo informativo para el cobrador).
 * - Online → escribe (idempotente); Offline → encola (kind 'otro', subkind 'gasto_cobrador') con el MISMO docId.
 */
export async function addGastoCobrador(
  admin: string,
  data: BaseNoAdmin & { categoria?: string; monto: number },
): Promise<string> {
  const tzOk = pickTZ(data.tz);
  const op = normYYYYMMDD(data.operationalDate) || todayInTZ(tzOk);
  const categoria = (data.categoria ?? '').trim() || 'Gasto cobrador';
  const nota = (data.nota ?? '').trim() || undefined;
  const docId = `gc_${admin}_${op}_${Date.now()}`;

  if (await isOnline()) {
    try {
      const res = await addMovimientoIdempotente(
        admin,
        {
          tipo: 'gasto_cobrador',
          monto: data.monto,
          operationalDate: op,
          tz: tzOk,
          categoria,
          nota,
          source: 'manual',
        },
        docId
      );
      return res.id;
    } catch {
      // si falla, encolamos
    }
  }

  await addToOutbox({
    kind: 'otro',
    payload: {
      admin,
      subkind: 'gasto_cobrador',
      monto: data.monto,
      operationalDate: op,
      tz: tzOk,
      categoria,
      nota: nota ?? null,
      docId,
    },
  });
  return 'queued';
}
