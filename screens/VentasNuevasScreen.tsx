// screens/VentasNuevasScreen.tsx
import React, { useState } from 'react';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { pickTZ, todayInTZ } from '../utils/timezone';

// 👇 Usa el hook (lo tienes en utils)
import { useMovimientos } from '../utils/useMovimientos';
// 👇 Componente base de informe
import InformeDiario from '../components/InformeDiario';

type Props = NativeStackScreenProps<RootStackParamList, 'VentasNuevas'>;

export default function VentasNuevasScreen({ route }: Props) {
  const { admin } = route.params;

  // Fecha operativa inicial en tu TZ
  const tz = pickTZ('America/Sao_Paulo');
  const [fecha, setFecha] = useState(() => todayInTZ(tz));

  // Trae ventas (préstamos creados hoy)
  const { items, total, loading, reload } = useMovimientos({
    admin,
    fecha,
    tipo: 'venta',
  });

  return (
    <InformeDiario
      titulo="Ventas del día"
      kpiLabel="Ventas"
      icon="cash-plus"
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
