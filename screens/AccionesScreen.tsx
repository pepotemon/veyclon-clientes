// screens/AccionesScreen.tsx
import React, { useEffect, useState } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { useAppTheme } from '../theme/ThemeProvider';
import { MaterialCommunityIcons as MIcon } from '@expo/vector-icons';
import {
  processOutboxBatch,
  subscribeOutbox,
  getOutboxCounts,
  subscribeCount, // fallback por si subscribeOutbox no está disponible
} from '../utils/outbox';

type Props = NativeStackScreenProps<RootStackParamList, 'Acciones'>;

export default function AccionesScreen({ route, navigation }: Props) {
  const { admin } = route.params;
  const { palette } = useAppTheme();
  const [busy, setBusy] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // Badge: escucha cambios del outbox y actualiza el numerito
  useEffect(() => {
    let alive = true;

    const refreshCounts = async () => {
      try {
        const c = await getOutboxCounts();
        if (alive) setPendingCount(c.totalPending || 0);
      } catch {
        // ignore
      }
    };

    // 1) carga inicial
    refreshCounts();

    // 2) suscripción reactiva (emisor de eventos del outbox)
    let unsub: (() => void) | null = null;
    try {
      unsub = subscribeOutbox(() => {
        refreshCounts();
      });
    } catch {
      unsub = null;
    }

    // 3) fallback por polling si no hay emitter
    let unsubPoll: (() => void) | null = null;
    if (!unsub) {
      try {
        unsubPoll = subscribeCount((n) => {
          if (alive) setPendingCount(n || 0);
        });
      } catch {
        unsubPoll = null;
      }
    }

    return () => {
      alive = false;
      if (unsub) unsub();
      if (unsubPoll) unsubPoll();
    };
  }, []);

  const refreshHomeNow = () => {
    navigation.navigate('Home', { admin, refreshToken: Date.now() });
  };

  const reintentarPendientes = async () => {
    try {
      setBusy(true);
      await processOutboxBatch(50);
      Alert.alert('Pendientes', 'Se intentó reenviar la cola.');
    } catch {
      Alert.alert('Error', 'No se pudo reintentar la cola.');
    } finally {
      setBusy(false);
    }
  };

  const Badge = ({ value }: { value: number }) =>
    value > 0 ? (
      <View style={[styles.badge, { backgroundColor: palette.topBg, borderColor: palette.topBorder }]}>
        <Text style={[styles.badgeTxt, { color: palette.text }]}>{value}</Text>
      </View>
    ) : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg }}>
      <View style={[styles.header, { borderBottomColor: palette.topBorder, backgroundColor: palette.topBg }]}>
        <Text style={[styles.headerTxt, { color: palette.text }]}>Acciones</Text>
      </View>

      <View style={{ padding: 12, gap: 10 }}>
        {/* Actualizar ahora */}
        <TouchableOpacity
          style={[styles.row, { backgroundColor: palette.cardBg, borderColor: palette.cardBorder }]}
          activeOpacity={0.85}
          onPress={refreshHomeNow}
          disabled={busy}
        >
          <MIcon name="refresh" size={20} color={palette.text} />
          <Text style={[styles.rowTxt, { color: palette.text, flex: 1 }]}>Actualizar ahora</Text>
        </TouchableOpacity>

        {/* Reenviar pendientes (con badge) */}
        <TouchableOpacity
          style={[styles.row, { backgroundColor: palette.cardBg, borderColor: palette.cardBorder }]}
          activeOpacity={0.85}
          onPress={reintentarPendientes}
          disabled={busy || pendingCount === 0}
        >
          <MIcon name="cloud-upload" size={20} color={palette.text} />
          <Text style={[styles.rowTxt, { color: palette.text, flex: 1 }]}>Reenviar pendientes</Text>
          <Badge value={pendingCount} />
        </TouchableOpacity>

        {/* Abrir Lista de pendientes (con badge) */}
        <TouchableOpacity
          style={[styles.row, { backgroundColor: palette.cardBg, borderColor: palette.cardBorder }]}
          activeOpacity={0.85}
          onPress={() => navigation.navigate('Pendientes')}
          disabled={busy}
        >
          <MIcon name="clipboard-list" size={20} color={palette.text} />
          <Text style={[styles.rowTxt, { color: palette.text, flex: 1 }]}>Ver pendientes</Text>
          <Badge value={pendingCount} />
        </TouchableOpacity>

        {/* Preferencias */}
        <TouchableOpacity
          style={[styles.row, { backgroundColor: palette.cardBg, borderColor: palette.cardBorder }]}
          activeOpacity={0.85}
          onPress={() => navigation.navigate('PreferenciasUsuario')}
          disabled={busy}
        >
          <MIcon name="cog-outline" size={20} color={palette.text} />
          <Text style={[styles.rowTxt, { color: palette.text, flex: 1 }]}>Preferencias</Text>
        </TouchableOpacity>

        {/* Ajustes */}
        <TouchableOpacity
          style={[styles.row, { backgroundColor: palette.cardBg, borderColor: palette.cardBorder }]}
          activeOpacity={0.85}
          onPress={() => navigation.navigate('Ajustes')}
          disabled={busy}
        >
          <MIcon name="tune" size={20} color={palette.text} />
          <Text style={[styles.rowTxt, { color: palette.text, flex: 1 }]}>Ajustes</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTxt: { fontSize: 16, fontWeight: '800' },
  row: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  rowTxt: {
    fontSize: 14,
    fontWeight: '700',
  },
  badge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeTxt: {
    fontSize: 12,
    fontWeight: '900',
  },
});
