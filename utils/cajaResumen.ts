// utils/cajaResumen.ts
import {
  collection,
  query,
  where,
  onSnapshot,
  getDocs,
  Timestamp,
  QuerySnapshot,
  DocumentData,
} from 'firebase/firestore';
import { db } from '../firebase/firebaseConfig';

// 👇 normalizador de tipos canónicos (pago→abono, gastoAdmin→gasto_admin, etc.)
import { canonicalTipo } from './movimientoHelper';

export type CajaItem = {
  id: string;
  // Tipos canónicos de Fase 2 (incluimos gasto_cobrador y cierre para no perderlos en la lista)
  tipo: 'apertura' | 'ingreso' | 'retiro' | 'abono' | 'gasto_admin' | 'gasto_cobrador' | 'cierre';
  monto: number;               // para 'cierre' usamos balance si viene en el doc
  nota?: string | null;
  createdAt?: Timestamp | null;
};

export type CajaResumen = {
  apertura: number; // toma la APERTURA más reciente del día (no suma varias aperturas)
  ingresos: number;
  abonos: number;
  retiros: number;
  gastos: number;   // SOLO gastos administrativos (gasto_admin)
  neto: number;     // apertura + ingresos + abonos − retiros − gastos
  items: CajaItem[]; // lista completa para UI (incluye gasto_cobrador y cierre)
};

// —— helpers numéricos (sin -0.00)
const r2 = (n: number) => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Math.abs(v) < 0.005 ? 0 : v;
};
const n2 = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function calcResumenFromSnap(snap: QuerySnapshot<DocumentData>): CajaResumen {
  let aperturaMonto = 0;
  let aperturaTs = -1; // tomamos la apertura más reciente
  let ingresos = 0;
  let abonos = 0;
  let retiros = 0;
  let gastosAdmin = 0;

  const items: CajaItem[] = [];

  snap.forEach((d) => {
    const data = d.data() as any;
    const tip = canonicalTipo(data?.tipo);
    if (!tip) return;

    const ts =
      (typeof data?.createdAtMs === 'number' && data.createdAtMs) ||
      (typeof data?.createdAt?.seconds === 'number' && data.createdAt.seconds * 1000) ||
      0;

    // Para listado, intentamos siempre tener un monto razonable
    const montoDoc = n2(data?.monto ?? data?.balance ?? 0);

    // Acumuladores por tipo canónico
    switch (tip) {
      case 'apertura': {
        // quedarse con la última apertura del día
        if (ts >= aperturaTs) {
          aperturaTs = ts;
          aperturaMonto = n2(data?.monto);
        }
        break;
      }
      case 'ingreso':
        ingresos += n2(data?.monto);
        break;
      case 'abono':
        abonos += n2(data?.monto);
        break;
      case 'retiro':
        retiros += n2(data?.monto);
        break;
      case 'gasto_admin':
        gastosAdmin += n2(data?.monto);
        break;
      case 'gasto_cobrador':
        // NO cuenta en KPI de gastos del cierre
        break;
      case 'cierre':
        // No suma en KPIs (solo registro). El doc suele traer 'balance'.
        break;
      default:
        break;
    }

    items.push({
      id: d.id,
      tipo: tip as CajaItem['tipo'],
      monto: r2(montoDoc),
      nota: (data?.nota ?? null) || null,
      createdAt: (data?.createdAt as Timestamp) ?? null,
    });
  });

  const apertura = r2(aperturaMonto);
  const gastos = r2(gastosAdmin);
  const resumen = {
    apertura,
    ingresos: r2(ingresos),
    abonos: r2(abonos),
    retiros: r2(retiros),
    gastos,
  };
  const neto = r2(resumen.apertura + resumen.ingresos + resumen.abonos - resumen.retiros - resumen.gastos);

  // (opcional) ordenar items por fecha desc:
  // items.sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));

  return { ...resumen, neto, items };
}

/** Carga una vez (fetch) */
export async function fetchCajaResumen(admin: string, operationalDate: string): Promise<CajaResumen> {
  const qy = query(
    collection(db, 'cajaDiaria'),
    where('admin', '==', admin),
    where('operationalDate', '==', operationalDate)
  );
  const snap = await getDocs(qy);
  return calcResumenFromSnap(snap);
}

/** Suscripción en tiempo real (recomendado para Cerrar Día y Caja) */
export function watchCajaResumen(
  admin: string,
  operationalDate: string,
  cb: (r: CajaResumen) => void,
  onError?: (e: any) => void
) {
  const qy = query(
    collection(db, 'cajaDiaria'),
    where('admin', '==', admin),
    where('operationalDate', '==', operationalDate)
  );
  return onSnapshot(
    qy,
    (snap) => cb(calcResumenFromSnap(snap)),
    (err) => onError?.(err)
  );
}
