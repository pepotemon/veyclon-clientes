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
    const montoDoc = Number(
      (data?.monto ?? data?.balance ?? 0)
    ) || 0;

    // Acumuladores por tipo canónico
    switch (tip) {
      case 'apertura': {
        // quedarse con la última apertura del día
        if (ts >= aperturaTs) {
          aperturaTs = ts;
          aperturaMonto = Number(data?.monto || 0) || 0;
        }
        break;
      }
      case 'ingreso':
        ingresos += Number(data?.monto || 0) || 0;
        break;
      case 'abono':
        abonos += Number(data?.monto || 0) || 0;
        break;
      case 'retiro':
        retiros += Number(data?.monto || 0) || 0;
        break;
      case 'gasto_admin':
        gastosAdmin += Number(data?.monto || 0) || 0;
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
      monto: montoDoc,
      nota: data?.nota ?? null,
      createdAt: (data?.createdAt as Timestamp) ?? null,
    });
  });

  const apertura = aperturaMonto;
  const gastos = gastosAdmin;
  const neto = apertura + ingresos + abonos - retiros - gastos;

  // (opcional) podrías ordenar items por fecha desc si lo quisieras:
  // items.sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));

  return { apertura, ingresos, abonos, retiros, gastos, neto, items };
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
