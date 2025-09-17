import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  SafeAreaView, View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, Alert, Modal, Pressable, ScrollView,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons as MIcon } from '@expo/vector-icons';
import { collection, collectionGroup, onSnapshot, query, where, DocumentData } from 'firebase/firestore';

import { RootStackParamList } from '../App';
import { db } from '../firebase/firebaseConfig';
import { useAppTheme } from '../theme/ThemeProvider';

// ✅ usa los helpers finales basados en Firestore
import { ensureRouteOrder, persistRouteOrder } from '../utils/ruta';

type Props = NativeStackScreenProps<RootStackParamList, 'EnrutarClientes'>;

type Cliente = {
  id: string;
  nombre?: string;
  alias?: string;
  direccion1?: string;
  direccion2?: string;
  telefono1?: string;
  telefono2?: string;
  // puede tener routeOrder en la colección clientes
  routeOrder?: number;
};

type Prestamo = {
  id: string;
  clienteId?: string;
  concepto: string;
  creadoPor: string;
  restante: number;
  valorCuota: number;
  // opcional denormalizado
  clienteAlias?: string;
  clienteDireccion1?: string;
  clienteDireccion2?: string;
  clienteTelefono1?: string;
};

type ClienteRuta = {
  id: string;
  nombre: string;            // concepto / nombre visible
  alias?: string;
  direccion1?: string;
  direccion2?: string;
  telefono1?: string;
  valorCuota?: number;
  restante?: number;
};

export default function EnrutarClientesScreen({ route }: Props) {
  const admin = route.params?.admin;
  const { palette } = useAppTheme();
  const insets = useSafeAreaInsets();

  const [clientesMap, setClientesMap] = useState<Record<string, Cliente>>({});
  const [prestamos, setPrestamos] = useState<Prestamo[]>([]);
  const [loading, setLoading] = useState(true);

  // 👉 modal de reubicación
  const [reorderSourceId, setReorderSourceId] = useState<string | null>(null);
  const [reorderOpen, setReorderOpen] = useState(false);

  // Asegura que todos tengan routeOrder inicial (no pisa a quienes ya lo tengan)
  useEffect(() => {
    if (!admin) return;
    (async () => {
      try { await ensureRouteOrder(admin); } catch (e) { console.warn('[ensureRouteOrder]', e); }
    })();
  }, [admin]);

  // 1) Suscripción a /clientes (mapa por id)
  useEffect(() => {
    let unsub: undefined | (() => void);
    try {
      unsub = onSnapshot(collection(db, 'clientes'), (snap) => {
        const map: Record<string, Cliente> = {};
        snap.forEach((d) => {
          const data = d.data() as DocumentData;
          map[d.id] = {
            id: d.id,
            nombre: data?.nombre,
            alias: data?.alias,
            direccion1: data?.direccion1,
            direccion2: data?.direccion2,
            telefono1: data?.telefono1,
            telefono2: data?.telefono2,
            routeOrder: typeof data?.routeOrder === 'number' ? data.routeOrder : undefined,
          };
        });
        setClientesMap(map);
      });
    } catch (e) {
      console.warn('[enrutar]/clientes snapshot error:', e);
      setClientesMap({});
    }
    return () => {
      try { unsub && unsub(); } catch {}
    };
  }, []);

  // 2) Suscripción a prestamos del admin (activos -> restante > 0)
  useEffect(() => {
    if (!admin) return;
    let unsub: undefined | (() => void);
    setLoading(true);
    try {
      const qPrestamos = query(
        collectionGroup(db, 'prestamos'),
        where('creadoPor', '==', admin),
        where('restante', '>', 0)
      );
      unsub = onSnapshot(
        qPrestamos,
        (sg) => {
          const lista: Prestamo[] = [];
          sg.forEach((docSnap) => {
            const data = docSnap.data() as any;
            lista.push({
              id: docSnap.id,
              clienteId: data.clienteId,
              concepto: (data.concepto ?? '').trim() || 'Sin nombre',
              creadoPor: data.creadoPor ?? '',
              restante: Number(data.restante || 0),
              valorCuota: Number(data.valorCuota || 0),
              // denormalizados (si existen)
              clienteAlias: data.clienteAlias ?? data.clienteNombre ?? '',
              clienteDireccion1: data.clienteDireccion1 ?? '',
              clienteDireccion2: data.clienteDireccion2 ?? '',
              clienteTelefono1: data.clienteTelefono1 ?? '',
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
    return () => {
      try { unsub && unsub(); } catch {}
    };
  }, [admin]);

  // 3) Merge: prestamos activos -> clientes únicos (base)
  const clientesBase: ClienteRuta[] = useMemo(() => {
    const seen = new Set<string>();
    const out: ClienteRuta[] = [];
    for (const p of prestamos) {
      const cid = p.clienteId || '';
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      const c = clientesMap[cid];
      out.push({
        id: cid,
        nombre: p.concepto,
        alias: p.clienteAlias || c?.alias || c?.nombre || '',
        direccion1: p.clienteDireccion1 || c?.direccion1 || '',
        direccion2: p.clienteDireccion2 || c?.direccion2 || '',
        telefono1: p.clienteTelefono1 || c?.telefono1 || '',
        valorCuota: p.valorCuota,
        restante: p.restante,
      });
    }
    return out;
  }, [prestamos, clientesMap]);

  // 4) Lista final mostrada ordenada por routeOrder (fallback: nombre)
  const clientesOrdenados: ClienteRuta[] = useMemo(() => {
    const BIG = 1e9;
    return [...clientesBase].sort((a, b) => {
      const ra = typeof clientesMap[a.id]?.routeOrder === 'number' ? (clientesMap[a.id].routeOrder as number) : BIG;
      const rb = typeof clientesMap[b.id]?.routeOrder === 'number' ? (clientesMap[b.id].routeOrder as number) : BIG;
      if (ra !== rb) return ra - rb;
      return (a.nombre || '').localeCompare(b.nombre || '');
    });
  }, [clientesBase, clientesMap]);

  // 5) flujo “tocar un cliente → elegir destino”
  const openReorder = useCallback((id: string) => {
    setReorderSourceId(id);
    setReorderOpen(true);
  }, []);
  const closeReorder = useCallback(() => {
    setReorderOpen(false);
    setReorderSourceId(null);
  }, []);

  const placeBefore = useCallback(async (targetId: string | null) => {
    // targetId === null ⇒ enviar al final
    if (!reorderSourceId) return;
    try {
      const idsActuales = clientesOrdenados.map(c => c.id);
      const srcIdx = idsActuales.indexOf(reorderSourceId);
      if (srcIdx < 0) return;

      // quitamos el source
      idsActuales.splice(srcIdx, 1);

      if (targetId) {
        const tgtIdx = idsActuales.indexOf(targetId);
        const idx = tgtIdx >= 0 ? tgtIdx : idsActuales.length;
        idsActuales.splice(idx, 0, reorderSourceId);
      } else {
        // al final
        idsActuales.push(reorderSourceId);
      }

      // ✅ persistir en Firestore (se reflejará en todos los dispositivos)
      await persistRouteOrder(idsActuales);

      Alert.alert('Ruta', 'Orden guardado.');
    } catch (e) {
      console.warn('[persistRouteOrder] error:', e);
      Alert.alert('Ruta', 'No se pudo guardar el nuevo orden.');
    } finally {
      closeReorder();
    }
  }, [reorderSourceId, clientesOrdenados, closeReorder]);

  // 6) UI
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
          renderItem={({ item }) => (
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => openReorder(item.id)}
            >
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
