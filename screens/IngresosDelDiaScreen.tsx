// screens/IngresosDelDiaScreen.tsx
import React, { useState } from 'react';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { pickTZ, todayInTZ } from '../utils/timezone';

// 🧠 Hook reutilizable (está en utils/useMovimientos.ts en tu proyecto)
import { useMovimientos } from '../utils/useMovimientos';
// 🧩 Componente base de informe
import InformeDiario from '../components/InformeDiario';

type Props = NativeStackScreenProps<RootStackParamList, 'IngresosDelDia'>;

export default function IngresosDelDiaScreen({ route }: Props) {
  const { admin } = route.params;

  // Fecha operativa inicial según TZ de sesión
  const tz = pickTZ('America/Sao_Paulo');
  const [fecha, setFecha] = useState(() => todayInTZ(tz));

  // Trae INGRESOS del día
  const { items, total, loading, reload} = useMovimientos({
    admin,
    fecha,
    tipo: 'ingreso',
  });

  return (
    <InformeDiario
      titulo="Ingresos del día"
      kpiLabel="Ingresos"
      fecha={fecha}
      onChangeFecha={setFecha}
      items={items}
      total={total}
      loading={loading}
      emptyText="No hay ingresos para esta fecha."
      onRefresh={reload}
    />
  );
}
