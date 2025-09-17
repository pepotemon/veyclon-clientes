// utils/timezone.ts

/** Comprueba si una zona horaria es válida para Intl */
function isValidTZ(tz?: string | null): tz is string {
  if (!tz || typeof tz !== 'string' || !tz.trim()) return false;
  try {
    // Si es inválida, Intl lanzará RangeError
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Devuelve una zona horaria válida:
 *  - preferred (si viene y es válida),
 *  - o la del dispositivo (si es válida),
 *  - o fallback 'America/Sao_Paulo'
 */
export function pickTZ(preferred?: string | null, fallback = 'America/Sao_Paulo'): string {
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (isValidTZ(preferred)) return preferred!;
  if (isValidTZ(device)) return device!;
  return fallback;
}

/** Formatea un Date a 'YYYY-MM-DD' en una TZ dada usando formatToParts (robusto a DST). */
function ymdFromDateInTZ(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const y = parts.find(p => p.type === 'year')?.value ?? '0000';
  const m = parts.find(p => p.type === 'month')?.value ?? '01';
  const d = parts.find(p => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

/** Hoy como 'YYYY-MM-DD' en la TZ dada (sin saltos por DST). */
export function todayInTZ(tz?: string): string {
  const timeZone = pickTZ(tz);
  return ymdFromDateInTZ(new Date(), timeZone);
}

/** Valida 'YYYY-MM-DD' (rango laxo 1900..2100). */
function isValidYMD(ymd: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return false;
  const Y = +m[1], M = +m[2], D = +m[3];
  if (Y < 1900 || Y > 2100) return false;
  if (M < 1 || M > 12) return false;
  if (D < 1 || D > 31) return false;
  // Chequeo calendario real:
  const dt = new Date(Date.UTC(Y, M - 1, D));
  return (dt.getUTCFullYear() === Y && (dt.getUTCMonth() + 1) === M && dt.getUTCDate() === D);
}

/** Normaliza varios formatos de fecha a 'YYYY-MM-DD'. Si no puede, devuelve ''. 
 *  Política:
 *   - Si ya viene 'YYYY-MM-DD' válido, se devuelve tal cual (no se “mueve” de día).
 *   - Strings parseables o timestamps se llevan a fecha **en UTC** (neutral) → 'YYYY-MM-DD'.
 */
export function normYYYYMMDD(input?: any): string {
  if (!input) return '';
  // Ya está normalizado
  if (typeof input === 'string') {
    const s = input.trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m && isValidYMD(s)) return s;

    // Intentar parseo general (ISO, etc.) → convertir a 'YYYY-MM-DD' en UTC
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
    }
    return '';
  }

  // Date
  if (input instanceof Date) {
    if (isNaN(input.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(input);
  }

  // Firestore Timestamp-like { seconds: number }
  if (typeof input?.seconds === 'number') {
    const d = new Date(input.seconds * 1000);
    if (!isNaN(d.getTime())) {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
    }
    return '';
  }

  // timestamps (ms)
  if (typeof input === 'number') {
    const d = new Date(input);
    if (!isNaN(d.getTime())) {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
    }
  }
  return '';
}

/** Milisegundos que faltan para la próxima medianoche en la TZ dada. */
export function nextMidnightDelayInTZ(tz?: string): number {
  const timeZone = pickTZ(tz);

  // obtener hora/min/seg actuales en esa TZ sin construir fechas complejas
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date());

  const h = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? '0');
  const s = Number(parts.find(p => p.type === 'second')?.value ?? '0');

  // segundos restantes hasta 24:00 en esa TZ
  const secsLeft = (24 * 3600) - (h * 3600 + m * 60 + s);
  // colchón pequeño para evitar ticks repetidos por redondeos
  return Math.max(500, secsLeft * 1000 + 200);
}

/** Convierte Date/epoch a 'YYYY-MM-DD' en una TZ concreta (robusto a DST). */
export function toYYYYMMDDInTZ(date: Date | number, tz?: string): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  const timeZone = pickTZ(tz);
  return ymdFromDateInTZ(d, timeZone);
}

/** Añade días a un 'YYYY-MM-DD' SIN romper por DST (usa UTC internamente). */
export function addDaysYMD(ymd: string, days: number): string {
  if (!isValidYMD(ymd)) return '';
  const [Y, M, D] = ymd.split('-').map(n => parseInt(n, 10));
  const dt = new Date(Date.UTC(Y, M - 1, D));
  dt.setUTCDate(dt.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dt);
}

/** Convierte una fecha heterogénea a 'YYYY-MM-DD' en TZ dada.
 *  - Si input ya es 'YYYY-MM-DD' válido → se devuelve igual.
 *  - Si es Date/epoch/Timestamp → devuelve la fecha vista desde esa TZ.
 */
export function anyDateToYYYYMMDD(input: any, tz?: string): string {
  if (typeof input === 'string') {
    const n = normYYYYMMDD(input);
    return n || '';
  }
  const timeZone = pickTZ(tz);
  if (input instanceof Date) {
    if (isNaN(input.getTime())) return '';
    return ymdFromDateInTZ(input, timeZone);
  }
  if (typeof input?.seconds === 'number') {
    return ymdFromDateInTZ(new Date(input.seconds * 1000), timeZone);
  }
  if (typeof input === 'number') {
    return ymdFromDateInTZ(new Date(input), timeZone);
  }
  return '';
}
