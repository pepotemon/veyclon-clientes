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

type ScopeOpts = {
  /** Si viene, filtra filas cuyo `tenantId` coincida (si el doc lo trae). */
  tenantId?: string | null;
  /**
   * Si es collector + rutaId, filtra por `rutaId` (si el doc lo trae).
   * Para admin/superadmin se ignora esta restricción.
   */
  role?: 'collector' | 'admin' | 'superadmin' | null;
  rutaId?: string | null;
};

/** Lee TODOS los movimientos de 'cajaDiaria' del día (admin+fecha) y normaliza.
 *  Admite scoping opcional por tenant/ruta si los campos están presentes en los documentos.
 */
export async function leerMovsDelDia(
  admin: string,
  ymd: string,
  opts?: ScopeOpts
): Promise<RowCaja[]> {
  const qy = query(
    collection(db, 'cajaDiaria'),
    where('admin', '==', admin),
    where('operationalDate', '==', ymd)
  );

  const snap = await getDocs(qy);

  // 1) Trabajamos con objetos "crudos" para poder filtrar por tenantId/rutaId si existen
  const raw = snap.docs.map((d) => {
    const data: any = d.data();
    return { id: d.id, ...(data || {}) };
  });

  // 2) Scoping opcional (solo si los campos existen en el doc)
  const scoped = raw.filter((r: any) => {
    // tenant
    if (opts?.tenantId != null) {
      const t = r?.tenantId ?? null;
      if (t !== opts.tenantId) return false;
    }
    // ruta solo para collectors
    if (opts?.role === 'collector' && opts?.rutaId) {
      const rr = r?.rutaId ?? null;
      if (rr !== opts.rutaId) return false;
    }
    return true;
  });

  // 3) Normalización canónica y shape final
  const rows: RowCaja[] = scoped.map((r: any) => {
    const tipo = canonicalTipo(r?.tipo);
    const rawMonto = Number(r?.monto ?? r?.balance ?? 0);
    const monto = round2(Number.isFinite(rawMonto) ? rawMonto : 0);
    const cam =
      typeof r?.createdAtMs === 'number'
        ? r.createdAtMs
        : typeof r?.createdAt?.seconds === 'number'
        ? r.createdAt.seconds * 1000
        : 0;

    return { id: r.id, tipo, monto, createdAtMs: cam || 0 };
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
        // “Préstamos (día)” = suma exclusiva de cajaDiaria con tipo 'prestamo'
        prestamos += r.monto;
        break;

      default:
        // ignora 'cierre' u otros informativos
        break;
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

/** Azúcar: KPIs del día leyendo y sumando.
 *  ⚠️ Compat: acepta `opts` (ScopeOpts) o directamente `tenantId` como string/null.
 */
export async function kpisDelDia(
  admin: string,
  ymd: string,
  optsOrTenant?: ScopeOpts | string | null
): Promise<KpisDia> {
  let opts: ScopeOpts | undefined;
  if (typeof optsOrTenant === 'string' || optsOrTenant === null) {
    opts = { tenantId: optsOrTenant ?? null };
  } else {
    opts = optsOrTenant;
  }
  const rows = await leerMovsDelDia(admin, ymd, opts);
  return sumarKpis(rows);
}

/** Deriva cajaFinal usando sólo KPIs y una base inicial (apertura>0 o cierre de ayer).
 *  🛡️ Política actual: SÓLO restamos gastos del ADMIN en la caja.
 *  Los `gastosCobrador` se reportan en KPIs pero **no** afectan la caja final.
 */
export function cajaFinalConBase(baseInicial: number, k: KpisDia): number {
  const val =
    baseInicial +
    k.ingresos +
    k.cobrado -
    k.retiros -
    k.prestamos -
    k.gastosAdmin;   // 👈 NO restamos k.gastosCobrador

  return round2(val);
}
