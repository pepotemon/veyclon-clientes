// utils/prestamoNormalize.ts
import { pickTZ } from './timezone';

export type PrestamoNorm = {
  id: string;
  creadoPor: string;
  clienteId?: string;
  concepto: string;
  restante: number;
  valorCuota: number;
  tz?: string;
  createdAtMs?: number;
  createdDate?: string; // YYYY-MM-DD (denormalizado, en TZ del préstamo)
  estado?: string;

  // datos top-level de cliente (denormalizados)
  clienteAlias?: string;
  clienteDireccion1?: string;
  clienteDireccion2?: string;
  clienteTelefono1?: string;

  // abonos embebidos (solo si existen en el doc raíz)
  abonos?: Array<{ monto: number; operationalDate?: string; createdAtMs?: number }>;
};

/** Formatea YYYY-MM-DD en una TZ dada. */
function toYMDInTZ(ms: number, tz: string): string {
  // usamos el formateador estable que venimos usando (en-CA → YYYY-MM-DD)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

export function normalizePrestamo(d: any, id: string): PrestamoNorm {
  const tz = pickTZ(d?.tz); // asegura una TZ válida (fallback: 'America/Sao_Paulo')

  // createdAtMs (robusto a varios orígenes)
  const createdMs =
    (typeof d?.createdAtMs === 'number' && isFinite(d.createdAtMs) && d.createdAtMs) ||
    (typeof d?.createdAt?.seconds === 'number' && d.createdAt.seconds * 1000) ||
    (typeof d?.fechaInicio?.seconds === 'number' && d.fechaInicio.seconds * 1000) ||
    0;

  // createdDate preferido; si no viene, lo derivamos de createdAtMs respetando la TZ del préstamo
  const createdDate =
    (typeof d?.createdDate === 'string' && d.createdDate) ||
    (createdMs ? toYMDInTZ(createdMs, tz) : undefined);

  const restanteNum = Number(d?.restante ?? 0);
  const valorCuotaNum = Number(d?.valorCuota ?? 0);

  return {
    id,
    creadoPor: String(d?.creadoPor ?? ''),
    clienteId: d?.clienteId ? String(d.clienteId) : undefined,
    concepto: (d?.concepto ?? '').toString().trim() || 'Sin nombre',
    restante: Number.isFinite(restanteNum) ? restanteNum : 0,
    valorCuota: Number.isFinite(valorCuotaNum) ? valorCuotaNum : 0,
    tz,
    createdAtMs: createdMs || undefined,
    createdDate,
    estado: typeof d?.estado === 'string' ? d.estado : undefined,

    // denormalizados de cliente si existen
    clienteAlias: d?.clienteAlias ?? d?.clienteNombre ?? '',
    clienteDireccion1: d?.clienteDireccion1 ?? '',
    clienteDireccion2: d?.clienteDireccion2 ?? '',
    clienteTelefono1: d?.clienteTelefono1 ?? '',

    // compat: si el doc aún trae abonos embebidos
    abonos: Array.isArray(d?.abonos)
      ? d.abonos.map((a: any) => {
          const cam =
            (typeof a?.createdAtMs === 'number' && isFinite(a.createdAtMs) && a.createdAtMs) ||
            (typeof a?.createdAt?.seconds === 'number' && a.createdAt.seconds * 1000) ||
            undefined;
          const monto = Number(a?.monto ?? 0);
          return {
            monto: Number.isFinite(monto) ? monto : 0,
            operationalDate: typeof a?.operationalDate === 'string' ? a.operationalDate : undefined,
            createdAtMs: cam,
          };
        })
      : undefined,
  };
}

/** Activo si: restante > 0; si no hay restante, respeta 'estado' textual (activo vs. no). */
export function isActivo(p: PrestamoNorm): boolean {
  if (typeof p.restante === 'number' && p.restante > 0) return true;
  if (typeof p.estado === 'string') return p.estado.trim().toLowerCase() === 'activo';
  return false;
}
