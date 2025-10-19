// utils/cajaManual.ts
import NetInfo from '@react-native-community/netinfo';
import { addMovimientoIdempotente } from './caja';
import { pickTZ, todayInTZ, normYYYYMMDD } from './timezone';
import { addToOutbox } from './outbox';

/** Payload común sin admin (admin va por argumento) */
type BaseNoAdmin = {
  operationalDate: string; // YYYY-MM-DD (si no viene válida, se usa hoy en tz)
  tz: string;              // IANA TZ
  nota?: string | null;
};

async function isOnline(): Promise<boolean> {
  try {
    const s = await NetInfo.fetch();
    return !!(s?.isInternetReachable ?? s?.isConnected);
  } catch {
    // Si NetInfo falla, intentamos como si hubiera red (y si la escritura falla, encolamos)
    return true;
  }
}

/**
 * APERTURA MANUAL del día (canónico: 'apertura').
 * - Crea doc idempotente en 'cajaDiaria' con id: `ap_<admin>_<YYYY-MM-DD>`.
 * - NO toca cajaEstado (eso lo hace DefinirCajaScreen con setSaldoActual).
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
  const docId = `ap_${admin}_${op}`; // idempotente por admin+fecha

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
 * Movimiento MANUAL de caja (canónico: 'ingreso' | 'retiro').
 * - Online: escribe idempotente en 'cajaDiaria'.
 * - Offline: encola en outbox (kind 'otro', subkind ingreso/retiro) con MISMO docId.
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
          tipo: data.tipo,
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
      // si algo falla en caliente, encolamos abajo
    }
  }

  await addToOutbox({
    kind: 'otro',
    payload: {
      admin,
      subkind: data.tipo, // 'ingreso' | 'retiro'
      monto: data.monto,
      operationalDate: op,
      tz: tzOk,
      nota: (data.nota ?? '').trim() || null,
      docId, // ← idempotencia del worker
    },
  });

  return 'queued';
}

/**
 * GASTO ADMINISTRATIVO (canónico: 'gasto_admin').
 * - Online: escribe idempotente.
 * - Offline: encola con subkind 'gasto_admin' y MISMO docId.
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
      // fallback → outbox
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
 * GASTO DEL COBRADOR (canónico: 'gasto_cobrador').
 * - Online: escribe idempotente.
 * - Offline: encola con subkind 'gasto_cobrador' y MISMO docId.
 * - Este rubro es informativo (no entra al cierre).
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
      // fallback → outbox
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
