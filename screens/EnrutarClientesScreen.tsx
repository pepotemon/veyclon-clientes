// screens/EnrutarClientesScreen.tsx
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  SafeAreaView, View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, Alert, Modal, Pressable, ScrollView,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons as MIcon } from '@expo/vector-icons';
import {
  collectionGroup,
  onSnapshot,
  query,
  where,
  updateDoc,
  DocumentReference,
} from 'firebase/firestore';

import { RootStackParamList } from '../App';
import { db } from '../firebase/firebaseConfig';
import { useAppTheme } from '../theme/ThemeProvider';

// Helpers para inicializar orden (no hace merges masivos en UI)
import { ensureRouteOrder } from '../utils/ruta';

type Props = NativeStackScreenProps<RootStackParamList, 'EnrutarClientes'>;

type PrestamoDoc = {
  ref: DocumentReference;
  id: string;
  clienteId?: string;
  concepto: string;
  creadoPor: string;
  restante: number;
  valorCuota: number;
  // denormalizados
  clienteAlias?: string;
  clienteDireccion1?: string;
  clienteDireccion2?: string;
  clienteTelefono1?: string;
  // orden
  routeOrder?: number;
};

type ClienteRuta = {
  id: string;                // clienteId
  nombre: string;            // concepto / visible
  alias?: string;
  direccion1?: string;
  direccion2?: string;
  telefono1?: string;
  valorCuota?: number;
  restante?: number;
  routeOrder?: number;       // orden efectivo (agregado de sus préstamos)
  refsPrestamos: DocumentReference[]; // para actualizar routeOrder en todos los préstamos activos del cliente
};

