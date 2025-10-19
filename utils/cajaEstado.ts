// utils/cajaEstado.ts
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
  collection, query, where, getDocs, addDoc, orderBy, limit,
  QueryConstraint,
} from 'firebase/firestore';
import { db } from '../firebase/firebaseConfig';
import { logAudit, pick } from './auditLogs';
import { canonicalTipo } from './movimientoHelper';
import { kpisDelDia, cajaFinalConBase } from './cajaResumen';
import { pickTZ } from './timezone';

export type CajaEstado = {
  saldoActual: number;
  updatedAt?: any;
  tz?: string | null;
};

type CierreDoc = {
  tipo: 'cierre';
  admin: string;
  balance: number;
  operationalDate: string;
  tz: string | null | undefined;
  createdAt: any;
  createdAtMs: number;
  source: 'auto' | 'manual' | 'system';
};

type AperturaDoc = {
  tipo: 'apertura';
  admin: string;
  monto: number;
  operationalDate: string;
  tz: string | null | undefined;
  createdAt: any;
  createdAtMs: number;
  source: 'auto' | 'manual' | 'system';
};

function prevDay(ymd: string): string {
  const [Y, M, D] = ymd.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(Y, M - 1, D));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Detecta si hubo APERTURA (aunque sea 0) en un día dado. */
async function existsApertura(admin: string, ymd: string, tenantId?: string | null): Promise<boolean> {
  const constraints: QueryConstraint[] = [
    where('admin', '==', admin),
    where('operationalDate', '==', ymd),
  ];
  if (tenantId) constraints.push(where('tenantId', '==', tenantId));

  const qHoy = query(collection(db, 'cajaDiaria'), ...constraints);
  const snap = await getDocs(qHoy);

  let ok = false;
  snap.forEach((d) => {
    const tip = canonicalTipo((d.data() as any)?.tipo);
    if (tip === 'apertura') ok = true;
  });
  return ok;
}

/** Caja inicial BASE = último CIERRE <= AYER (heredado). */
export async function getCajaInicialBase(
  admin: string,
  hoy: string,
  tenantId?: string | null,
): Promise<number> {
  const ayer = prevDay(hoy);

  // 1) Cierre idempotente preferido (exacto de AYER)
  try {
    const cierreIdem = await getDoc(doc(db, 'cajaDiaria', `cierre_${admin}_${ayer}`));
    if (cierreIdem.exists()) {
      const v = Number(cierreIdem.data()?.balance || 0);
      return Number.isFinite(v) ? v : 0;
    }
  } catch {}

  // 2) Último cierre “no idempotente” de AYER (compat)
  try {
    const constraints: QueryConstraint[] = [
      where('admin', '==', admin),
      where('operationalDate', '==', ayer),
      where('tipo', '==', 'cierre'),
      orderBy('createdAt', 'desc'),
      limit(1),
    ];
    if (tenantId) constraints.splice(1, 0, where('tenantId', '==', tenantId)); // después de admin

    const qAyer = query(collection(db, 'cajaDiaria'), ...constraints);
    const sA = await getDocs(qAyer);
    if (!sA.empty) {
      const v = Number(sA.docs[0].data()?.balance || 0);
      return Number.isFinite(v) ? v : 0;
    }
  } catch {}

  // 3) Buscar el ÚLTIMO cierre <= AYER (sin exigir índice; filtrado en cliente)
  try {
    const constraintsAll: QueryConstraint[] = [
      where('admin', '==', admin),
      where('tipo', '==', 'cierre'),
    ];
    if (tenantId) constraintsAll.splice(1, 0, where('tenantId', '==', tenantId));

    const qAll = query(collection(db, 'cajaDiaria'), ...constraintsAll);
    const s = await getDocs(qAll);

    let bestOp = ''; // YYYY-MM-DD
    let bestMs = -1;
    let bestBal = 0;

    s.forEach((d) => {
      const data: any = d.data();
      const op = String(data?.operationalDate || '');
      if (!op || op > ayer) return; // sólo <= AYER
      const ms =
        (typeof data?.createdAtMs === 'number' && data.createdAtMs) ||
        (typeof data?.createdAt?.seconds === 'number' && data.createdAt.seconds * 1000) ||
        0;
      const bal = Number(data?.balance || 0);
      if (!bestOp || op > bestOp || (op === bestOp && ms > bestMs)) {
        bestOp = op;
        bestMs = ms;
        bestBal = bal;
      }
    });

    if (bestOp) return bestBal;
  } catch {}

  // 4) Fallback: saldo persistente (RESPETA NEGATIVOS y 0)
  try {
    const estadoRef = doc(db, 'cajaEstado', admin);
    const estadoSnap = await getDoc(estadoRef);
    const sal = Number(estadoSnap.data()?.saldoActual ?? 0);
    return Number.isFinite(sal) ? sal : 0;
  } catch {
    return 0;
  }
}

