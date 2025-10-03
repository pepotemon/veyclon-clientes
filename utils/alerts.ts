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

/** ===== Helpers de fecha ===== */
function toYMDInTZ(d: Date, tz: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
function anyToYMD(input: any, tz: string): string | null {
  if (!input) return null;
  if (typeof input === 'string') {
    const n = normYYYYMMDD(input);
    return n || null;
  }
  if (typeof input === 'number') return toYMDInTZ(new Date(input), tz);
  if (typeof input?.toDate === 'function') return toYMDInTZ(input.toDate(), tz);
  if (typeof input?.seconds === 'number') return toYMDInTZ(new Date(input.seconds * 1000), tz);
  if (input instanceof Date) return toYMDInTZ(input, tz);
  return null;
}
function ymdAdd(ymd: string, days: number) {
  const [Y, M, D] = ymd.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(Y, M - 1, D));
  dt.setUTCDate(dt.getUTCDate() + days);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function isBetween(ymd: string, desde: string, hasta: string) {
  return ymd >= (desde || '') && ymd <= (hasta || '');
}

/** ====== Helpers de conteo de días hábiles ====== */
function countExpectedWorkdays(
  startYmd: string,
  hoyYmd: string,
  diasHabiles: number[],
  feriados: string[],
  pausas: { desde: string; hasta: string }[]
): number {
  if (!startYmd || !hoyYmd || hoyYmd < startYmd) return 0;
  const fer = new Set(feriados.filter(Boolean));
  const ranges = (pausas || []).map((p) => ({
    desde: normYYYYMMDD(p.desde) || '',
    hasta: normYYYYMMDD(p.hasta) || '',
  }));
  let count = 0;
  let curr = startYmd;
  while (curr <= hoyYmd) {
    const dt = new Date(curr + 'T00:00:00Z');
    const wd = dt.getUTCDay(); // 0..6; domingo=0
    const isoWD = wd === 0 ? 7 : wd; // 1..7
    const pausado = ranges.some((r) => r.desde && r.hasta && isBetween(curr, r.desde, r.hasta));
    const feriado = fer.has(curr);
    const habil = diasHabiles.includes(isoWD);
    if (!pausado && !feriado && habil) count++;
    curr = ymdAdd(curr, 1);
  }
  return count;
}

/** ===== Helpers internos ===== */
function huboAbonoHoy(prestamo: any, hoy: string) {
  // 1) Legacy: arreglo embebido en el documento
  const viaArray =
    Array.isArray(prestamo?.abonos) &&
    prestamo.abonos.some((a: any) => (a?.operationalDate ?? normYYYYMMDD(a?.fecha)) === hoy);

  if (viaArray) return true;

  // 2) Nuevo: marca en el doc (cuando el abono viene por subcolección/outbox)
  const tz = pickTZ(prestamo?.tz);
  const last = anyToYMD(prestamo?.lastAbonoAt, tz);
  return last === hoy;
}

function calcAtraso(prestamo: any, modo: 'porCuota' | 'porPresencia') {
  const tz = pickTZ(prestamo?.tz);
  const hoy = todayInTZ(tz);

  // Pago de hoy (robusto)
  const pagoHoy = huboAbonoHoy(prestamo, hoy);

  // Si ya traemos el agregado 'diasAtraso' en el doc, úsalo (reconciliado)
  if (typeof prestamo?.diasAtraso === 'number' && Number.isFinite(prestamo.diasAtraso)) {
    return { atraso: Number(prestamo.diasAtraso) || 0, hoy, pagoHoy };
  }

  // Caso contrario, recalculamos (compat con abonos embebidos)
  const valorCuotaNum = Number(prestamo?.valorCuota || 0);
  const totalPlan =
    Number(prestamo?.cuotas || 0) ||
    (valorCuotaNum > 0
      ? Math.ceil(Number(prestamo?.totalPrestamo ?? prestamo?.montoTotal ?? 0) / valorCuotaNum)
      : 0);

  const res = calcularDiasAtraso({
    fechaInicio: prestamo?.fechaInicio || hoy,
    hoy,
    cuotas: totalPlan,
    valorCuota: valorCuotaNum,
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

  return { atraso: Number(res.atraso || 0), hoy, pagoHoy };
}

/** ====== Progreso de cuotas (adelantadas, vencidas, al día) ====== */
function computeQuotaProgress(prestamo: any) {
  const tz = pickTZ(prestamo?.tz, 'America/Sao_Paulo');
  const hoy = todayInTZ(tz);

  const valorCuota = Number(prestamo?.valorCuota || 0);
  const totalPlan =
    Number(prestamo?.cuotas || 0) ||
    (valorCuota > 0
      ? Math.ceil(Number(prestamo?.totalPrestamo ?? prestamo?.montoTotal ?? 0) / valorCuota)
      : 0);

  const start =
    anyToYMD(prestamo?.fechaInicio ?? prestamo?.creadoEn ?? prestamo?.createdAtMs, tz) || hoy;

  const diasHabiles: number[] =
    Array.isArray(prestamo?.diasHabiles) && prestamo.diasHabiles.length
      ? prestamo.diasHabiles
      : [1, 2, 3, 4, 5, 6];
  const feriados: string[] = Array.isArray(prestamo?.feriados)
    ? prestamo.feriados.map((f: any) => normYYYYMMDD(f)).filter(Boolean)
    : [];
  const pausas: { desde: string; hasta: string }[] = Array.isArray(prestamo?.pausas)
    ? prestamo.pausas
    : [];

  let esperadas = countExpectedWorkdays(start, hoy, diasHabiles, feriados, pausas);
  if (totalPlan > 0) esperadas = Math.min(esperadas, totalPlan);

  // ---- Cuotas pagadas (robusto a subcolección) ----
  const EPS = 0.009;
  let cuotasPagadas = 0;

  // 1) Agregado directo
  if (Number.isFinite(prestamo?.cuotasPagadas)) {
    cuotasPagadas = Math.max(0, Math.floor(Number(prestamo.cuotasPagadas)));
  } else {
    // 2) Derivar de restante vs total (si ambos están)
    const total = Number(prestamo?.totalPrestamo ?? prestamo?.montoTotal ?? 0);
    const rest = Number(prestamo?.restante);
    if (valorCuota > 0 && Number.isFinite(total) && Number.isFinite(rest) && total >= rest) {
      const pagado = total - rest;
      cuotasPagadas = Math.floor((pagado + EPS) / valorCuota);
    } else {
      // 3) Fallback: sumar abonos embebidos hasta hoy
      let pagado = 0;
      const abonos: any[] = Array.isArray(prestamo?.abonos) ? prestamo.abonos : [];
      for (const a of abonos) {
        const dia = a?.operationalDate ?? normYYYYMMDD(a?.fecha);
        if (dia && dia <= hoy) pagado += Number(a?.monto || 0);
      }
      cuotasPagadas = valorCuota > 0 ? Math.floor((pagado + EPS) / valorCuota) : 0;
    }
  }

  return {
    hoy,
    valorCuota,
    esperadas,
    pagadas: cuotasPagadas,
    diff: cuotasPagadas - esperadas, // >0 adelantado, <0 vencidas
    permitirAdelantar: !!prestamo?.permitirAdelantar,
  };
}

/** =========================================================
 *  BADGES “largos” (Home / detalles)
 *  ========================================================= */

export function computeQuotaBadge(prestamo: any): Badge {
  const { valorCuota, diff, permitirAdelantar } = computeQuotaProgress(prestamo);

  if (!(valorCuota > 0)) {
    const b = baseColors('aldia');
    return { ...b, label: 'Cuotas al día' };
  }

  if (diff > 0 && permitirAdelantar) {
    const b = baseColors('adelantado');
    return { ...b, label: diff === 1 ? 'Cuota adelantada: 1' : `Cuotas adelantadas: ${diff}` };
  }

  if (diff < 0) {
    const vencidas = Math.abs(diff);
    const b = baseColors('atraso');
    return { ...b, label: vencidas === 1 ? 'Cuota vencida: 1' : `Cuotas vencidas: ${vencidas}` };
  }

  const b = baseColors('aldia');
  return { ...b, label: 'Cuotas al día' };
}

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
 *  COMPAT compacta (PagosDiarios): +N rojo / +N verde / “Al día”
 *  ========================================================= */

export function computeAlertTag(prestamo: any): AlertaTag {
  // Si está adelantado por cuotas y lo permites → 'adelantado'
  const { diff, permitirAdelantar } = computeQuotaProgress(prestamo);
  if (permitirAdelantar && diff > 0) return 'adelantado';

  const modo = (prestamo?.modoAtraso as 'porPresencia' | 'porCuota') ?? 'porPresencia';
  const { atraso, pagoHoy } = calcAtraso(prestamo, modo);

  if (atraso > 0) return atraso === 1 ? 'atraso_1' : 'atraso_2';
  if (atraso < 0) return 'adelantado';
  return pagoHoy ? 'al_dia' : 'vence_hoy';
}

export function computeAlertInfo(prestamo: any) {
  const modo = (prestamo?.modoAtraso as 'porPresencia' | 'porCuota') ?? 'porPresencia';
  const { atraso } = calcAtraso(prestamo, modo);
  const tag = computeAlertTag(prestamo);

  // Para “adelantado”, usamos el número de cuotas adelantadas como negativo,
  // así labelFor muestra “+N” y pillColors ya pinta verde.
  let countForLabel = atraso;
  if (tag === 'adelantado') {
    const { diff, permitirAdelantar } = computeQuotaProgress(prestamo);
    if (permitirAdelantar && diff > 0) countForLabel = -diff;
  }

  const label = labelFor(tag, countForLabel);
  const colors = pillColors(tag, countForLabel);
  return { atraso, tag, label, colors };
}

export function labelFor(tag: AlertaTag, atrasoReal?: number) {
  switch (tag) {
    case 'vence_hoy':
      // Compacto: tratamos “vence hoy” como “al día”
      return 'Al día';
    case 'atraso_1':
      return '+1';
    case 'atraso_2':
      return `+${Math.max(2, Math.floor(Math.abs(atrasoReal ?? 2)))}`;
    case 'adelantado':
      if (typeof atrasoReal === 'number' && atrasoReal < 0) {
        const n = Math.max(1, Math.floor(Math.abs(atrasoReal)));
        return `+${n}`;
      }
      return 'Adelantado';
    default:
      return 'Al día';
  }
}

export function pillColors(tag: AlertaTag, _atrasoReal?: number) {
  switch (tag) {
    case 'vence_hoy':
      return { bg: '#E3F2FD', text: '#1565C0', border: '#BBDEFB' };
    case 'atraso_1':
      return { bg: '#FFEBEE', text: '#C62828', border: '#FFCDD2' };
    case 'atraso_2':
      return { bg: '#FFEBEE', text: '#B71C1C', border: '#FFCDD2' };
    case 'adelantado':
      return { bg: '#E8F5E9', text: '#2E7D32', border: '#C8E6C9' };
    default:
      return { bg: '#E3F2FD', text: '#1565C0', border: '#BBDEFB' };
  }
}
