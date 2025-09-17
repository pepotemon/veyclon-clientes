// screens/GastosDelDiaScreen.tsx
import React, { useState } from 'react';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { pickTZ, todayInTZ } from '../utils/timezone';

// 🧠 Hook reutilizable (Módulo 3) - named import
import { useMovimientos } from '../utils/useMovimientos';
// 🧩 Componente base de informe (Módulo 3)
import InformeDiario from '../components/InformeDiario';

type Props = NativeStackScreenProps<RootStackParamList, 'GastosDelDia'>;

export default function GastosDelDiaScreen({ route }: Props) {
  const { admin } = route.params;

  // Fecha operativa inicial según TZ de sesión
  const tz = pickTZ('America/Sao_Paulo');
  const [fecha, setFecha] = useState(() => todayInTZ(tz));

  // Trae gastos ADMIN. El hook internamente normaliza tipos legacy/canónicos.
  const { items, total, loading, reload } = useMovimientos({
    admin,
    fecha,
    tipo: 'gastoAdmin', // <- TS de tu hook espera este literal
  });

  return (
    <InformeDiario
      titulo="Gastos del día"
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