// ———————————————————————————————————————————————
// Leer/actualizar estado persistente
// ———————————————————————————————————————————————
export async function getCajaEstado(admin: string): Promise<CajaEstado> {
  const ref = doc(db, 'cajaEstado', admin);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    const inicial: CajaEstado = { saldoActual: 0, tz: null };
    await setDoc(ref, { ...inicial, updatedAt: serverTimestamp() });

    await logAudit({
      userId: admin,
      action: 'create',
      ref,
      before: null,
      after: pick(inicial, ['saldoActual', 'tz']),
    });

    return inicial;
  }

  const data = snap.data() as any;
  return {
    saldoActual: Number(data?.saldoActual || 0),
    updatedAt: data?.updatedAt,
    tz: data?.tz ?? null,
  };
}

export async function setSaldoActual(admin: string, nuevoSaldo: number, tz?: string) {
  const safe = Number(nuevoSaldo);
  if (!Number.isFinite(safe)) {
    console.warn('[setSaldoActual] nuevoSaldo inválido:', nuevoSaldo);
    return;
  }
  const ref = doc(db, 'cajaEstado', admin);

  const prevSnap = await getDoc(ref);
  const before = prevSnap.exists()
    ? {
        saldoActual: Number(prevSnap.data()?.saldoActual || 0),
        tz: prevSnap.data()?.tz ?? null,
      }
    : null;

  const payload = {
    saldoActual: Math.round(safe * 100) / 100,
    tz: tz ?? null,
    updatedAt: serverTimestamp(),
  };

  await setDoc(ref, payload, { merge: true });

  await logAudit({
    userId: admin,
    action: 'caja_estado_update',
    ref,
    before,
    after: pick(payload, ['saldoActual', 'tz']),
  });
}

/** ==========================================================
 *  CIERRE IDEMPOTENTE
 *  - DocId determinístico: cierre_${admin}_${operationalDate}
 *  - Evita duplicados y arrastra saldo a cajaEstado
 * ========================================================== */
export async function ensureCierreIdempotente({
  admin,
  operationalDate,
  balance,
  tz,
  source = 'auto',
}: {
  admin: string;                 // 👈 pasa authAdminId
  operationalDate: string;       // YYYY-MM-DD
  balance: number;
  tz?: string | null;
  source?: 'auto' | 'manual' | 'system';
}) {
  const ref = doc(db, 'cajaDiaria', `cierre_${admin}_${operationalDate}`);

  const already = await getDoc(ref);
  if (already.exists()) {
    const bal = Number(already.data()?.balance ?? balance ?? 0);
    await setSaldoActual(admin, bal, tz ?? undefined);
    try {
      await updateDoc(doc(db, 'cajaEstado', admin), {
        lastCloseDate: operationalDate,
        lastCloseAt: serverTimestamp(),
      } as any);
    } catch {}
    return ref;
  }

  const payload: CierreDoc = {
    tipo: 'cierre',
    admin,
    balance: Math.round(Number(balance || 0) * 100) / 100,
    operationalDate,
    tz: tz ?? null,
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
    source,
  };

  await setDoc(ref, payload);

  await logAudit({
    userId: admin,
    action: 'caja_cierre_auto',
    ref,
    before: null,
    after: pick(payload, ['tipo', 'balance', 'operationalDate', 'tz', 'source']),
  });

  await setSaldoActual(admin, payload.balance, tz ?? undefined);
  try {
    await updateDoc(doc(db, 'cajaEstado', admin), {
      lastCloseDate: operationalDate,
      lastCloseAt: serverTimestamp(),
    } as any);
  } catch {}

  return ref;
}

