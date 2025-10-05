// screens/PantallaInformes.tsx
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { useAppTheme } from '../theme/ThemeProvider';

// 👇 badge: contamos outbox con polling liviano
import { subscribeCount, listOutbox } from '../utils/outbox';

type Props = NativeStackScreenProps<RootStackParamList, 'PantallaInformes'>;

export default function PantallaInformes({ navigation, route }: Props) {
  const { palette, isDark } = useAppTheme();
  const { admin } = route.params || {};

  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (!admin) {
      Alert.alert(
        'Error de navegación',
        'No se recibió el usuario administrador correctamente.',
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    }
  }, [admin]);

  // Inicializamos el conteo y nos suscribimos (polling) al outbox
  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      try {
        const list = await listOutbox();
        setPendingCount(Array.isArray(list) ? list.length : 0);
      } catch {
        setPendingCount(0);
      }
      unsub = subscribeCount(setPendingCount);
    })();
    return () => {
      if (unsub) unsub();
    };
  }, []);

  // Pill del numerito (cap a 99+)
  const OutboxBadge = ({ count }: { count: number }) => {
    if (!count) return null;
    const txt = count > 99 ? '99+' : String(count);
    return (
      <View style={[styles.badge, { backgroundColor: palette.accent }]}>
        <Text style={styles.badgeTxt}>{txt}</Text>
      </View>
    );
  };

  const informes = [
    {
      icon: 'file-chart',
      label: 'Ventas Nuevas',
      onPress: () => {
        if (admin) navigation.navigate('VentasNuevas', { admin });
        else Alert.alert('Error', 'Falta información del administrador.');
      },
    },
    {
      icon: 'currency-usd',
      label: 'Pagos Registrados',
      onPress: () => {
        if (admin) navigation.navigate('PagosDelDia', { admin });
        else Alert.alert('Error', 'Falta información del administrador.');
      },
    },
    {
      icon: 'cash-minus',
      label: 'Gastos del Día',
      onPress: () => {
        if (admin) navigation.navigate('GastosDelDia', { admin });
        else Alert.alert('Error', 'Falta información del administrador.');
      },
    },
    {
      icon: 'cash-remove',
      label: 'Retiros',
      onPress: () => {
        if (admin) navigation.navigate('RetirosDelDia', { admin });
        else Alert.alert('Error', 'Falta información del administrador.');
      },
    },
    {
      icon: 'cash-plus',
      label: 'Ingresos',
      onPress: () => {
        if (admin) navigation.navigate('IngresosDelDia', { admin });
        else Alert.alert('Error', 'Falta información del administrador.');
      },
    },
    { icon: 'progress-clock', label: 'Envíos en Cola', onPress: () => navigation.navigate('Pendientes') },
  ];

  return (
      <SafeAreaView
    style={{ flex: 1, backgroundColor: palette.screenBg }}
    edges={['left','right','bottom']}   // 👈 evita el hueco
  >
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      <Text style={[styles.titulo, { color: palette.text }]}>Informes</Text>

      <ScrollView contentContainerStyle={{ paddingBottom: 16 }}>
        {informes.map((item, index) => (
          <TouchableOpacity
            key={index}
            style={[
              styles.card,
              {
                backgroundColor: palette.cardBg,
                borderColor: palette.cardBorder,
                shadowColor: isDark ? '#000' : '#000',
              },
            ]}
            onPress={item.onPress}
            activeOpacity={0.85}
          >
            <View
              style={[
                styles.iconContainer,
                {
                  backgroundColor: isDark ? palette.topBg : '#E8F5E9',
                  borderColor: palette.cardBorder,
                },
              ]}
            >
              <Icon name={item.icon} size={28} color={palette.accent} />
            </View>

            <View style={{ flex: 1 }}>
              <Text style={[styles.label, { color: palette.text }]}>{item.label}</Text>
              <Text style={[styles.sub, { color: palette.softText }]}>Seleccionar</Text>
            </View>

            {/* Chevron + badge para "Envíos en Cola" */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {item.label === 'Envíos en Cola' ? <OutboxBadge count={pendingCount} /> : null}
              <Icon name="chevron-right" size={26} color={palette.softText} />
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  titulo: { fontSize: 22, fontWeight: 'bold', marginVertical: 16, textAlign: 'center' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 8,
    padding: 12,
    borderRadius: 12,
    elevation: 1,
    borderWidth: 1,
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  iconContainer: {
    width: 42, height: 42, borderRadius: 21, justifyContent: 'center', alignItems: 'center',
    marginRight: 12, borderWidth: 1,
  },
  label: { fontSize: 16, fontWeight: '800' },
  sub: { fontSize: 13, marginTop: 2 },
  badge: {
    minWidth: 26,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeTxt: { color: '#fff', fontSize: 11, fontWeight: '800' },
});
