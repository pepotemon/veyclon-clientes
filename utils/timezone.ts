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

/** Formatea una fecha en 'YYYY-MM-DD' en la TZ dada.  */
export function todayInTZ(tz?: string): string {
  const timeZone = pickTZ(tz);
  // en-CA da 'YYYY-MM-DD'
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Normaliza varios formatos de fecha a 'YYYY-MM-DD'. Si no puede, devuelve ''. */
export function normYYYYMMDD(input?: any): string {
  if (!input) return '';
  if (typeof input === 'string') {
    // si ya viene como 'YYYY-MM-DD'
    const m = input.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    // intenta parsear ISO o similar
    const d = new Date(input);
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
  if (input instanceof Date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(input);
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

/** (Opcional) Convierte Date/epoch a 'YYYY-MM-DD' en una TZ concreta. */
export function toYYYYMMDDInTZ(date: Date | number, tz?: string): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  const timeZone = pickTZ(tz);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