export async function registrarCierre(
  admin: string,                 // 👈 pasa authAdminId
  hoy: string,
  balanceFinal: number,
  tz?: string
) {
  await ensureCierreIdempotente({
    admin,
    operationalDate: hoy,
    balance: balanceFinal,
    tz: tz ?? null,
    source: 'auto',
  });
}

/** -----------------------------------------------------------
 *  Cálculo “en vivo” de cajaFinal para un YYYY-MM-DD
 *  - Base: APERTURA si EXISTE (aunque sea 0) o CIERRE HEREDADO
 *  - Movimientos del día: SOLO desde cajaDiaria (kpisDelDia)
 * ----------------------------------------------------------- */
async function computeCajaFinalForDay(
  admin: string,
  ymd: string,
  tenantId?: string | null,
) {
  // kpisDelDia debe usar admin (authAdminId). Si soporta tenantId, pásalo aquí.
  const k = await kpisDelDia(admin, ymd /* , tenantId */);

  // Detectar si existió un documento de apertura (aunque el monto sea 0)
  const huboApertura = await existsApertura(admin, ymd, tenantId);

  // Base inicial derivada
  const baseInicial = huboApertura
    ? k.apertura
    : await getCajaInicialBase(admin, ymd, tenantId);

  // Caja final viva
  const cajaFinal = cajaFinalConBase(baseInicial, k);

  return {
    cajaInicial: baseInicial,
    cobrado: k.cobrado,
    ingresos: k.ingresos,
    retiros: k.retiros,
    gastosAdmin: k.gastosAdmin,
    gastosCobrador: k.gastosCobrador,
    prestamosDelDia: k.prestamos,
    cajaFinal,
  };
}

/** -----------------------------------------------------------
 *  Cierre automático de un día (idempotente) + arrastre
 * ----------------------------------------------------------- */
export async function autoCloseDay(
  admin: string,                 // 👈 authAdminId
  ymd: string,
  tz: string,
  tenantId?: string | null,
) {
  const ref = doc(db, 'cajaDiaria', `cierre_${admin}_${ymd}`);
  const ex = await getDoc(ref);
  if (ex.exists()) {
    const bal = Number(ex.data()?.balance ?? 0);
    await setSaldoActual(admin, bal, tz);
    try {
      await updateDoc(doc(db, 'cajaEstado', admin), {
        lastCloseDate: ymd,
        lastCloseAt: serverTimestamp(),
      } as any);
    } catch {}
    return;
  }

  const kpi = await computeCajaFinalForDay(admin, ymd, tenantId);
  await ensureCierreIdempotente({
    admin,
    operationalDate: ymd,
    balance: kpi.cajaFinal,
    tz,
    source: 'auto',
  });
}

/** -----------------------------------------------------------
 *  Actualiza EN VIVO cajaEstado.saldoActual con la “cajaFinal” parcial
 * ----------------------------------------------------------- */
export async function updateCajaEstadoLive(
  admin: string,                 // 👈 authAdminId
  ymd: string,
  tz: string,
  tenantId?: string | null,
) {
  const kpi = await computeCajaFinalForDay(admin, ymd, tenantId);
  await setSaldoActual(admin, kpi.cajaFinal, tz);
  try {
    await updateDoc(doc(db, 'cajaEstado', admin), {
      liveOperationalDate: ymd,
      liveUpdatedAt: serverTimestamp(),
      liveCobrado: kpi.cobrado,
      liveIngresos: kpi.ingresos,
      liveRetiros: kpi.retiros,
      liveGastosAdmin: kpi.gastosAdmin,
      liveGastosCobrador: kpi.gastosCobrador,
      livePrestamos: kpi.prestamosDelDia,
      liveCajaInicial: kpi.cajaInicial,
      liveCajaFinal: kpi.cajaFinal,
    } as any);
  } catch {}
}

