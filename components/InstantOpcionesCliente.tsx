// components/InstantOpcionesCliente.tsx
import React, { useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Pressable,
  Platform,
  BackHandler,
} from 'react-native';
import { MaterialCommunityIcons as MIcon } from '@expo/vector-icons';
import { useAppTheme } from '../theme/ThemeProvider';

type Opcion = 'pago' | 'historial' | 'modificar' | 'info' | 'cancelar' | 'historialPrestamos';

type Props = {
  visible: boolean;
  onCerrar: () => void;
  onSeleccionarOpcion: (opcion: Opcion) => void;
  cliente: { nombre: string; comercio?: string };
};

export default function InstantOpcionesCliente({
  visible,
  onCerrar,
  onSeleccionarOpcion,
  cliente,
}: Props) {
  const { palette, isDark } = useAppTheme();
  const accent = palette.accent ?? '#2e7d32';

  // Cerrar con botón "atrás" del sistema solo cuando está visible
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onCerrar();
      return true;
    });
    return () => sub.remove();
  }, [visible, onCerrar]);

  // Ultra rápido: si no está visible, no montamos nada (cero costo)
  if (!visible) return null;

  return (
    <View
      style={styles.overlay}
      accessible
      accessibilityViewIsModal
      accessibilityLiveRegion="polite"
    >
      {/* backdrop */}
      <Pressable style={styles.backdrop} onPress={onCerrar} />

      {/* tarjeta compacta */}
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: palette.cardBg,
            borderColor: palette.cardBorder,
            // ligera sombra iOS; Android se ve limpio sin elevation
            ...Platform.select({
              ios: {
                shadowColor: isDark ? '#000' : '#000',
              },
            }),
          },
        ]}
      >
        <MIcon name="account-circle" size={36} color={accent} style={{ marginBottom: 6 }} />
        <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>
          {cliente?.nombre || 'Cliente'}
        </Text>
        {!!cliente?.comercio && (
          <Text style={[styles.subtitle, { color: palette.softText }]} numberOfLines={1}>
            {cliente.comercio}
          </Text>
        )}

        {/* Opciones compactas y separadas */}
        <RowBtn
          icon="cash-multiple"
          label="Realizar pago"
          onPress={() => onSeleccionarOpcion('pago')}
          palette={palette}
        />
        <RowBtn
          icon="calendar-clock"
          label="Historial de pagos"
          onPress={() => onSeleccionarOpcion('historial')}
          palette={palette}
        />
        <RowBtn
          icon="file-document-outline"
          label="Historial de préstamos"
          onPress={() => onSeleccionarOpcion('historialPrestamos')}
          palette={palette}
        />
        <RowBtn
          icon="information-outline"
          label="Info completa"
          onPress={() => onSeleccionarOpcion('info')}
          palette={palette}
        />
        <RowBtn
          icon="account-edit"
          label="Modificar datos"
          onPress={() => onSeleccionarOpcion('modificar')}
          palette={palette}
        />

        <TouchableOpacity
          style={[
            styles.cancel,
            { backgroundColor: palette.topBg, borderColor: palette.cardBorder },
          ]}
          activeOpacity={0.85}
          onPress={onCerrar}
          accessibilityRole="button"
          accessibilityLabel="Cancelar"
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Text style={[styles.cancelTxt, { color: accent }]}>Cancelar</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function RowBtn({
  icon,
  label,
  onPress,
  palette,
}: {
  icon: React.ComponentProps<typeof MIcon>['name'];
  label: string;
  onPress: () => void;
  palette: ReturnType<typeof useAppTheme>['palette'];
}) {
  return (
    <TouchableOpacity
      style={[
        styles.rowChunk,
        { backgroundColor: palette.kpiTrack, borderColor: palette.cardBorder },
      ]}
      activeOpacity={0.9}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
    >
      <View style={styles.rowChunkLeft}>
        <MIcon name={icon} size={20} color={palette.softText} />
        <Text style={[styles.rowChunkTxt, { color: palette.text }]} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <MIcon name="chevron-right" size={20} color={palette.softText} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    inset: 0,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  backdrop: {
    position: 'absolute',
    left: 0, right: 0, top: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  // Angosto y con poco padding → sensación de inmediatez visual
  sheet: {
    width: '76%',
    maxWidth: 320,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
    alignItems: 'center',
    borderWidth: 1,
    ...Platform.select({
      ios: {
        shadowOpacity: 0.07,
        shadowRadius: 5,
        shadowOffset: { width: 0, height: 2 },
      },
      android: {},
    }),
  },
  title: { fontSize: 16, fontWeight: '800', marginBottom: 2, textAlign: 'center' },
  subtitle: { fontSize: 12, marginBottom: 10, textAlign: 'center' },

  // Botón compacto pero con separación vertical generosa
  rowChunk: {
    width: '100%',
    minHeight: 44,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    marginVertical: 7, // espacio ENTRE opciones
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowChunkLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  rowChunkTxt: {
    fontSize: 14.5,
    fontWeight: '700',
    letterSpacing: 0.2,
    flexShrink: 1,
  },

  // Cancelar compacto
  cancel: {
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: 10,
    width: '100%',
    alignItems: 'center',
    borderWidth: 1,
  },
  cancelTxt: { fontSize: 14, fontWeight: '800' },
});
