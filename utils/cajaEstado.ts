// utils/cajaEstado.ts
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
  collection, query, where, getDocs, addDoc, orderBy, limit,
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

/** Tipos de documentos en cajaDiaria (payloads) */
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

/** Caja inicial BASE = CIERRE DE AYER (compat: usa cajaEstado.saldoActual si > 0). */
export async function getCajaInicialBase(admin: string, hoy: string): Promise<number> {
  const ayer = prevDay(hoy);

  // 1) Cierre idempotente preferido
  const cierreIdem = await getDoc(doc(db, 'cajaDiaria', `cierre_${admin}_${ayer}`));
  if (cierreIdem.exists()) {
    const v = Number(cierreIdem.data()?.balance || 0);
    return Number.isFinite(v) ? v : 0;
  }

  // 2) Último cierre "no idempotente" de AYER
  const qAyer = query(
    collection(db, 'cajaDiaria'),
    where('admin', '==', admin),
    where('operationalDate', '==', ayer),
    where('tipo', '==', 'cierre'),
    orderBy('createdAt', 'desc'),
    limit(1)
  );
  const sA = await getDocs(qAyer);
  if (!sA.empty) {
    const v = Number(sA.docs[0].data()?.balance || 0);
    return Number.isFinite(v) ? v : 0;
  }

  // 3) Fallback: saldo persistente (> 0) o 0
  const estadoRef = doc(db, 'cajaEstado', admin);
  const estadoSnap = await getDoc(estadoRef);
  const sal = Number(estadoSnap.data()?.saldoActual || 0);
  return Number.isFinite(sal) && sal > 0 ? sal : 0;
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
  admin: string;
  operationalDate: string; // YYYY-MM-DD
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

  // arrastre
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
  admin: string,
  hoy: string,          // 'YYYY-MM-DD'
  balanceFinal: number, // saldo final calculado
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
 *  - Base: apertura del día (si existe) o CIERRE DE AYER
 *  - Movimientos del día: SOLO desde cajaDiaria (kpisDelDia)
 * ----------------------------------------------------------- */
async function computeCajaFinalForDay(admin: string, ymd: string) {
  // KPIs del día (solo cajaDiaria)
  const k = await kpisDelDia(admin, ymd);

  // Base inicial derivada: apertura si existe; si no, cierre de AYER
  const baseInicial = k.apertura > 0 ? k.apertura : await getCajaInicialBase(admin, ymd);

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
export async function autoCloseDay(admin: string, ymd: string, tz: string) {
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

  const kpi = await computeCajaFinalForDay(admin, ymd);
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
export async function updateCajaEstadoLive(admin: string, ymd: string, tz: string) {
  const kpi = await computeCajaFinalForDay(admin, ymd);
  await setSaldoActual(admin, kpi.cajaFinal, tz);
  // (opcional) meta info para debug/monitor
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
 * - Caja inicial de cada día = apertura del día (si existe) o cierre de AYER.
 * - Usa sólo `cajaDiaria` para KPIs (sin CG de préstamos).
 */
export async function closeMissingDays(
  admin: string,
  hoy: string,
  tz: string,
  maxDaysBack = 7
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
    // KPIs del día (solo cajaDiaria)
    const k = await kpisDelDia(admin, ymd);

    // ¿Hubo algo ese día? (sin contar apertura)
    const huboAlgo = [k.ingresos, k.cobrado, k.retiros, k.gastosAdmin, k.gastosCobrador, k.prestamos]
      .some((v) => Number(v) > 0);
    if (!huboAlgo) continue;

    // Caja inicial derivada
    const baseInicial = k.apertura > 0 ? k.apertura : await getCajaInicialBase(admin, ymd);

    // Caja final
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
export async function ensureAperturaDeHoy(admin: string, hoy: string, tz: string) {
  // Compat: si ya existe ALGUNA apertura hoy (cualquier id), no crear otra
  const qHoy = query(
    collection(db, 'cajaDiaria'),
    where('admin', '==', admin),
    where('operationalDate', '==', hoy)
  );
  const snapHoy = await getDocs(qHoy);
  let yaHayApertura = false;
  snapHoy.forEach((d) => {
    const tip = canonicalTipo((d.data() as any)?.tipo);
    if (tip === 'apertura') yaHayApertura = true;
  });
  if (yaHayApertura) return;

  // Monto = cierre de AYER (o saldo persistente > 0)
  const montoApertura = await getCajaInicialBase(admin, hoy);
  if (!Number.isFinite(montoApertura)) return;

  const aperturaPayload: AperturaDoc = {
    tipo: 'apertura',
    admin,
    monto: Math.round(Number(montoApertura || 0) * 100) / 100,
    operationalDate: hoy,
    tz,
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
