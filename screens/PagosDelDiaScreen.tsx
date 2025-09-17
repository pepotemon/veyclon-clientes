// screens/PagosDelDiaScreen.tsx
import React, { useState } from 'react';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { pickTZ, todayInTZ } from '../utils/timezone';

// 🧠 Hook reutilizable (Módulo 3)
import { useMovimientos } from '../utils/useMovimientos';
// 🧩 Componente base de informe (Módulo 3)
import InformeDiario from '../components/InformeDiario';

type Props = NativeStackScreenProps<RootStackParamList, 'PagosDelDia'>;

export default function PagosDelDiaScreen({ route }: Props) {
  const { admin } = route.params;

  // Fecha operativa inicial según TZ de sesión
  const tz = pickTZ('America/Sao_Paulo');
  const [fecha, setFecha] = useState(() => todayInTZ(tz));

  // Trae PAGOS del día (incluye 'abono' y 'pago' internamente)
  const { items, total, loading , reload  } = useMovimientos({
    admin,
    fecha,
    tipo: 'pago',
  });

  return (
    <InformeDiario
      titulo="Pagos del día"
      kpiLabel="Pagos"
      fecha={fecha}
      onChangeFecha={setFecha}
      items={items}
      total={total}
      loading={loading}
      emptyText="No hay pagos para esta fecha."
      onRefresh={reload}
    />
  );
}
