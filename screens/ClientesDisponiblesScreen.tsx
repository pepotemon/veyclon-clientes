// screens/ClientesDisponiblesScreen.tsx
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  ActivityIndicator,
  StyleSheet,
  TouchableOpacity,
  ListRenderItem,
  TextInput,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { db } from '../firebase/firebaseConfig';
import {
  collection,
  collectionGroup,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../theme/ThemeProvider';

type Cliente = {
  id: string;
  nombre: string;
  alias?: string;
  direccion1?: string;
  telefono1?: string;
  creadoPor?: string;
};

type Props = {
  route: any;
  navigation: any;
};

export default function ClientesDisponiblesScreen({ route, navigation }: Props) {
  const admin = route?.params?.admin ?? 'AdminDemo';
  const { palette } = useAppTheme();

  const [clientesBase, setClientesBase] = useState<Cliente[]>([]);
  const [activosSet, setActivosSet] = useState<Set<string>>(new Set());
  const [cargando, setCargando] = useState(true);
  const [busqueda, setBusqueda] = useState('');

  // Collator para orden estable por nombre (acentos/ñ)
  const coll = useMemo(() => new Intl.Collator('es', { sensitivity: 'base' }), []);

  // 1) Suscripción a CLIENTES del admin (en vivo)
  useEffect(() => {
    setCargando(true);
    const qClientes = query(collection(db, 'clientes'), where('creadoPor', '==', String(admin)));
    const unsub = onSnapshot(
      qClientes,
      (snap) => {
        const lista: Cliente[] = [];
        snap.forEach((d) => {
          const c = d.data() as any;
          lista.push({
            id: d.id,
            nombre: c?.nombre ?? 'Sin nombre',
            alias: c?.alias ?? '',
            direccion1: c?.direccion1 ?? '',
            telefono1: c?.telefono1 ?? '',
            creadoPor: c?.creadoPor,
          });
        });
        setClientesBase(lista);
        setCargando(false);
      },
      (err) => {
        console.error('onSnapshot clientes error:', err);
        setClientesBase([]);
        setCargando(false);
      }
    );
    return () => unsub();
  }, [admin]);

  // 2) Suscripción a PRÉSTAMOS ACTIVOS del admin (en vivo)
  useEffect(() => {
    const qPrestamos = query(
      collectionGroup(db, 'prestamos'),
      where('creadoPor', '==', String(admin)),
      where('restante', '>', 0)
    );
    const unsub = onSnapshot(
      qPrestamos,
      (snap) => {
        const s = new Set<string>();
        snap.forEach((d) => {
          const p = d.data() as any;
          if (p?.clienteId) s.add(String(p.clienteId));
        });
        setActivosSet(s);
      },
      (err) => {
        console.error('onSnapshot prestamos error:', err);
        setActivosSet(new Set());
      }
    );
    return () => unsub();
  }, [admin]);

  // 3) Derivar disponibles: clientes del admin SIN préstamo activo
  const clientesDisponibles = useMemo(() => {
    if (!clientesBase.length) return [];
    const out = clientesBase.filter((c) => !activosSet.has(c.id));
    out.sort((a, b) => coll.compare(a.nombre, b.nombre));
    return out;
  }, [clientesBase, activosSet, coll]);

  // 4) Búsqueda
  const clientesFiltrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return clientesDisponibles;
    return clientesDisponibles.filter((c) => {
      const hay = [c.nombre, c.alias, c.direccion1, c.telefono1, c.id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [clientesDisponibles, busqueda]);

  // Lista (perf)
  const keyExtractor = useCallback((it: Cliente) => it.id, []);
  const getItemLayout = useCallback(
    (_data: ArrayLike<Cliente> | null | undefined, index: number) => ({
      length: 86,
      offset: 86 * index,
      index,
    }),
    []
  );

  const renderItem: ListRenderItem<Cliente> = useCallback(
    ({ item }) => (
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() =>
          navigation.navigate('NuevoPrestamo', {
            admin,
            existingClienteId: item.id,
            cliente: {
              nombre: item.nombre,
              alias: item.alias,
              direccion1: item.direccion1,
              telefono1: item.telefono1,
            },
          })
        }
      >
        <View
          style={[
            styles.card,
            {
              backgroundColor: palette.cardBg,
              borderColor: palette.cardBorder,
            },
          ]}
        >
          <View style={styles.leftIcon}>
            <Ionicons name="person-circle-outline" size={28} color={palette.accent} />
          </View>

          <View style={styles.mid}>
            <Text style={[styles.name, { color: palette.text }]} numberOfLines={1}>
              {item.nombre}
            </Text>
            {!!item.alias && (
              <Text style={[styles.meta, { color: palette.softText }]} numberOfLines={1}>
                Alias: {item.alias}
              </Text>
            )}
            {!!item.telefono1 && (
              <Text style={[styles.meta, { color: palette.softText }]} numberOfLines={1}>
                Teléfono: {item.telefono1}
              </Text>
            )}
            {!!item.direccion1 && (
              <Text style={[styles.meta, { color: palette.softText }]} numberOfLines={1}>
                Dirección: {item.direccion1}
              </Text>
            )}
          </View>

          <Ionicons name="chevron-forward" size={20} color={palette.softText} />
        </View>
      </TouchableOpacity>
    ),
    [navigation, admin, palette]
  );

  return (
      <SafeAreaView
    style={{ flex: 1, backgroundColor: palette.screenBg }}
    edges={['left','right','bottom']}   // 👈 evita el hueco
  >
      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder },
        ]}
      >
        <Ionicons name="people-outline" size={20} color={palette.accent} />
        <Text style={[styles.headerTitle, { color: palette.text }]}>
          Clientes disponibles
        </Text>
        <View style={{ width: 20 }} />
      </View>

      {/* Buscador */}
      <View
        style={[
          styles.searchBox,
          { backgroundColor: palette.kpiTrack, borderColor: palette.cardBorder },
        ]}
      >
        <Ionicons name="search" size={18} color={palette.softText} style={{ marginRight: 8 }} />
        <TextInput
          placeholder="Buscar cliente..."
          placeholderTextColor={palette.softText}
          style={[styles.searchInput, { color: palette.text }]}
          value={busqueda}
          onChangeText={setBusqueda}
          returnKeyType="search"
        />
      </View>

      {cargando ? (
        <ActivityIndicator size="large" style={{ marginTop: 16 }} />
      ) : (
        <FlatList
          data={clientesFiltrados}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 20 }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', marginTop: 24 }}>
              <Text style={{ color: palette.softText }}>
                {busqueda ? 'Sin coincidencias.' : 'No hay clientes disponibles.'}
              </Text>
            </View>
          }
          initialNumToRender={18}
          windowSize={7}
          removeClippedSubviews={Platform.OS === 'ios'}
          getItemLayout={getItemLayout}
          keyboardShouldPersistTaps="handled"
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    gap: 8,
  },
  headerTitle: { fontSize: 18, fontWeight: '800' },

  searchBox: {
    margin: 12,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
  },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 2 },

  card: {
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    borderWidth: 1,
  },
  leftIcon: { width: 36, alignItems: 'center', marginRight: 8 },
  mid: { flex: 1, paddingRight: 8 },
  name: { fontSize: 16, fontWeight: '800' },
  meta: { fontSize: 12, marginTop: 2 },
});
