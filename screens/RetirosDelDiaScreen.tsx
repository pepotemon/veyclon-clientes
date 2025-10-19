// screens/RetirosDelDiaScreen.tsx
import React, { useState } from 'react';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { pickTZ, todayInTZ } from '../utils/timezone';

import { useMovimientos } from '../utils/useMovimientos';
import InformeDiario from '../components/InformeDiario';

type Props = NativeStackScreenProps<RootStackParamList, 'RetirosDelDia'>;

export default function RetirosDelDiaScreen({ route }: Props) {
  const { admin } = route.params;

  const tz = pickTZ('America/Sao_Paulo');
  const [fecha, setFecha] = useState(() => todayInTZ(tz));

  const { items, total, loading, reload } = useMovimientos({
    admin,
    fecha,
    tipo: 'retiro',
  });

  return (
    <InformeDiario
      titulo="Retiros del día"
      kpiLabel="Retiros"
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
