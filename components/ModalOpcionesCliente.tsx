// components/ModalOpcionesCliente.tsx
import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { MaterialCommunityIcons as MIcon } from '@expo/vector-icons';

type Props = {
  visible: boolean;
  onCerrar: () => void;
  onSeleccionarOpcion: (
    opcion: 'pago' | 'historial' | 'modificar' | 'info' | 'cancelar' | 'historialPrestamos'
  ) => void;
  cliente: {
    nombre: string;
    comercio: string;
  };
};

export default function ModalOpcionesCliente({
  visible,
  onCerrar,
  onSeleccionarOpcion,
  cliente,
}: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="none" // ✅ instantáneo
      onRequestClose={onCerrar}
    >
      <View style={styles.overlay}>
        {/* Tap fuera para cerrar */}
        <TouchableOpacity
          activeOpacity={1}
          onPress={onCerrar}
          style={styles.backdrop}
        />

        <View style={styles.modal}>
          {/* Encabezado */}
          <MIcon name="account-circle" size={48} color={GREEN} style={{ marginBottom: 8 }} />
          <Text style={styles.titulo} numberOfLines={1}>{cliente.nombre}</Text>
          {!!cliente.comercio && (
            <Text style={styles.subtitulo} numberOfLines={1}>{cliente.comercio}</Text>
          )}

          {/* Opciones */}
          <RowBtn
            icon="cash-multiple"
            label="Realizar pago"
            onPress={() => onSeleccionarOpcion('pago')}
          />

          <RowBtn
            icon="calendar-clock"
            label="Historial de pagos"
            onPress={() => onSeleccionarOpcion('historial')}
          />

          <RowBtn
            icon="file-document-outline"
            label="Historial de préstamos"
            onPress={() => onSeleccionarOpcion('historialPrestamos')}
          />

          <RowBtn
            icon="information-outline"
            label="Info completa"
            onPress={() => onSeleccionarOpcion('info')}
          />

          <RowBtn
            icon="account-edit"
            label="Modificar datos"
            onPress={() => onSeleccionarOpcion('modificar')}
          />

          {/* Cancelar */}
          <TouchableOpacity
            style={styles.opcionCancelar}
            onPress={onCerrar}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            activeOpacity={0.85}
          >
            <Text style={styles.textoCancelar}>Cancelar</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function RowBtn({
  icon,
  label,
  onPress,
}: {
  icon: React.ComponentProps<typeof MIcon>['name'];
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.opcion} onPress={onPress} activeOpacity={0.85}>
      <View style={styles.rowLeft}>
        <MIcon name={icon} size={20} color="#455A64" />
        <Text style={styles.textoOpcion} numberOfLines={1}>{label}</Text>
      </View>
      <MIcon name="chevron-right" size={22} color="#90a4ae" />
    </TouchableOpacity>
  );
}

const GREEN = '#2e7d32';
const LIGHT = '#E8F5E9';

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  modal: {
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 16,
    width: '100%',
    maxWidth: 380,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    alignItems: 'center',
  },

  titulo: {
    fontSize: 18,
    fontWeight: '800',
    color: '#212b21',
    marginBottom: 2,
    textAlign: 'center',
  },
  subtitulo: {
    fontSize: 13,
    color: '#607d8b',
    marginBottom: 14,
    textAlign: 'center',
  },

  opcion: {
    width: '100%',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    paddingRight: 8,
  },
  textoOpcion: {
    fontSize: 15,
    color: '#263238',
    fontWeight: '600',
    flexShrink: 1,
  },

  opcionCancelar: {
    marginTop: 16,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: LIGHT,
    width: '100%',
    alignItems: 'center',
  },
  textoCancelar: {
    fontSize: 15,
    color: GREEN,
    fontWeight: '700',
  },
});
