// hooks/useMovimientos.ts
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  collection,
  collectionGroup,
  query,
  where,
  getDocs,
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

function tsFromData(d: any): number {
  if (typeof d?.createdAtMs === 'number') return d.createdAtMs;
  if (typeof d?.createdAt?.seconds === 'number') return d.createdAt.seconds * 1000;
  if (typeof d?.fechaInicio?.seconds === 'number') return d.fechaInicio.seconds * 1000; // prestamos
  return 0;
}

function ymdFromAny(dateLike: any, tz: string): string | null {
  try {
    const dt = (() => {
      if (!dateLike) return null;
      if (typeof dateLike === 'number') return new Date(dateLike);
      if (typeof dateLike?.seconds === 'number') return new Date(dateLike.seconds * 1000);
      if (typeof dateLike?.toDate === 'function') return dateLike.toDate();
      if (dateLike instanceof Date) return dateLike;
      return null;
    })();
    if (!dt) return null;
    // formatear en TZ -> YYYY-MM-DD
    const parts = new Intl.DateTimeFormat('es-ES', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(dt);
    const y = parts.find(p => p.type === 'year')?.value ?? '0000';
    const m = parts.find(p => p.type === 'month')?.value ?? '01';
    const d = parts.find(p => p.type === 'day')?.value ?? '01';
    return `${y}-${m}-${d}`;
  } catch {
    return null;
  }
}

export function useMovimientos({ admin, fecha, tipo }: Params): Result {
  const [items, setItems] = useState<MovimientoItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const tzFallback = useMemo(() => pickTZ('America/Sao_Paulo'), []);
  const fmtHoraFallback = useMemo(
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

      // nombre de cliente (con varios fallbacks)
      const cliente: string =
        (data?.clienteNombre ??
          data?.cliente?.nombre ??
          data?.clienteName ??
          '') as string;

      // Nota/concepto auxiliares
      let nota: string | null = (data?.nota ?? '').toString().trim() || null;
      const concepto: string = (data?.concepto ?? '').toString().trim();

      // 👇 Tipo canónico SIEMPRE
      const tCanon = canonicalTipo(data?.tipo);

      let title = 'Movimiento';

      if (tCanon === 'ingreso') {
        title = cliente?.trim() || 'Ingreso';
        if (!nota && concepto) nota = concepto;
      } else if (tCanon === 'retiro') {
        title = cliente?.trim() || 'Retiro';
        if (!nota && concepto) nota = concepto;
      } else if (tCanon === 'gasto_admin') {
        // Gastos suelen NO tener cliente => mantenemos categoría o fallback
        title = cliente?.trim() || (data?.categoria ?? '').toString().trim() || 'Gasto admin';
        if (!nota && data?.descripcion) nota = String(data.descripcion);
        if (!nota && concepto) nota = concepto;
      } else if (tCanon === 'gasto_cobrador') {
        title = cliente?.trim() || (data?.categoria ?? '').toString().trim() || 'Gasto cobrador';
        if (!nota && data?.descripcion) nota = String(data.descripcion);
        if (!nota && concepto) nota = concepto;
      } else if (tCanon === 'abono') {
        // ✅ SOLO nombre (sin “Pago — ”)
        title = cliente?.trim() || 'Cliente';
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
      // 1) Tipos que salen de cajaDiaria (simple)
      if (tipo === 'ingreso' || tipo === 'retiro') {
        const qy = query(
          collection(db, 'cajaDiaria'),
          where('admin', '==', admin),
          where('operationalDate', '==', fecha),
          where('tipo', '==', tipo)
        );
        const snap = await getDocs(qy);
        const arr = snap.docs.map(d => mapDocToItem(d.id, d.data()));
        arr.sort(
          (a, b) =>
            (b.raw?.createdAtMs ?? b.raw?.createdAt?.seconds ?? 0) -
            (a.raw?.createdAtMs ?? a.raw?.createdAt?.seconds ?? 0)
        );
        setItems(arr);
        setTotal(arr.reduce((acc, it) => acc + (Number(it.monto) || 0), 0));
        return;
      }

      // 1.b) Gasto Admin: soporta 'gastoAdmin' (actual) y 'gasto_admin' (legacy)
      if (tipo === 'gastoAdmin') {
        const qNew = query(
          collection(db, 'cajaDiaria'),
          where('admin', '==', admin),
          where('operationalDate', '==', fecha),
          where('tipo', '==', 'gastoAdmin')
        );
        const qLegacy = query(
          collection(db, 'cajaDiaria'),
          where('admin', '==', admin),
          where('operationalDate', '==', fecha),
          where('tipo', '==', 'gasto_admin')
        );
        const [s1, s2] = await Promise.all([getDocs(qNew), getDocs(qLegacy)]);
        const arr = [...s1.docs, ...s2.docs].map(d => mapDocToItem(d.id, d.data()));
        arr.sort(
          (a, b) =>
            (b.raw?.createdAtMs ?? b.raw?.createdAt?.seconds ?? 0) -
            (a.raw?.createdAtMs ?? a.raw?.createdAt?.seconds ?? 0)
        );
        setItems(arr);
        setTotal(arr.reduce((acc, it) => acc + (Number(it.monto) || 0), 0));
        return;
      }

      // 1.c) Gasto Cobrador: soporta 'gastoCobrador' (actual) y 'gasto'/'gasto_cobrador' (legacy)
      if (tipo === 'gastoCobrador') {
        const qNew = query(
          collection(db, 'cajaDiaria'),
          where('admin', '==', admin),
          where('operationalDate', '==', fecha),
          where('tipo', '==', 'gastoCobrador')
        );
        const qLegacy1 = query(
          collection(db, 'cajaDiaria'),
          where('admin', '==', admin),
          where('operationalDate', '==', fecha),
          where('tipo', '==', 'gasto')
        );
        const qLegacy2 = query(
          collection(db, 'cajaDiaria'),
          where('admin', '==', admin),
          where('operationalDate', '==', fecha),
          where('tipo', '==', 'gasto_cobrador')
        );

        const [s1, s2, s3] = await Promise.all([getDocs(qNew), getDocs(qLegacy1), getDocs(qLegacy2)]);
        const arr = [...s1.docs, ...s2.docs, ...s3.docs].map(d => mapDocToItem(d.id, d.data()));
        arr.sort(
          (a, b) =>
            (b.raw?.createdAtMs ?? b.raw?.createdAt?.seconds ?? 0) -
            (a.raw?.createdAtMs ?? a.raw?.createdAt?.seconds ?? 0)
        );
        setItems(arr);
        setTotal(arr.reduce((acc, it) => acc + (Number(it.monto) || 0), 0));
        return;
      }

      // 2) Pagos: incluir 'abono' + 'pago'
      if (tipo === 'pago') {
        const qAbono = query(
          collection(db, 'cajaDiaria'),
          where('admin', '==', admin),
          where('operationalDate', '==', fecha),
          where('tipo', '==', 'abono')
        );
        const qPago = query(
          collection(db, 'cajaDiaria'),
          where('admin', '==', admin),
          where('operationalDate', '==', fecha),
          where('tipo', '==', 'pago')
        );
        const [s1, s2] = await Promise.all([getDocs(qAbono), getDocs(qPago)]);
        const arr = [...s1.docs, ...s2.docs].map(d => mapDocToItem(d.id, d.data()));
        arr.sort(
          (a, b) =>
            (b.raw?.createdAtMs ?? b.raw?.createdAt?.seconds ?? 0) -
            (a.raw?.createdAtMs ?? a.raw?.createdAt?.seconds ?? 0)
        );
        setItems(arr);
        setTotal(arr.reduce((acc, it) => acc + (Number(it.monto) || 0), 0));
        return;
      }

      // 3) Ventas (préstamos creados hoy por el admin)
      if (tipo === 'venta') {
        const qPrest = query(collectionGroup(db, 'prestamos'), where('creadoPor', '==', admin));
        const snap = await getDocs(qPrest);

        const arr: MovimientoItem[] = [];
        snap.forEach((d) => {
          const data: any = d.data();
          const tz = data?.tz || tzFallback;
          const ymd =
            ymdFromAny(
              typeof data?.createdAtMs === 'number'
                ? data.createdAtMs
                : (data?.createdAt ?? data?.fechaInicio),
              tz
            );
          if (ymd !== fecha) return;

          const ts = tsFromData(data) || Date.now();
          const hora = new Intl.DateTimeFormat('pt-BR', {
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: tz,
          }).format(new Date(ts));

          const cliente: string =
            (data?.clienteNombre ??
              data?.cliente?.nombre ??
              data?.clienteName ??
              '') as string;
          const concepto: string = (data?.concepto ?? data?.producto ?? '').toString().trim();

          const monto = Number(data?.valorNeto ?? data?.capital ?? 0);
          arr.push({
            id: d.id,
            // ✅ SOLO nombre (sin “Venta — ”). Fallback genérico si no hay nombre.
            title: cliente?.trim() || 'Préstamo',
            monto: Number.isFinite(monto) ? monto : 0,
            hora,
            nota: concepto || null,
            raw: data,
          });
        });

        arr.sort((a, b) => tsFromData(b.raw) - tsFromData(a.raw));
        setItems(arr);
        setTotal(arr.reduce((acc, it) => acc + (Number(it.monto) || 0), 0));
        return;
      }
    } catch (e) {
      console.warn('[useMovimientos] error:', e);
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [admin, fecha, tipo, mapDocToItem, tzFallback]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { items, total, loading, reload };
}

// ✅ Export nombrado y default
export default useMovimientos;
