// utils/atrasoHelper.ts
export type Rango = { desde: string; hasta: string };
export type ModoAtraso = "porPresencia" | "porCuota";

function isISO(y?: string) {
  return !!(y && /^\d{4}-\d{2}-\d{2}$/.test(y));
}

// --- utils fecha ---
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function dateToStr(d: Date) {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const da = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${da}`;
}
function strToDate(s: string) {
  const [y, m, da] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, da || 1);
}

// Normaliza suavemente strings tipo "YYYY-MM-DD" o "YYYY-MM-DDThh:mm:ssZ"
function normLoose(s?: string) {
  if (!s) return undefined;
  let t = String(s).trim();
  if (t.includes("T")) t = t.split("T")[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : undefined;
}

/**
 * Acepta diasHabiles en formato getDay() (0..6) o ISO (1..7).
 * Si detecta un 7, asume ISO (1..7, donde 7=Domingo); si no, asume getDay().
 */
function buildIsWorkdayChecker(diasHabiles?: number[]) {
  const list = Array.isArray(diasHabiles) && diasHabiles.length ? diasHabiles : [1, 2, 3, 4, 5, 6];
  const usesISO = list.some((n) => n === 7) || list.every((n) => n >= 1 && n <= 7);
  const set = new Set(list);
  if (usesISO) {
    // ISO: 1..7 (Lun..Dom). JS getDay(): 0..6 (Dom..Sab)
    return (dow0to6: number) => {
      const iso = dow0to6 === 0 ? 7 : dow0to6; // 0(Dom) -> 7
      return set.has(iso);
    };
  }
  // getDay(): 0..6
  return (dow0to6: number) => set.has(dow0to6);
}

/**
 * Genera días operativos desde fechaInicio hasta hoy (ambos YYYY-MM-DD),
 * excluyendo no hábiles, feriados y pausas. Si maxDias está definido (ej. cuotas),
 * se trunca a ese tope.
 *
 * 🔧 Importante: el primer día de cobro es el día SIGUIENTE a fechaInicio.
 */
export function generarDiasOperativos({
  fechaInicio,
  hoy,
  diasHabiles = [1, 2, 3, 4, 5, 6], // por defecto Lun..Sab (ISO)
  feriados = [],
  pausas = [],
  maxDias,
}: {
  fechaInicio: string;
  hoy: string;
  diasHabiles?: number[]; // getDay(): 0..6 o ISO: 1..7 (auto-detectado)
  feriados?: string[]; // YYYY-MM-DD
  pausas?: Rango[]; // rangos [desde,hasta] inclusive
  maxDias?: number;
}) {
  if (!isISO(fechaInicio) || !isISO(hoy)) return [];
  const start = strToDate(fechaInicio);
  const end = strToDate(hoy);
  if (end < start) return [];

  const isWorkday = buildIsWorkdayChecker(diasHabiles);

  const pausaSet = new Set<string>();
  for (const r of pausas || []) {
    if (!isISO(r.desde) || !isISO(r.hasta)) continue;
    for (let d = strToDate(r.desde); d <= strToDate(r.hasta); d = addDays(d, 1)) {
      pausaSet.add(dateToStr(d));
    }
  }
  const feriadoSet = new Set(feriados || []);

  const out: string[] = [];
  // ⬇️ Arrancar el conteo desde el día siguiente a fechaInicio
  for (let d = addDays(start, 1); d <= end; d = addDays(d, 1)) {
    const dow = d.getDay(); // 0..6; domingo=0
    const iso = dateToStr(d);
    if (!isWorkday(dow)) continue;     // excluye no hábiles (según formato detectado)
    if (feriadoSet.has(iso)) continue; // excluye feriados
    if (pausaSet.has(iso)) continue;   // excluye pausas
    out.push(iso);
    if (maxDias && out.length >= maxDias) break; // tope (ej. cuotas)
  }
  return out;
}

/**
 * Calcula días de atraso con dos modos:
 * - porPresencia: cualquier abono en un día operativo cubre ese día.
 * - porCuota: usa créditos = floor(totalAbonado / valorCuota), permite adelantos.
 */
export function calcularDiasAtraso({
  fechaInicio,
  hoy,
  cuotas,
  valorCuota,
  abonos, // [{monto, operationalDate?, fecha?}]
  diasHabiles = [1, 2, 3, 4, 5, 6],
  feriados = [],
  pausas = [],
  modo = "porPresencia",
  permitirAdelantar = false,
}: {
  fechaInicio: string;
  hoy: string;
  cuotas: number;
  valorCuota: number;
  abonos: Array<{ monto: number; operationalDate?: string; fecha?: string }>;
  diasHabiles?: number[];
  feriados?: string[];
  pausas?: Rango[];
  modo?: ModoAtraso;
  permitirAdelantar?: boolean;
}) {
  const diasOperativos = generarDiasOperativos({
    fechaInicio,
    hoy,
    diasHabiles,
    feriados,
    pausas,
    maxDias: cuotas,
  });

  const diasEsperados = diasOperativos.length;

  // --- Modo por presencia (por defecto)
  if (modo === "porPresencia" || !permitirAdelantar) {
    const diasSet = new Set(diasOperativos);
    const pagados = new Set<string>();
    for (const a of abonos || []) {
      const dia = a.operationalDate || normLoose(a.fecha);
      if (dia && diasSet.has(dia)) pagados.add(dia);
    }
    const diasCubiertos = pagados.size;
    const faltas = diasOperativos.filter((d) => !pagados.has(d));
    return {
      diasEsperados,
      diasCubiertos,
      atraso: Math.max(0, diasEsperados - diasCubiertos),
      faltas,
    };
  }

  // --- Modo por cuota (permite adelantos)
  const totalAbonado = (abonos || []).reduce((s, a) => s + (Number(a.monto) || 0), 0);
  const cuota = Number(valorCuota) || 1;
  const creditos = Math.floor(totalAbonado / cuota);
  const diasCubiertos = Math.min(creditos, diasEsperados);
  const atraso = Math.max(0, diasEsperados - diasCubiertos);
  const faltas = diasOperativos.slice(diasCubiertos); // aproximado
  return { diasEsperados, diasCubiertos, atraso, faltas };
}
