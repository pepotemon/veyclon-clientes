// screens/GastosHoyScreen.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { pickTZ, todayInTZ } from '../utils/timezone';

// Hook reutilizable
import { useMovimientos } from '../utils/useMovimientos';
// Componente base
import InformeDiario from '../components/InformeDiario';

// 🔐 Contexto de auth unificada (tenant/rol/ruta)
import { getAuthCtx } from '../utils/authCtx';
import type { MovimientoItem } from '../utils/useMovimientos';

type Props = NativeStackScreenProps<RootStackParamList, 'GastosHoy'>;

type Movimiento = {
  id?: string;
  tipo?: string;
  monto?: number;
  rutaId?: string | null;
  tenantId?: string | null;
  admin?: string;
  fecha?: string;              // YYYY-MM-DD
  operationalDate?: string;    // preferida
  categoria?: string;
  nota?: string | null;
  createdAtMs?: number;
  createdAt?: { seconds?: number };
  [k: string]: any;
};

export default function GastosHoyScreen({ route }: Props) {
  const { admin } = route.params;

  // Fecha operativa inicial: hoy según TZ de sesión
  const tz = pickTZ('America/Sao_Paulo');
  const [fecha, setFecha] = useState(() => todayInTZ(tz));

  // 🔐 Contexto Auth (tenant/rol/ruta) para scoping local
  const [ctx, setCtx] = useState<{
    tenantId: string | null;
    role: 'collector' | 'admin' | 'superadmin' | null;
    rutaId: string | null;
  } | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const c = await getAuthCtx();
      if (!mounted) return;
      setCtx({
        tenantId: c?.tenantId ?? null,
        role: (c?.role as any) ?? null,
        rutaId: c?.rutaId ?? null,
      });
    })();
    return () => { mounted = false; };
  }, []);

  // Gastos del cobrador (el hook normaliza tipos legacy/canónicos)
  const { items, total, loading, reload } = useMovimientos({
    admin,
    fecha,
    tipo: 'gastoCobrador',
  });

  // 🔒 Scoping LOCAL (mientras el hook no filtre por tenant/ruta en Firestore)
  const scoped = useMemo(() => {
    if (!Array.isArray(items)) return [] as Movimiento[];
    const list = items as unknown as Movimiento[];

    // 1) Fecha operativa exacta
    const byDate = list.filter((m) => {
      const od = (m.operationalDate || m.fecha) as string | undefined;
      return od ? od === fecha : true;
    });

    // 2) tenantId si el doc lo trae
    const byTenant = ctx?.tenantId
      ? byDate.filter((m) => (m.tenantId ?? null) === ctx.tenantId)
      : byDate;

    // 3) si es collector con rutaId, limitar a su ruta
    const byRoute =
      ctx?.role === 'collector' && ctx.rutaId
        ? byTenant.filter((m) => (m.rutaId ?? null) === ctx.rutaId)
        : byTenant;

    return byRoute;
  }, [items, ctx?.tenantId, ctx?.role, ctx?.rutaId, fecha]);

  // ✅ Formateador de hora — ¡usa .format()!
  const fmtHora = useMemo(
    () =>
      new Intl.DateTimeFormat('es-AR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: tz,
      }),
    [tz]
  );

  // Adaptar a MovimientoItem[] para InformeDiario (title + hora obligatorios)
  const displayItems: MovimientoItem[] = useMemo(() => {
    return scoped.map((m) => {
      const ts =
        (typeof m.createdAtMs === 'number' && m.createdAtMs) ||
        (typeof m.createdAt?.seconds === 'number' && m.createdAt.seconds * 1000) ||
        Date.now();

      return {
        id: String(m.id ?? ts),
        title: (m.categoria || 'Gasto'),           // nombre corto de fila
        monto: Number(m.monto || 0),
        hora: fmtHora.format(new Date(ts)),        // 👈 aquí va .format()
        nota: m.nota ?? null,
        categoria: m.categoria || undefined,
        raw: m,
      };
    });
  }, [scoped, fmtHora]);

  // Recalcular total por si el scoping filtró elementos
  const scopedTotal = useMemo(
    () =>
      displayItems.reduce((acc, it) => {
        const v = Number(it.monto || 0);
        return acc + (isFinite(v) ? v : 0);
      }, 0),
    [displayItems]
  );

  return (
    <InformeDiario
      titulo="Gastos de hoy"
      kpiLabel="Gastos"
      fecha={fecha}
      onChangeFecha={setFecha}
      items={displayItems}
      total={scopedTotal}
      loading={loading}
      emptyText="No hay gastos para esta fecha."
      onRefresh={reload}
    />
  );
}