/**
 * Cierra en CADENA todos los días pendientes (hasta N días atrás) ANTES de abrir HOY.
 * - Caja inicial de cada día = apertura del día (si existe) o cierre HEREDADO de AYER.
 * - Usa sólo `cajaDiaria` para KPIs (sin CG de préstamos).
 */
export async function closeMissingDays(
  admin: string,                 // 👈 authAdminId
  hoy: string,
  tz: string,
  maxDaysBack = 7,
  tenantId?: string | null,
) {
  const tzUse = pickTZ(tz);

  // Construye lista desde (hoy-1) hacia atrás
  const days: string[] = [];
  {
    const [Y, M, D] = hoy.split('-').map((n) => parseInt(n, 10));
    const base = new Date(Date.UTC(Y, M - 1, D));
    for (let i = 1; i <= maxDaysBack; i++) {
      const dt = new Date(base);
      dt.setUTCDate(dt.getUTCDate() - i);
      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const d = String(dt.getUTCDate()).padStart(2, '0');
      days.push(`${y}-${m}-${d}`);
    }
  }

  // Detecta qué días ya tienen "cierre"
  const missing: string[] = [];
  for (const ymd of days) {
    const ex = await getDoc(doc(db, 'cajaDiaria', `cierre_${admin}_${ymd}`));
    if (!ex.exists()) missing.push(ymd);
    else break; // desde aquí hacia atrás asumimos cadena consistente
  }

  // Procesa en orden cronológico (más antiguo → más reciente)
  missing.reverse();

  for (const ymd of missing) {
    // KPIs del día (filtra por admin internamente). Si kpisDelDia soporta tenantId, pásalo.
    const k = await kpisDelDia(admin, ymd /* , tenantId */);

    // Caja inicial derivada SIEMPRE (apertura si existe; si no, cierre heredado)
    const huboApertura = await existsApertura(admin, ymd, tenantId);
    const baseInicial = huboApertura ? k.apertura : await getCajaInicialBase(admin, ymd, tenantId);

    const cajaFinal = cajaFinalConBase(baseInicial, k);

    await ensureCierreIdempotente({
      admin,
      operationalDate: ymd,
      balance: cajaFinal,
      tz: tzUse,
      source: 'auto',
    });
  }
}

// ———————————————————————————————————————————————
// Asegura una "apertura" automática HOY (idempotente)
// ———————————————————————————————————————————————
export async function ensureAperturaDeHoy(
  admin: string,                 // 👈 authAdminId
  hoy: string,
  tz: string,
  tenantId?: string | null,
) {
  // Compat: si ya existe ALGUNA apertura hoy (cualquier id), no crear otra
  const constraints: QueryConstraint[] = [
    where('admin', '==', admin),
    where('operationalDate', '==', hoy),
  ];
  if (tenantId) constraints.push(where('tenantId', '==', tenantId));

  const qHoy = query(collection(db, 'cajaDiaria'), ...constraints);
  const snapHoy = await getDocs(qHoy);

  let yaHayApertura = false;
  snapHoy.forEach((d) => {
    const tip = canonicalTipo((d.data() as any)?.tipo);
    if (tip === 'apertura') yaHayApertura = true;
  });
  if (yaHayApertura) return;

  // Monto = cierre HEREDADO de AYER (respeta negativos y 0)
  const montoApertura = await getCajaInicialBase(admin, hoy, tenantId);
  if (!Number.isFinite(montoApertura)) return;

  const tzUse = pickTZ(tz);

  const aperturaPayload: AperturaDoc = {
    tipo: 'apertura',
    admin,
    monto: Math.round(Number(montoApertura || 0) * 100) / 100,
    operationalDate: hoy,
    tz: tzUse,
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
    source: 'auto',
  };

  const aperturaRef = await addDoc(collection(db, 'cajaDiaria'), aperturaPayload);

  await logAudit({
    userId: admin,
    action: 'caja_apertura_auto',
    ref: aperturaRef,
    before: null,
    after: pick(aperturaPayload, ['tipo', 'monto', 'operationalDate', 'tz', 'source']),
  });
}
