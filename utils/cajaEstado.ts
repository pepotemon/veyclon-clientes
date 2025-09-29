// utils/cajaEstado.ts
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
  collection, query, where, getDocs, addDoc, collectionGroup,
  orderBy, limit,
} from 'firebase/firestore';
import { db } from '../firebase/firebaseConfig';
import { logAudit, pick } from './auditLogs';
import { canonicalTipo } from './movimientoHelper';
import { fetchCajaResumen } from './cajaResumen';
import { pickTZ, toYYYYMMDDInTZ, normYYYYMMDD } from './timezone';

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
  source: 'auto' | 'manual';
};

type AperturaDoc = {
  tipo: 'apertura';
  admin: string;
  monto: number;
  operationalDate: string;
  tz: string | null | undefined;
  createdAt: any;
  createdAtMs: number;
  source: 'auto' | 'manual';
};

// ——————————— Helpers de fecha ———————————
function ymdFromAny(input: any, tz?: string): string {
  const tzUse = pickTZ(tz);
  if (!input) return '';
  // número (ms)
  if (typeof input === 'number') return toYYYYMMDDInTZ(input, tzUse);
  // Date
  if (input instanceof Date) return toYYYYMMDDInTZ(input, tzUse);
  // Firestore Timestamp-like
  if (typeof input === 'object') {
    if (typeof (input as any).toDate === 'function') {
      return toYYYYMMDDInTZ((input as any).toDate(), tzUse);
    }
    if (typeof (input as any).seconds === 'number') {
      return toYYYYMMDDInTZ((input as any).seconds * 1000, tzUse);
    }
  }
  // string
  if (typeof input === 'string') {
    const direct = normYYYYMMDD(input);
    if (direct) return direct;
    const d = new Date(input);
    if (!isNaN(d.getTime())) return toYYYYMMDDInTZ(d, tzUse);
  }
  return '';
}

function prevDay(ymd: string): string {
  const [Y, M, D] = ymd.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(Y, M - 1, D));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Caja inicial para un día YMD = CIERRE DEL DÍA ANTERIOR (fallback a saldo persistente si no existe cierre). */
async function getCajaInicialParaHoy(admin: string, hoy: string, tz: string): Promise<number> {
  const ayer = prevDay(hoy);

  // 1) Cierre idempotente
  const cierreIdem = await getDoc(doc(db, 'cajaDiaria', `cierre_${admin}_${ayer}`));
  if (cierreIdem.exists()) return Number(cierreIdem.data()?.balance || 0);

  // 2) Último cierre no idempotente de AYER
  const qAyer = query(
    collection(db, 'cajaDiaria'),
    where('admin', '==', admin),
    where('operationalDate', '==', ayer),
    where('tipo', '==', 'cierre'),
    orderBy('createdAt', 'desc'),
    limit(1)
  );
  const sA = await getDocs(qAyer);
  if (!sA.empty) return Number(sA.docs[0].data()?.balance || 0);

  // 3) Fallback final: saldo persistente (>0) o 0
  const est = await getCajaEstado(admin);
  const sal = Number(est.saldoActual || 0);
  return Number.isFinite(sal) && sal > 0 ? sal : 0;
}

// ———————————————————————————————————————————————
// Leer estado persistente
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

