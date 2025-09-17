// utils/cajaEstado.ts
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  collection,
  query,
  where,
  getDocs,
  addDoc,
} from 'firebase/firestore';
import { db } from '../firebase/firebaseConfig';
import { logAudit, pick } from './auditLogs';

// Fase 2: intérprete canónico de tipos de movimiento
import { canonicalTipo } from './movimientoHelper';

export type CajaEstado = {
  saldoActual: number;            // saldo persistente (se actualiza SOLO en cierres)
  updatedAt?: any;
  tz?: string | null;
};

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
  const ref = doc(db, 'cajaEstado', admin);

  const prevSnap = await getDoc(ref);
  const before = prevSnap.exists()
    ? {
        saldoActual: Number(prevSnap.data()?.saldoActual || 0),
        tz: prevSnap.data()?.tz ?? null,
      }
    : null;

  const payload = {
    saldoActual: Number(nuevoSaldo || 0),
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

/**
 * ——————————————————————————————————————————————
 * Crea el CIERRE del día y ACTUALIZA cajaEstado.saldoActual
 * para que el día siguiente arranque con ese mismo saldo.
 * ——————————————————————————————————————————————
 */
export async function registrarCierre(
  admin: string,
  hoy: string,            // 'YYYY-MM-DD' del día que cierras
  balanceFinal: number,   // saldo final calculado del día
  tz?: string
) {
  const cierrePayload = {
    tipo: 'cierre' as const,        // canónico
    admin,
    balance: Math.round(Number(balanceFinal || 0) * 100) / 100,
    operationalDate: hoy,
    tz: tz ?? null,
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
    source: 'manual' as const,
  };

  const cierreRef = await addDoc(collection(db, 'cajaDiaria'), cierrePayload);

 await logAudit({
  userId: admin,
  action: 'caja_cierre_auto',       // ✅ coincide con AuditAction actual
  ref: cierreRef,
  before: null,
  after: pick(cierrePayload, ['tipo', 'balance', 'operationalDate', 'tz', 'source']),
});


  // ► ACTUALIZA el estado persistente para el día siguiente
  await setSaldoActual(admin, cierrePayload.balance, tz);
}

// ———————————————————————————————————————————————
// Asegura una "apertura" automática HOY sin tocar cajaEstado:
// 1) Si existe apertura HOY → no hace nada.
// 2) Si no, intenta usar CIERRE de AYER; si no hay, usa cajaEstado.
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

  // Buscar CIERRE de AYER (sin where('tipo') → filtramos en memoria)
  const qAyer = query(
    collection(db, 'cajaDiaria'),
    where('admin', '==', admin),
    where('operationalDate', '==', ayer),
  );
  const snapAyer = await getDocs(qAyer);

  let lastCierreBalance = null as number | null;
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
    // Fallback a saldo persistente
    const estadoSnap = await getDoc(doc(db, 'cajaEstado', admin));
    montoApertura = Number(estadoSnap.data()?.saldoActual || 0);
  }

  // Crear apertura automática (tipo canónico)
  const aperturaPayload = {
    tipo: 'apertura' as const,  // 👈 canónico (diferenciamos por source)
    admin,
    monto: Math.round(montoApertura * 100) / 100,
    operationalDate: hoy,
    tz,
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
    source: 'auto' as const,    // distingue de la apertura manual
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
