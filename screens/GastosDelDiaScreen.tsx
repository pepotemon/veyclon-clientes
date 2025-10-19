// screens/GastosDelDiaScreen.tsx
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { pickTZ, todayInTZ } from '../utils/timezone';

import { db } from '../firebase/firebaseConfig';
import { collection, query, where } from 'firebase/firestore';
import { onSnapshotWithFallback } from '../utils/firestoreFallback';
import { canonicalTipo } from '../utils/movimientoHelper';
import type { MovimientoItem } from '../utils/useMovimientos';
import { format } from 'date-fns';

import InformeDiario from '../components/InformeDiario';

type Props = NativeStackScreenProps<RootStackParamList, 'GastosDelDia'>;

export default function GastosDelDiaScreen({ route }: Props) {
  const { admin } = route.params;

  // Fecha operativa inicial según TZ
  const tz = pickTZ('America/Sao_Paulo');
  const [fecha, setFecha] = useState(() => todayInTZ(tz));

  const [raw, setRaw] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [subVersion, setSubVersion] = useState(0); // para “reload”

  useEffect(() => {
    if (!admin || !fecha) {
      setRaw([]);
      setLoading(false);
      return;
    }
    setLoading(true);

    const qMain = query(
      collection(db, 'cajaDiaria'),
      where('admin', '==', admin),
      where('operationalDate', '==', fecha)
    );

    const unsub = onSnapshotWithFallback(
      qMain,
      null,
      (snap) => {
        const rows: any[] = [];
        snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
        setRaw(rows);
        setLoading(false);
      },
      () => {
        setRaw([]);
        setLoading(false);
      }
    );

    return () => {
      try { unsub && unsub(); } catch {}
    };
  }, [admin, fecha, subVersion]);

  // Filtra a gastos_admin y mapea a MovimientoItem
  const items: MovimientoItem[] = useMemo(() => {
    const gastos = raw
      .filter((r) => canonicalTipo(r?.tipo) === 'gasto_admin')
      .map((r) => {
        const createdMs =
          (typeof r?.createdAtMs === 'number' && isFinite(r.createdAtMs) && r.createdAtMs) ||
          (typeof r?.createdAt?.seconds === 'number' && isFinite(r.createdAt.seconds)
            ? r.createdAt.seconds * 1000
            : 0);

        const title =
          (r?.categoria && String(r.categoria)) ||
          (r?.nota && String(r.nota)) ||
          'Gasto administrativo';

        const hora = createdMs
          ? (() => {
              try { return format(new Date(createdMs), 'HH:mm'); } catch { return '--:--'; }
            })()
          : '--:--';

        return {
          id: r.id,
          title,
          hora,
          monto: Number(r?.monto || 0),
          nota: (r?.nota ?? null) || null,
          categoria: (r?.categoria ?? undefined) || undefined,
          _createdMs: createdMs as number, // interno para ordenar
        } as MovimientoItem & { _createdMs: number };
      });

    // Más recientes primero
    gastos.sort((a, b) => (b._createdMs || 0) - (a._createdMs || 0));

    // Quitamos campo interno
    return gastos.map(({ _createdMs, ...rest }) => rest);
  }, [raw]);

  const total = useMemo(
    () => items.reduce((acc, it) => acc + Number(it.monto || 0), 0),
    [items]
  );

  const reload = useCallback(() => setSubVersion((v) => v + 1), []);

  return (
    <InformeDiario
      titulo="Gastos del día"
      kpiLabel="Gastos"
      icon="cash-minus"
      fecha={fecha}
      onChangeFecha={setFecha}
      items={items}
      total={total}
      loading={loading}
      emptyText="No hay gastos para esta fecha."
      onRefresh={reload}
    />
  );
}