export default function EnrutarClientesScreen({ route }: Props) {
  const admin = route.params?.admin;
  const { palette } = useAppTheme();
  const insets = useSafeAreaInsets();

  const [prestamos, setPrestamos] = useState<PrestamoDoc[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal de reubicación
  const [reorderSourceId, setReorderSourceId] = useState<string | null>(null);
  const [reorderOpen, setReorderOpen] = useState(false);

  // Asegura que todos tengan routeOrder inicial (no pisa los existentes)
  useEffect(() => {
    if (!admin) return;
    (async () => {
      try { await ensureRouteOrder(admin); } catch (e) { console.warn('[ensureRouteOrder]', e); }
    })();
  }, [admin]);

  // Suscripción a préstamos del admin (sin índices compuestos: filtramos restante>0 en cliente)
  useEffect(() => {
    if (!admin) return;
    let unsub: undefined | (() => void);
    setLoading(true);
    try {
      const qPrestamos = query(
        collectionGroup(db, 'prestamos'),
        where('creadoPor', '==', admin)
      );
      unsub = onSnapshot(
        qPrestamos,
        (sg) => {
          const lista: PrestamoDoc[] = [];
          sg.forEach((docSnap) => {
            const data = docSnap.data() as any;

            // Filtrado client-side (evita índice compuesto):
            // - status 'activo' (o sin status por legacy)
            // - restante > 0
            const st = data?.status;
            const restante = Number(data?.restante ?? 0);
            if ((st && st !== 'activo') || !(restante > 0)) return;

            lista.push({
              ref: docSnap.ref,
              id: docSnap.id,
              clienteId: data.clienteId,
              concepto: (data.concepto ?? '').trim() || 'Sin nombre',
              creadoPor: data.creadoPor ?? '',
              restante,
              valorCuota: Number(data.valorCuota || 0),
              clienteAlias: data.clienteAlias ?? data.clienteNombre ?? '',
              clienteDireccion1: data.clienteDireccion1 ?? '',
              clienteDireccion2: data.clienteDireccion2 ?? '',
              clienteTelefono1: data.clienteTelefono1 ?? '',
              routeOrder: typeof data.routeOrder === 'number' ? data.routeOrder : undefined,
            });
          });
          setPrestamos(lista);
          setLoading(false);
        },
        (err) => {
          console.warn('[enrutar]/prestamos snapshot error:', err?.message || err);
          setPrestamos([]);
          setLoading(false);
          Alert.alert('Permisos', 'No fue posible leer los préstamos activos.');
        }
      );
    } catch (e) {
      console.warn('[enrutar] suscripción prestamos no disponible:', e);
      setPrestamos([]);
      setLoading(false);
    }
    return () => { try { unsub && unsub(); } catch {} };
  }, [admin]);

  // Agrupar por cliente (sin merges externos) usando campos denormalizados del préstamo
  const clientesBase: ClienteRuta[] = useMemo(() => {
    const map = new Map<string, ClienteRuta>();
    for (const p of prestamos) {
      const cid = p.clienteId || '';
      if (!cid) continue;

      if (!map.has(cid)) {
        map.set(cid, {
          id: cid,
          nombre: p.concepto,
          alias: p.clienteAlias || '',
          direccion1: p.clienteDireccion1 || '',
          direccion2: p.clienteDireccion2 || '',
          telefono1: p.clienteTelefono1 || '',
          valorCuota: p.valorCuota,
          restante: p.restante,
          routeOrder: p.routeOrder,
          refsPrestamos: [p.ref],
        });
      } else {
        const cur = map.get(cid)!;
        cur.refsPrestamos.push(p.ref);
        // Si alguno trae routeOrder, toma el menor como referencia (estable)
        const ro = (typeof cur.routeOrder === 'number' ? cur.routeOrder : Infinity);
        const rn = (typeof p.routeOrder === 'number' ? p.routeOrder : Infinity);
        cur.routeOrder = Math.min(ro, rn) !== Infinity ? Math.min(ro, rn) : undefined;
        // También podemos acumular info visible básica
        cur.valorCuota = cur.valorCuota || p.valorCuota;
        cur.restante = Math.max(Number(cur.restante || 0), p.restante || 0);
      }
    }
    return Array.from(map.values());
  }, [prestamos]);

  // Orden final por routeOrder (fallback: nombre)
  const clientesOrdenados: ClienteRuta[] = useMemo(() => {
    const BIG = 1e15;
    return [...clientesBase].sort((a, b) => {
      const ra = typeof a.routeOrder === 'number' ? a.routeOrder! : BIG;
      const rb = typeof b.routeOrder === 'number' ? b.routeOrder! : BIG;
      if (ra !== rb) return ra - rb;
      return (a.nombre || '').localeCompare(b.nombre || '');
    });
  }, [clientesBase]);

  // Helpers: abrir/cerrar modal
  const openReorder = useCallback((id: string) => { setReorderSourceId(id); setReorderOpen(true); }, []);
  const closeReorder = useCallback(() => { setReorderOpen(false); setReorderSourceId(null); }, []);

  // Calcular nuevo routeOrder “sparse” (evita reindexar 200 filas)
  const computeNewOrder = useCallback((sourceId: string, targetId: string | null): number => {
    // Construir una lista de órdenes efectivas (rellenando huecos)
    const arr = clientesOrdenados.map((c) => ({
      id: c.id,
      order: typeof c.routeOrder === 'number' ? c.routeOrder : NaN,
    }));
    // Asignar secuenciales para NaN manteniendo el orden actual
    let last = 0;
    for (let i = 0; i < arr.length; i++) {
      if (Number.isFinite(arr[i].order)) {
        last = arr[i].order;
      } else {
        last = last + 1000; // espacio para futuras inserciones
        arr[i].order = last;
      }
    }
    // Si la lista quedó vacía
    if (arr.length === 0) return 1000;

    // Índices útiles
    const srcIdx = arr.findIndex(x => x.id === sourceId);
    const tgtIdx = targetId ? arr.findIndex(x => x.id === targetId) : -1;

    // Quitar el source para pensar en el nuevo lugar
    const working = arr.slice();
    if (srcIdx >= 0) working.splice(srcIdx, 1);

    if (tgtIdx < 0) {
      // Al final
      const lastOrder = working.length ? working[working.length - 1].order : 0;
      return (lastOrder || 0) + 1000;
    }

    // Nuevo índice donde quedaría el target en el arreglo sin source
    const targetPos = working.findIndex(x => x.id === targetId)!;
    const prev = targetPos > 0 ? working[targetPos - 1].order : undefined;
    const next = working[targetPos].order;

    if (prev === undefined) return next - 1;           // al inicio
    return (prev + next) / 2;                          // entre prev y target
  }, [clientesOrdenados]);

  // Aplicar movimiento: actualizar routeOrder en TODOS los préstamos activos del cliente movido
  const placeBefore = useCallback(async (targetId: string | null) => {
    if (!reorderSourceId) return;
    try {
      const newOrder = computeNewOrder(reorderSourceId, targetId);
      const cliente = clientesBase.find(c => c.id === reorderSourceId);
      if (!cliente) return;

      // Actualiza todas las refs de préstamos activos de ese cliente
      await Promise.all(
        cliente.refsPrestamos.map(ref => updateDoc(ref, { routeOrder: newOrder }))
      );

      Alert.alert('Ruta', 'Orden guardado.');
    } catch (e) {
      console.warn('[enrutar] actualizar routeOrder:', e);
      Alert.alert('Ruta', 'No se pudo guardar el nuevo orden.');
    } finally {
      closeReorder();
    }
  }, [reorderSourceId, computeNewOrder, clientesBase, closeReorder]);

  // UI
  const { cardBg, cardBorder, text, softText, topBg, topBorder } = palette;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg }}>
      <View style={[styles.header, { backgroundColor: topBg, borderBottomColor: topBorder }]}>
        <Text style={[styles.headerTxt, { color: text }]}>Enrutar clientes</Text>
      </View>

      {loading ? (
        <ActivityIndicator size="large" style={{ marginTop: 24 }} />
      ) : clientesOrdenados.length === 0 ? (
        <View style={{ alignItems: 'center', marginTop: 24 }}>
          <Text style={{ color: softText, textAlign: 'center', paddingHorizontal: 16 }}>
            No hay clientes activos para enrutar.
            {'\n'}(Se listan los que tienen préstamos con saldo pendiente del usuario actual.)
          </Text>
        </View>
      ) : (
        <FlatList
          data={clientesOrdenados}
          keyExtractor={(it) => it.id}
          contentContainerStyle={{ padding: 12, paddingBottom: 12 + Math.max(10, insets.bottom) }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          initialNumToRender={16}
          windowSize={7}
          maxToRenderPerBatch={24}
          updateCellsBatchingPeriod={16}
          removeClippedSubviews
          renderItem={({ item }) => (
            <TouchableOpacity activeOpacity={0.85} onPress={() => openReorder(item.id)}>
              <View
                style={[
                  styles.row,
                  { backgroundColor: cardBg, borderColor: cardBorder, shadowColor: '#000' },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.title, { color: text }]} numberOfLines={1}>
                    {item.nombre}
                    {item.alias ? <Text style={{ color: softText }}> ({item.alias})</Text> : null}
                  </Text>
                  {!!item.direccion1 && (
                    <Text style={[styles.sub, { color: softText }]} numberOfLines={1}>
                      {item.direccion1}
                    </Text>
                  )}
                  <Text style={[styles.sub, { color: softText }]} numberOfLines={1}>
                    Cuota: R$ {(item.valorCuota || 0).toFixed(2)} • Saldo: R$ {(item.restante || 0).toFixed(2)}
                  </Text>
                </View>
                <View style={{ alignItems: 'center', paddingLeft: 8 }}>
                  <MIcon name="swap-vertical" size={20} color={softText} />
                  <Text style={{ fontSize: 10, color: softText, marginTop: 2 }}>Mover</Text>
                </View>
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      {/* Modal de re-ubicación */}
      <Modal visible={reorderOpen} transparent animationType="fade" onRequestClose={closeReorder}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, { backgroundColor: cardBg, borderColor: cardBorder, borderWidth: 1 }]}>
            <Text style={[styles.modalTitle, { color: text }]}>Colocar antes de…</Text>
            <ScrollView style={{ maxHeight: 380 }}>
              {clientesOrdenados
                .filter(c => c.id !== reorderSourceId)
                .map((c) => (
                  <Pressable
                    key={c.id}
                    onPress={() => placeBefore(c.id)}
                    style={({ pressed }) => [
                      styles.targetRow,
                      { borderColor: palette.divider, backgroundColor: pressed ? palette.kpiTrack : 'transparent' },
                    ]}
                  >
                    <Text style={{ color: text }} numberOfLines={1}>
                      {c.nombre} {c.alias ? `(${c.alias})` : ''}
                    </Text>
                  </Pressable>
                ))}
            </ScrollView>

            <View style={{ height: 8 }} />

            <Pressable
              onPress={() => placeBefore(null)}
              style={({ pressed }) => [
                styles.actionBtn,
                { backgroundColor: pressed ? '#0a7f28' : '#2e7d32' },
              ]}
            >
              <Text style={{ color: '#fff', fontWeight: '800' }}>Enviar al final</Text>
            </Pressable>

            <Pressable
              onPress={closeReorder}
              style={({ pressed }) => [
                styles.actionBtn,
                { backgroundColor: pressed ? palette.topBorder : palette.topBg, marginTop: 8, borderWidth: 1, borderColor: cardBorder },
              ]}
            >
              <Text style={{ color: text, fontWeight: '700' }}>Cancelar</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, alignItems: 'center' },
  headerTxt: { fontSize: 16, fontWeight: '800' },
  row: {
    flexDirection: 'row', alignItems: 'center', borderRadius: 10, borderWidth: 1,
    paddingVertical: 10, paddingHorizontal: 10, elevation: 1, shadowOpacity: 0.05,
    shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, minHeight: 64,
  },
  title: { fontSize: 14, fontWeight: '800' },
  sub: { fontSize: 12, marginTop: 2 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 },
  modalBox: { width: '95%', maxWidth: 460, borderRadius: 12, padding: 14 },
  modalTitle: { fontSize: 16, fontWeight: '900', textAlign: 'center', marginBottom: 10 },
  targetRow: { paddingVertical: 10, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, marginBottom: 8 },
  actionBtn: { paddingVertical: 10, alignItems: 'center', borderRadius: 8 },
});
