import React, { useMemo } from 'react';
import {
  Modal,
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { format } from 'date-fns';

type AbonoLike = {
  monto: number;
  fecha: string;             // ISO o parseable por new Date(...)
  // 👇 opcionales que a veces vienen del backend/subcolección:
  id?: string;
  createdAtMs?: number;
  createdAt?: { seconds?: number };
  operationalDate?: string;  // YYYY-MM-DD
};

type Props = {
  visible: boolean;
  onClose: () => void;
  abonos: AbonoLike[];
  nombreCliente: string;
};

function parseFechaToDate(a: AbonoLike): Date {
  // 1) fecha directa
  if (a?.fecha) {
    const d = new Date(a.fecha);
    if (!isNaN(d.getTime())) return d;
  }
  // 2) createdAtMs
  if (typeof a?.createdAtMs === 'number' && isFinite(a.createdAtMs)) {
    return new Date(a.createdAtMs);
  }
  // 3) createdAt.seconds (Firestore)
  const sec = a?.createdAt?.seconds;
  if (typeof sec === 'number' && isFinite(sec)) {
    return new Date(sec * 1000);
  }
  // 4) operationalDate → anclar al mediodía UTC para evitar offset raros
  if (typeof a?.operationalDate === 'string' && a.operationalDate.trim()) {
    const iso = `${a.operationalDate}T12:00:00Z`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d;
  }
  // 5) fallback: ahora
  return new Date();
}

export default function ModalHistorialPagos({
  visible,
  onClose,
  abonos,
  nombreCliente,
}: Props) {
  const abonosOrdenados = useMemo(() => {
    const cloned = [...abonos];
    cloned.sort((a, b) => parseFechaToDate(b).getTime() - parseFechaToDate(a).getTime());
    return cloned;
  }, [abonos]);

  const totalPagado = useMemo(
    () => abonos.reduce((acc, abono) => acc + Number(abono.monto || 0), 0),
    [abonos]
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.modal}>
          <Text style={styles.titulo}>📜 Historial de pagos</Text>
          <Text style={styles.subtitulo}>Cliente: {nombreCliente}</Text>

          <Text style={styles.total}>
            💰 Total abonado: <Text style={styles.totalMonto}>R$ {totalPagado.toFixed(2)}</Text>
          </Text>

          <FlatList
            data={abonosOrdenados}
            keyExtractor={(item, index) =>
              item.id ?? `${index}-${item.fecha ?? ''}-${item.monto}`
            }
            ListEmptyComponent={
              <View style={{ alignItems: 'center', paddingVertical: 12 }}>
                <Text style={{ color: '#666' }}>Aún no hay pagos registrados.</Text>
              </View>
            }
            renderItem={({ item }) => {
              const fecha = parseFechaToDate(item);
              return (
                <View style={styles.item}>
                  <Text style={styles.monto}>💸 R$ {Number(item.monto || 0).toFixed(2)}</Text>
                  <Text style={styles.fecha}>
                    {format(fecha, 'dd/MM/yyyy HH:mm')}
                  </Text>
                </View>
              );
            }}
          />

          <TouchableOpacity onPress={onClose} style={styles.botonCerrar} activeOpacity={0.9}>
            <Text style={styles.textoCerrar}>Cerrar</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modal: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    maxHeight: '80%',
  },
  titulo: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 6,
  },
  subtitulo: {
    fontSize: 14,
    color: '#666',
    marginBottom: 8,
  },
  total: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 12,
    color: '#222',
  },
  totalMonto: {
    color: '#007AFF',
  },
  item: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  monto: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  fecha: {
    fontSize: 12,
    color: '#666',
  },
  botonCerrar: {
    marginTop: 16,
    alignSelf: 'center',
    backgroundColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  textoCerrar: {
    color: '#fff',
    fontWeight: 'bold',
  },
});
