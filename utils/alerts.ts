// utils/alerts.ts
import { calcularDiasAtraso } from './atrasoHelper';
import { todayInTZ, pickTZ, normYYYYMMDD } from './timezone';

/** ===== Tipos ===== */
export type AlertaTag =
  | 'vence_hoy'
  | 'atraso_1'
  | 'atraso_2' // nota: 2 o más (para compat)
  | 'al_dia'
  | 'adelantado';

export type Badge = { label: string; bg: string; text: string; border: string };
type BadgeColors = { bg: string; text: string; border: string };

/** ===== Utilidades de color ===== */
function baseColors(kind: 'vence' | 'atraso' | 'adelantado' | 'aldia'): BadgeColors {
  switch (kind) {
    case 'vence':       return { bg: '#FFF8E1', text: '#E65100', border: '#FFE0B2' };
    case 'atraso':      return { bg: '#FFEBEE', text: '#B71C1C', border: '#FFCDD2' };
    case 'adelantado':  return { bg: '#E8F5E9', text: '#2E7D32', border: '#C8E6C9' };
    case 'aldia':
    default:            return { bg: '#E3F2FD', text: '#1565C0', border: '#BBDEFB' };
  }
}

/** ===== Helpers internos ===== */
function huboAbonoHoy(prestamo: any, hoy: string) {
  return (
    Array.isArray(prestamo?.abonos) &&
    prestamo.abonos.some(
      (a: any) => (a?.operationalDate ?? normYYYYMMDD(a?.fecha)) === hoy
    )
  );
}

function calcAtraso(prestamo: any, modo: 'porCuota' | 'porPresencia') {
  const tz = pickTZ(prestamo?.tz);
  const hoy = todayInTZ(tz);

  const cuotas =
    Number(prestamo?.cuotas || 0) ||
    Math.ceil(
      Number(prestamo?.totalPrestamo ?? prestamo?.montoTotal ?? 0) /
        (Number(prestamo?.valorCuota || 1))
    );

  const res = calcularDiasAtraso({
    fechaInicio: prestamo?.fechaInicio || hoy,
    hoy,
    cuotas,
    valorCuota: Number(prestamo?.valorCuota || 0),
    abonos: Array.isArray(prestamo?.abonos)
      ? prestamo.abonos.map((a: any) => ({
          monto: Number(a.monto) || 0,
          operationalDate: a.operationalDate,
          fecha: a.fecha,
        }))
      : [],
    diasHabiles:
      Array.isArray(prestamo?.diasHabiles) && prestamo.diasHabiles.length
        ? prestamo.diasHabiles
        : [1, 2, 3, 4, 5, 6],
    feriados: Array.isArray(prestamo?.feriados) ? prestamo.feriados : [],
    pausas: Array.isArray(prestamo?.pausas) ? prestamo.pausas : [],
    modo,
    permitirAdelantar: !!prestamo?.permitirAdelantar,
  });

  return { atraso: res.atraso as number, hoy, pagoHoy: huboAbonoHoy(prestamo, hoy) };
}

/** =========================================================
 *  NUEVOS HELPERS: badges listos para UI
 *  ========================================================= */

/** Badge por CUOTAS: +N / Vence hoy / Al día / Adelantado */
/** Badge por CUOTAS: muestra “Cuotas vencidas: N” */
export function computeQuotaBadge(prestamo: any): Badge {
  const { atraso } = calcAtraso(prestamo, 'porCuota');

  if (atraso > 0) {
    const b = baseColors('atraso');
    return { ...b, label: `Cuotas vencidas: ${atraso}` };
  }
  if (atraso < 0) {
    const b = baseColors('adelantado');
    return { ...b, label: 'Cuotas adelantadas' };
  }
  const b = baseColors('aldia');
  return { ...b, label: 'Cuotas al día' };
}

/** Badge por PRESENCIA: muestra “Días de atraso: N” */
export function computePresenceBadge(prestamo: any): Badge {
  const { atraso, pagoHoy } = calcAtraso(prestamo, 'porPresencia');

  if (pagoHoy) {
    const b = baseColors('aldia');
    return { ...b, label: 'Días de atraso: 0' };
  }
  if (atraso > 0) {
    const b = baseColors('atraso');
    return { ...b, label: `Días de atraso: ${atraso}` };
  }
  const b = baseColors('vence');
  return { ...b, label: 'Días de atraso: 0' };
}


/** =========================================================
 *  COMPAT: API vieja (usada por código existente)
 *  ========================================================= */

export function computeAlertTag(prestamo: any): AlertaTag {
  const modo = (prestamo?.modoAtraso as 'porPresencia' | 'porCuota') ?? 'porPresencia';
  const { atraso, pagoHoy } = calcAtraso(prestamo, modo);

  if (atraso > 0) {
    if (atraso === 1) return 'atraso_1';
    return 'atraso_2'; // 2 o más (compat)
  }
  if (atraso < 0) return 'adelantado';
  return pagoHoy ? 'al_dia' : 'vence_hoy';
}

export function computeAlertInfo(prestamo: any) {
  const modo = (prestamo?.modoAtraso as 'porPresencia' | 'porCuota') ?? 'porPresencia';
  const { atraso } = calcAtraso(prestamo, modo);
  const tag = computeAlertTag(prestamo);
  const label = labelFor(tag, atraso);
  const colors = pillColors(tag, atraso);
  return { atraso, tag, label, colors };
}

export function labelFor(tag: AlertaTag, atrasoReal?: number) {
  switch (tag) {
    case 'vence_hoy':
      return 'Vence hoy';
    case 'atraso_1':
      return '+1';
    case 'atraso_2':
      return `+${Math.max(2, Math.floor(atrasoReal ?? 2))}`;
    case 'adelantado':
      return 'Adelantado';
    default:
      return 'Al día';
  }
}

export function pillColors(tag: AlertaTag, _atrasoReal?: number) {
  switch (tag) {
    case 'vence_hoy':
      return { bg: '#FFF8E1', text: '#E65100', border: '#FFE0B2' };
    case 'atraso_1':
      return { bg: '#FFEBEE', text: '#C62828', border: '#FFCDD2' };
    case 'atraso_2': // 2 o más
      return { bg: '#FFEBEE', text: '#B71C1C', border: '#FFCDD2' };
    case 'adelantado':
      return { bg: '#E8F5E9', text: '#2E7D32', border: '#C8E6C9' };
    default:
      return { bg: '#E3F2FD', text: '#1565C0', border: '#BBDEFB' };
  }
}