// ———————————————————————————————————————————————
// Actualizar saldo persistente (desde CIERRE o acción explícita)
// ———————————————————————————————————————————————
export async function setSaldoActual(admin: string, nuevoSaldo: number, tz?: string) {
  const safe = Number(nuevoSaldo);
  if (!Number.isFinite(safe)) {
    console.warn('[setSaldoActual] nuevoSaldo inválido, no se actualiza:', nuevoSaldo);
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
 *  - Evita duplicados y marca source (auto/manual)
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
  source?: 'auto' | 'manual';
}) {
  const ref = doc(db, 'cajaDiaria', `cierre_${admin}_${operationalDate}`);

  const already = await getDoc(ref);
  if (already.exists()) {
    // Ya existe: arrastra y marca lastClose*
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
    source: source,
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

/**
 * ——————————————————————————————————————————————
 * Crea (idempotente) el CIERRE del día y ACTUALIZA cajaEstado.saldoActual
 * ——————————————————————————————————————————————
 */
export async function registrarCierre(
  admin: string,
  hoy: string,            // 'YYYY-MM-DD' del día que cierras
  balanceFinal: number,   // saldo final calculado del día
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
 *  - Base: **CIERRE DE AYER** (caja inicial estática)
 *  - Movimientos del día: ingresos, retiros, abonos, gasto_admin
 *  - Préstamos del día (capital)
 * ----------------------------------------------------------- */
async function computeCajaFinalForDay(admin: string, ymd: string, tz: string) {
  // 0) Caja inicial = CIERRE DE AYER (no se mueve en el día)
  const cajaInicial = await getCajaInicialParaHoy(admin, ymd, tz);

  // 1) Movimientos del día (ignoramos apertura/cierre)
  let cobrado = 0, ingresos = 0, retiros = 0, gastosAdmin = 0;
  {
    const qD = query(
      collection(db, 'cajaDiaria'),
      where('admin', '==', admin),
      where('operationalDate', '==', ymd)
    );
    const s = await getDocs(qD);
    s.forEach((d) => {
      const data = d.data() as any;
      const tip = canonicalTipo(data?.tipo);
      const m = Number(data?.monto ?? data?.balance ?? 0) || 0;
      switch (tip) {
        case 'abono': cobrado += m; break;
        case 'ingreso': ingresos += m; break;
        case 'retiro': retiros += m; break;
        case 'gasto_admin': gastosAdmin += m; break;
        default: break; // apertura/cierre u otros
      }
    });
  }

  // 2) Préstamos creados HOY (capital)
  let prestamosDelDia = 0;
  try {
    const qP = query(collectionGroup(db, 'prestamos'), where('creadoPor', '==', admin));
    const s = await getDocs(qP);
    s.forEach((d) => {
      const p: any = d.data();
      if (p?.estado && p.estado !== 'activo') return;
      const tzP = pickTZ(p?.tz, tz);
      const createdAny = typeof p?.createdAtMs === 'number' ? p.createdAtMs : (p?.createdAt ?? p?.fechaInicio);
      const diaP = ymdFromAny(createdAny, tzP);
      if (diaP !== ymd) return;
      const capital = Number(p?.valorNeto ?? p?.capital ?? 0);
      if (Number.isFinite(capital) && capital > 0) prestamosDelDia += capital;
    });
  } catch (e) {
    console.warn('[computeCajaFinalForDay] prestamos cg error:', e);
    prestamosDelDia = 0;
  }

  // 3) Caja final viva de HOY
  const cajaFinal = Math.round((cajaInicial + ingresos + cobrado - retiros - gastosAdmin - prestamosDelDia) * 100) / 100;

  return { cajaInicial, cobrado, ingresos, retiros, gastosAdmin, prestamosDelDia, cajaFinal };
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

  const kpi = await computeCajaFinalForDay(admin, ymd, tz);
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
  const kpi = await computeCajaFinalForDay(admin, ymd, tz);
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
      livePrestamos: kpi.prestamosDelDia,
      liveCajaInicial: kpi.cajaInicial,
      liveCajaFinal: kpi.cajaFinal,
    } as any);
  } catch {}
}

/**
 * Cierra en CADENA todos los días pendientes (hasta N días atrás) ANTES de abrir HOY.
 * - Caja inicial de cada día = CIERRE DEL DÍA ANTERIOR.
 * - Si no hubo NADA ese día, NO crea cierre (evita ruido).
 */
