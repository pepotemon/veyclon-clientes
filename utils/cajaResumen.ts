// utils/cajaResumen.ts
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase/firebaseConfig';
import { canonicalTipo, type MovimientoTipo } from './movimientoHelper';

/** Redondeo amable en 2 decimales (evita -0.00). */
const round2 = (n: number) => {
  const v = Math.round(Number(n || 0) * 100) / 100;
  return Math.abs(v) < 0.005 ? 0 : v;
};

/** Fila mínima normalizada para sumar. */
export type RowCaja = {
  id: string;
  tipo: MovimientoTipo | null;
  monto: number;        // monto o balance (ya normalizado)
  createdAtMs: number;  // para elegir la última apertura del día
};

export type KpisDia = {
  apertura: number;
  cobrado: number;
  ingresos: number;
  retiros: number;
  gastosAdmin: number;
  gastosCobrador: number;
  prestamos: number;
};

/** Lee TODOS los movimientos de 'cajaDiaria' del día (admin+fecha) y normaliza. */
export async function leerMovsDelDia(admin: string, ymd: string): Promise<RowCaja[]> {
  const qy = query(
    collection(db, 'cajaDiaria'),
    where('admin', '==', admin),
    where('operationalDate', '==', ymd)
  );

  const snap = await getDocs(qy);

  const rows: RowCaja[] = snap.docs.map((d) => {
    const data: any = d.data();
    const tipo = canonicalTipo(data?.tipo);
    const rawMonto = Number(data?.monto ?? data?.balance ?? 0);
    const monto = round2(Number.isFinite(rawMonto) ? rawMonto : 0);
    const cam =
      typeof data?.createdAtMs === 'number'
        ? data.createdAtMs
        : typeof data?.createdAt?.seconds === 'number'
        ? data.createdAt.seconds * 1000
        : 0;

    return { id: d.id, tipo, monto, createdAtMs: cam || 0 };
  });

  return rows;
}

/** Reglas de sumatoria canónicas para KPIs del día (solo cajaDiaria). */
export function sumarKpis(rows: RowCaja[]): KpisDia {
  let aperturaVal = 0;
  let aperturaTs = -1;

  let cobrado = 0;
  let ingresos = 0;
  let retiros = 0;
  let gastosAdmin = 0;
  let gastosCobrador = 0;
  let prestamos = 0;

  for (const r of rows) {
    if (!r?.tipo) continue;

    switch (r.tipo) {
      case 'apertura':
        if (r.createdAtMs >= aperturaTs) {
          aperturaTs = r.createdAtMs;
          aperturaVal = r.monto;
        }
        break;

      case 'abono':
        cobrado += r.monto;
        break;

      case 'ingreso':
        ingresos += r.monto;
        break;

      case 'retiro':
        retiros += r.monto;
        break;

      case 'gasto_admin':
        gastosAdmin += r.monto;
        break;

      case 'gasto_cobrador':
        gastosCobrador += r.monto;
        break;

      case 'prestamo':
        // 👇 “Préstamos (día)” = suma exclusiva de cajaDiaria con tipo 'prestamo'
        prestamos += r.monto;
        break;

      default:
        break; // ignora 'cierre' u otros no relevantes para KPIs
    }
  }

  return {
    apertura: round2(aperturaVal),
    cobrado: round2(cobrado),
    ingresos: round2(ingresos),
    retiros: round2(retiros),
    gastosAdmin: round2(gastosAdmin),
    gastosCobrador: round2(gastosCobrador),
    prestamos: round2(prestamos),
  };
}

/** Azúcar: KPIs del día leyendo y sumando en un solo paso. */
export async function kpisDelDia(admin: string, ymd: string): Promise<KpisDia> {
  const rows = await leerMovsDelDia(admin, ymd);
  return sumarKpis(rows);
}

/** Deriva cajaFinal usando sólo KPIs y una base inicial (apertura>0 o cierre de ayer). */
export function cajaFinalConBase(baseInicial: number, k: KpisDia): number {
  const val =
    baseInicial +
    k.ingresos +
    k.cobrado -
    k.retiros -
    k.prestamos -
    k.gastosAdmin -
    k.gastosCobrador;

  return round2(val);
}
