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
  createdDate?: string; // YYYY-MM-DD denormalizado
  estado?: string;
  // datos top-level de cliente (denormalizados)
  clienteAlias?: string;
  clienteDireccion1?: string;
  clienteDireccion2?: string;
  clienteTelefono1?: string;
  // abonos (si los necesitas)
  abonos?: Array<{ monto: number; operationalDate?: string; createdAtMs?: number }>;
};

export function normalizePrestamo(d: any, id: string): PrestamoNorm {
  const tz = typeof d?.tz === 'string' ? d.tz : undefined;

  // createdDate preferido (string YYYY-MM-DD). Fallbacks: createdAtMs / createdAt / fechaInicio.
  const createdMs =
    (typeof d?.createdAtMs === 'number' && d.createdAtMs) ||
    (typeof d?.createdAt?.seconds === 'number' && d.createdAt.seconds * 1000) ||
    (typeof d?.fechaInicio?.seconds === 'number' && d.fechaInicio.seconds * 1000) ||
    0;

  const createdDate = typeof d?.createdDate === 'string' && d.createdDate
    ? d.createdDate
    : (createdMs ? new Date(createdMs).toISOString().slice(0, 10) : undefined);

  return {
    id,
    creadoPor: String(d?.creadoPor || ''),
    clienteId: d?.clienteId ? String(d.clienteId) : undefined,
    concepto: (d?.concepto ?? '').toString().trim() || 'Sin nombre',
    restante: Number(d?.restante || 0),
    valorCuota: Number(d?.valorCuota || 0),
    tz,
    createdAtMs: createdMs || undefined,
    createdDate,
    estado: typeof d?.estado === 'string' ? d.estado : undefined,

    clienteAlias: d?.clienteAlias ?? d?.clienteNombre ?? '',
    clienteDireccion1: d?.clienteDireccion1 ?? '',
    clienteDireccion2: d?.clienteDireccion2 ?? '',
    clienteTelefono1: d?.clienteTelefono1 ?? '',

    abonos: Array.isArray(d?.abonos)
      ? d.abonos.map((a: any) => ({
          monto: Number(a?.monto || 0),
          operationalDate:
            typeof a?.operationalDate === 'string' ? a.operationalDate : undefined,
          createdAtMs:
            (typeof a?.createdAtMs === 'number' && a.createdAtMs) ||
            (typeof a?.createdAt?.seconds === 'number' && a.createdAt.seconds * 1000) ||
            undefined,
        }))
      : undefined,
  };
}

/** Activo por `restante>0` (contempla que `estado` pueda no existir). */
export function isActivo(p: PrestamoNorm): boolean {
  if (typeof p.restante === 'number' && p.restante > 0) return true;
  if (p.estado && p.estado.toLowerCase() !== 'activo') return false;
  return false;
}