export async function closeMissingDays(
  admin: string,
  hoy: string,
  tz: string,
  maxDaysBack = 7
) {
  const tzUse = pickTZ(tz);

  // Construye lista YYYY-MM-DD desde (hoy-1) hacia atrás
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
    // 1) KPIs del día desde cajaDiaria
    const r = await fetchCajaResumen(admin, ymd);

    // 2) Préstamos del día (capital) por fecha de creación
    let prestamosDelDia = 0;
    try {
      const qP = query(collectionGroup(db, 'prestamos'), where('creadoPor', '==', admin));
      const sg = await getDocs(qP);
      sg.forEach((d) => {
        const p = d.data() as any;
        const tzP = pickTZ(p?.tz, tzUse);
        const startYmd =
          ymdFromAny(p?.createdAtMs, tzP) ||
          ymdFromAny(p?.createdAt, tzP) ||
          ymdFromAny(p?.fechaInicio, tzP);
        if (startYmd === ymd) {
          const capital = Number(p?.valorNeto ?? p?.capital ?? 0);
          if (Number.isFinite(capital) && capital > 0) prestamosDelDia += capital;
        }
      });
    } catch (e) {
      console.warn('[closeMissingDays] prestamos cg error:', e);
      prestamosDelDia = 0;
    }

    // 3) ¿Hubo algo ese día?
    const huboAlgo = [r.ingresos, r.abonos, r.retiros, r.gastos, prestamosDelDia]
      .some((v) => Number(v) > 0);
    if (!huboAlgo) continue;

    // 4) Caja inicial del día = cierre de ayer (del propio ymd)
    const cajaInicialDelDia = await getCajaInicialParaHoy(admin, ymd, tzUse);

    // 5) Caja final del día
    const cajaFinal = Math.round(
      (cajaInicialDelDia + r.ingresos + r.abonos - r.retiros - r.gastos - prestamosDelDia) * 100
    ) / 100;

    await registrarCierre(admin, ymd, cajaFinal, tzUse); // idempotente + arrastre
  }
}

// ———————————————————————————————————————————————
// Asegura una "apertura" automática HOY:
// 1) Si existe apertura HOY → no hace nada.
// 2) Si no, usa CIERRE de AYER; si no hay, usa cajaEstado (si > 0).
// ———————————————————————————————————————————————
export async function ensureAperturaDeHoy(admin: string, hoy: string, tz: string) {
  // ¿Ya existe una apertura hoy?
  const qHoy = query(
    collection(db, 'cajaDiaria'),
    where('admin', '==', admin),
    where('operationalDate', '==', hoy),
  );
  const snapHoy = await getDocs(qHoy);

  let yaHayApertura = false;
  snapHoy.forEach((d) => {
    const tip = canonicalTipo((d.data() as any)?.tipo);
    if (tip === 'apertura') yaHayApertura = true;
  });
  if (yaHayApertura) return;

  const ayer = prevDay(hoy);
  let montoApertura = 0;

  // Preferencia: CIERRE idempotente de AYER
  const cierreAyer = await getDoc(doc(db, 'cajaDiaria', `cierre_${admin}_${ayer}`));
  if (cierreAyer.exists()) {
    montoApertura = Number(cierreAyer.data()?.balance || 0);
  } else {
    // Fallback: último cierre “no idempotente” de AYER
    const qAyer = query(
      collection(db, 'cajaDiaria'),
      where('admin', '==', admin),
      where('operationalDate', '==', ayer),
      where('tipo', '==', 'cierre'),
      orderBy('createdAt', 'desc'),
      limit(1)
    );
    const snapAyer = await getDocs(qAyer);
    if (!snapAyer.empty) {
      montoApertura = Number(snapAyer.docs[0].data()?.balance || 0);
    } else {
      // Fallback final: saldo persistente (sólo si > 0)
      const estadoSnap = await getDoc(doc(db, 'cajaEstado', admin));
      const saldoPersistente = Number(estadoSnap.data()?.saldoActual || 0);
      if (!Number.isFinite(saldoPersistente) || saldoPersistente <= 0) {
        console.warn('[ensureAperturaDeHoy] Sin cierre de AYER y saldoPersistente<=0. No se crea apertura auto.');
        return;
      }
      montoApertura = saldoPersistente;
    }
  }

  // Crear apertura automática (tipo canónico)
  const aperturaPayload: AperturaDoc = {
    tipo: 'apertura',
    admin,
    monto: Math.round(montoApertura * 100) / 100,
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
