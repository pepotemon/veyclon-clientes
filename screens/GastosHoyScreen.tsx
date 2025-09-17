// screens/GastosHoyScreen.tsx
import React, { useState } from 'react';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { pickTZ, todayInTZ } from '../utils/timezone';

// 🧠 Hook reutilizable (Módulo 3)
import { useMovimientos } from '../utils/useMovimientos';
// 🧩 Componente base de informe (Módulo 3)
import InformeDiario from '../components/InformeDiario';

type Props = NativeStackScreenProps<RootStackParamList, 'GastosHoy'>;

export default function GastosHoyScreen({ route }: Props) {
  const { admin } = route.params;

  // Fecha operativa inicial: hoy según TZ de sesión
  const tz = pickTZ('America/Sao_Paulo');
  const [fecha, setFecha] = useState(() => todayInTZ(tz));

  // Gastos del cobrador (tipo canónico del hook: 'gastoCobrador')
  const { items, total, loading, reload } = useMovimientos({
    admin,
    fecha,
    tipo: 'gastoCobrador',
  });

  return (
    <InformeDiario
      titulo="Gastos de hoy"
      kpiLabel="Gastos"
      fecha={fecha}
      onChangeFecha={setFecha}
      items={items}
      total={total}
      loading={loading}
      emptyText="No hay retiros para esta fecha."
      onRefresh={reload}
    />
  );
}
