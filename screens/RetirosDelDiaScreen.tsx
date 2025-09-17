// screens/RetirosDelDiaScreen.tsx
import React, { useState } from 'react';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { pickTZ, todayInTZ } from '../utils/timezone';

// 🧠 Hook reutilizable
import { useMovimientos } from '../utils/useMovimientos';
// 🧩 Componente base de informe
import InformeDiario from '../components/InformeDiario';

type Props = NativeStackScreenProps<RootStackParamList, 'RetirosDelDia'>;

export default function RetirosDelDiaScreen({ route }: Props) {
  const { admin } = route.params;

  // Fecha operativa inicial según TZ de sesión
  const tz = pickTZ('America/Sao_Paulo');
  const [fecha, setFecha] = useState(() => todayInTZ(tz));

  // Trae retiros del día
  const { items, total, loading, reload } = useMovimientos({
    admin,
    fecha,
    tipo: 'retiro',
  });

  return (
    <InformeDiario
      titulo="Retiros"
      kpiLabel="Retiros"
      icon="cash-remove"
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
