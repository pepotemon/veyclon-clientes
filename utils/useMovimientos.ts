import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  collection,
  getDocs,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../firebase/firebaseConfig';
import { pickTZ } from '../utils/timezone';
import { canonicalTipo } from '../utils/movimientoHelper';

export type TipoMovimiento =
  | 'ingreso'
  | 'retiro'
  | 'gastoAdmin'
  | 'gastoCobrador'
  | 'pago'
  | 'venta';

export type MovimientoItem = {
  id: string;
  title: string;         // texto corto para la fila (solo nombre de cliente si aplica)
  monto: number;
  hora: string;          // HH:mm:ss (formateado en la TZ del doc o fallback)
  nota?: string | null;
  categoria?: string;
  raw?: any;             // por si quieres debuggear
};

type Params = {
  admin: string;
  fecha: string;           // YYYY-MM-DD
  tipo: TipoMovimiento;
};

type Result = {
  items: MovimientoItem[];
  total: number;
  loading: boolean;
  reload: () => Promise<void>;
};

// ===== Helpers =====
function tsFromData(d: any): number {
  if (typeof d?.createdAtMs === 'number') return d.createdAtMs;
  if (typeof d?.createdAt?.seconds === 'number') return d.createdAt.seconds * 1000;
  return 0;
}

function buildTiposFiltro(tipo: TipoMovimiento): string[] {
  // 🔁 Acepta variantes legacy + canónicas
  switch (tipo) {
    case 'ingreso': return ['ingreso'];
    case 'retiro': return ['retiro'];
    case 'gastoAdmin': return ['gastoAdmin', 'gasto_admin'];
    case 'gastoCobrador': return ['gastoCobrador', 'gasto', 'gasto_cobrador'];
    case 'pago': return ['abono', 'pago'];
    case 'venta': return ['prestamo', 'venta']; // “ventas” registradas en caja
    default: return [];
  }
}

export function useMovimientos({ admin, fecha, tipo }: Params): Result {
  const [items, setItems] = useState<MovimientoItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const tzFallback = useMemo(() => pickTZ('America/Sao_Paulo'), []);
  const fmtHora = useMemo(
    () =>
      new Intl.DateTimeFormat('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: tzFallback,
      }),
    [tzFallback]
  );

  const mapDocToItem = useCallback(
    (id: string, data: any): MovimientoItem => {
      const tz = data?.tz || tzFallback;
      const ts = tsFromData(data) || Date.now();
      const hora = new Intl.DateTimeFormat('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: tz,
      }).format(new Date(ts));

      const tCanon = canonicalTipo(data?.tipo);
      const cliente: string =
        (data?.clienteNombre ??
          data?.cliente?.nombre ??
          data?.clienteName ??
          '') as string;

      let title = 'Movimiento';
      let nota: string | null = (data?.nota ?? '').toString().trim() || null;
      const concepto: string = (data?.concepto ?? '').toString().trim();

      if (tCanon === 'ingreso') {
        title = cliente?.trim() || 'Ingreso';
        if (!nota && concepto) nota = concepto;
      } else if (tCanon === 'retiro') {
        title = cliente?.trim() || 'Retiro';
        if (!nota && concepto) nota = concepto;
      } else if (tCanon === 'gasto_admin') {
        title = cliente?.trim() || (data?.categoria ?? '').toString().trim() || 'Gasto admin';
        if (!nota && data?.descripcion) nota = String(data.descripcion);
        if (!nota && concepto) nota = concepto;
      } else if (tCanon === 'gasto_cobrador') {
        title = cliente?.trim() || (data?.categoria ?? '').toString().trim() || 'Gasto cobrador';
        if (!nota && data?.descripcion) nota = String(data.descripcion);
        if (!nota && concepto) nota = concepto;
      } else if (tCanon === 'abono') {
        title = cliente?.trim() || 'Cliente'; // ✅ sin prefijos
        if (!nota && concepto) nota = concepto;
      } else if (tCanon === 'prestamo') {
        title = cliente?.trim() || 'Préstamo'; // ✅ ventas desde caja
        if (!nota && concepto) nota = concepto;
      } else if (tCanon === 'apertura') {
        title = 'Apertura';
      } else if (tCanon === 'cierre') {
        title = 'Cierre';
      }

      return {
        id,
        title,
        monto: Number(data?.monto || 0),
        hora,
        nota,
        categoria: data?.categoria || undefined,
        raw: data,
      };
    },
    [tzFallback]
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      // ✅ Exclusivo de cajaDiaria + filtros baratos
      const tipos = buildTiposFiltro(tipo);
      // Si ‘tipo’ mapea a varios, haremos varias queries pequeñas y uniremos
      const queries = tipos.length <= 1
        ? [
            query(
              collection(db, 'cajaDiaria'),
              where('admin', '==', admin),
              where('operationalDate', '==', fecha),
              where('tipo', '==', tipos[0] ?? tipo) // por si faltara mapeo
            ),
          ]
        : tipos.map((t) =>
            query(
              collection(db, 'cajaDiaria'),
              where('admin', '==', admin),
              where('operationalDate', '==', fecha),
              where('tipo', '==', t)
            )
          );

      const snaps = await Promise.all(queries.map((q) => getDocs(q)));
      const arr = snaps
        .flatMap((s) => s.docs)
        .map((d) => mapDocToItem(d.id, d.data()));

      // Orden local por createdAtMs/createdAt (desc)
      arr.sort(
        (a, b) =>
          (b.raw?.createdAtMs ?? b.raw?.createdAt?.seconds ?? 0) -
          (a.raw?.createdAtMs ?? a.raw?.createdAt?.seconds ?? 0)
      );

      setItems(arr);
      setTotal(arr.reduce((acc, it) => acc + (Number(it.monto) || 0), 0));
    } catch (e) {
      console.warn('[useMovimientos] error:', e);
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [admin, fecha, tipo, mapDocToItem]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { items, total, loading, reload };
}

export default useMovimientos;
