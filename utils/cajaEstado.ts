// utils/cajaEstado.ts
import {
  doc, getDoc, setDoc, serverTimestamp, collection, query, where, getDocs, addDoc, collectionGroup,
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
  const docId = `cierre_${admin}_${operationalDate}`;
  const ref = doc(db, 'cajaDiaria', docId);

  const already = await getDoc(ref);
  if (already.exists()) {
    // ya existe, nada que hacer
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
  // ⚠️ ahora es idempotente y marca source: 'auto'
  await ensureCierreIdempotente({
    admin,
    operationalDate: hoy,
    balance: balanceFinal,
    tz: tz ?? null,
    source: 'auto',
  });

  // ► ACTUALIZA el estado persistente para el día siguiente
  await setSaldoActual(admin, Math.round(Number(balanceFinal || 0) * 100) / 100, tz);
}

/**
 * Cierra en CADENA todos los días pendientes (hasta 7 días atrás) ANTES de abrir HOY.
 * - Si un día no tiene "apertura", toma como caja inicial el saldo persistente vigente.
 * - KPIs del día: apertura + ingresos + abonos − retiros − gastosAdmin − prestamosDelDia.
 * - ⚠️ Si no hubo actividad ese día, NO crea cierre.
 */
export async function closeMissingDays(
  admin: string,
  hoy: string,
  tz: string,
  maxDaysBack = 7 // ← ventana reducida
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
    const qCierre = query(
      collection(db, 'cajaDiaria'),
      where('admin', '==', admin),
      where('operationalDate', '==', ymd),
      where('tipo', '==', 'cierre')
    );
    const snap = await getDocs(qCierre);
    if (snap.empty) missing.push(ymd);
    else break; // desde aquí hacia atrás asumimos cadena consistente
  }

  // Procesa en orden cronológico (más antiguo → más reciente)
  missing.reverse();

  for (const ymd of missing) {
    // 1) KPIs del día desde cajaDiaria (apertura/ingresos/abonos/retiros/gastos)
    const r = await fetchCajaResumen(admin, ymd);

    // 2) “Préstamos del día” (sólo capital) por fecha de creación del préstamo
    let prestamosDelDia = 0;
    try {
      const qP = query(collectionGroup(db, 'prestamos'), where('creadoPor', '==', admin));
      const sg = await getDocs(qP);
      sg.forEach((d) => {
        const p = d.data() as any;
        const tzP = pickTZ(p?.tz, tzUse);
        // createdAtMs | createdAt(Timestamp) | fechaInicio(string/Date)
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

    // ⚠️ Si no hubo nada ese día, no creamos cierre
    const huboAlgo = [r.apertura, r.ingresos, r.abonos, r.retiros, r.gastos, prestamosDelDia]
      .some((v) => Number(v) > 0);
    if (!huboAlgo) {
      continue;
    }

    // 3) Caja inicial del día: si no hubo apertura ese día, usa saldo persistente
    let cajaInicialDelDia = r.apertura;
    if (!Number.isFinite(cajaInicialDelDia) || cajaInicialDelDia <= 0) {
      const estado = await getCajaEstado(admin);
      cajaInicialDelDia = Number(estado.saldoActual) || 0;
    }

    // 4) Caja final del día
    const cajaFinal = Math.round(
      (cajaInicialDelDia + r.ingresos + r.abonos - r.retiros - r.gastos - prestamosDelDia) * 100
    ) / 100;

    await registrarCierre(admin, ymd, cajaFinal, tzUse); // ahora idempotente
  }
}

// ———————————————————————————————————————————————
// Asegura una "apertura" automática HOY sin tocar cajaEstado:
// 1) Si existe apertura HOY → no hace nada.
// 2) Si no, intenta usar CIERRE de AYER; si no hay, usa cajaEstado (sólo si > 0).
// ———————————————————————————————————————————————
export async function ensureAperturaDeHoy(admin: string, hoy: string, tz: string) {
  // ¿Ya existe una apertura hoy? (no filtramos por tipo para evitar índice)
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

  // AYER a partir de 'hoy'
  const [Y, M, D] = hoy.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(Y, M - 1, D));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const ayer = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;

  let montoApertura = 0;

  // Buscar CIERRE de AYER (filtramos en memoria)
  const qAyer = query(
    collection(db, 'cajaDiaria'),
    where('admin', '==', admin),
    where('operationalDate', '==', ayer),
  );
  const snapAyer = await getDocs(qAyer);

  let lastCierreBalance: number | null = null;
  let lastCierreTs = -1;
  snapAyer.forEach((d) => {
    const data = d.data() as any;
    if (canonicalTipo(data?.tipo) !== 'cierre') return;

    const ts =
      (typeof data?.createdAtMs === 'number' && data.createdAtMs) ||
      (typeof data?.createdAt?.seconds === 'number' && data.createdAt.seconds * 1000) ||
      0;

    if (ts >= lastCierreTs) {
      lastCierreTs = ts;
      lastCierreBalance = Number(data?.balance || 0);
    }
  });

  if (lastCierreBalance !== null) {
    montoApertura = lastCierreBalance;
  } else {
    // Fallback a saldo persistente (solo si > 0)
    const estadoSnap = await getDoc(doc(db, 'cajaEstado', admin));
    const saldoPersistente = Number(estadoSnap.data()?.saldoActual || 0);
    if (!Number.isFinite(saldoPersistente) || saldoPersistente <= 0) {
      console.warn('[ensureAperturaDeHoy] Sin cierre de AYER y saldoPersistente<=0. No se crea apertura auto.');
      return;
    }
    montoApertura = saldoPersistente;
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
