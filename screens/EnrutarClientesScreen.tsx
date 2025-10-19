// screens/EnrutarClientesScreen.tsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert,
  Modal, Pressable, ScrollView,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons as MIcon } from '@expo/vector-icons';
import {
  collectionGroup, onSnapshot, query, where, updateDoc,
  getDocs, type DocumentReference, type Unsubscribe, QueryConstraint,
} from 'firebase/firestore';

import { RootStackParamList } from '../App';
import { db } from '../firebase/firebaseConfig';
import { useAppTheme } from '../theme/ThemeProvider';
import { ensureRouteOrder } from '../utils/ruta';
import { getAuthCtx } from '../utils/authCtx';

type Props = NativeStackScreenProps<RootStackParamList, 'EnrutarClientes'>;

type PrestamoDoc = {
  ref: DocumentReference;
  id: string;
  clienteId?: string;
  concepto: string;
  creadoPor: string;
  restante: number;       // saldo efectivo usado para filtrar/mostrar
  valorCuota: number;
  // denormalizados
  clienteAlias?: string;
  clienteDireccion1?: string;
  clienteDireccion2?: string;
  clienteTelefono1?: string;
  // orden
  routeOrder?: number;
  // scope
  tenantId?: string | null;
  rutaId?: string | null;
  status?: string;
  estado?: string;
  adminLegacy?: string;
};

type ClienteRuta = {
  id: string; // clienteId
  nombre: string;
  alias?: string;
  direccion1?: string;
  direccion2?: string;
  telefono1?: string;
  valorCuota?: number;
  restante?: number;
  routeOrder?: number;
  refsPrestamos: DocumentReference[];
};

export default function EnrutarClientesScreen({ route }: Props) {
  const routeAdminParam = route.params?.admin || null;
  const { palette } = useAppTheme();
  const insets = useSafeAreaInsets();

  // ===== Auth/scope =====
  const [admin, setAdmin] = useState<string | null>(routeAdminParam);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [rutaId, setRutaId] = useState<string | null>(null);
  const [role, setRole] = useState<'collector' | 'admin' | 'superadmin' | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const ctx = await getAuthCtx();
        if (!alive) return;
        // getAuthCtx debe exponer admin, tenantId, rutaId, role (si tu versión no devuelve admin, pásalo por params al navegar)
        setAdmin((prev) => prev ?? (ctx as any)?.admin ?? null);
        setTenantId((ctx as any)?.tenantId ?? null);
        setRutaId((ctx as any)?.rutaId ?? null);
        setRole((ctx as any)?.role ?? null);
      } catch {
        // noop
      }
    })();
    return () => { alive = false; };
  }, [routeAdminParam]);

  const [prestamos, setPrestamos] = useState<PrestamoDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [listenError, setListenError] = useState<string | null>(null);

  // Modal de reubicación
  const [reorderSourceId, setReorderSourceId] = useState<string | null>(null);
  const [reorderOpen, setReorderOpen] = useState(false);

  // Asegura routeOrder inicial (sin pisar existentes)
  useEffect(() => {
    if (!admin) return;
    (async () => {
      try { await ensureRouteOrder(admin); } catch (e) { console.warn('[ensureRouteOrder]', e); }
    })();
  }, [admin]);

  // saldo robusto
  const computeSaldo = (d: any): number => {
    if (typeof d?.restante === 'number') return Number(d.restante) || 0;
    const total = Number(d?.montoTotal ?? d?.totalPrestamo ?? 0) || 0;
    const vCuota = Number(d?.valorCuota ?? 0) || 0;
    // si hay señales de préstamo, considéralo activo
    if (total > 0 || vCuota > 0) return 1;
    return 0;
  };

  // ===== Suscripción principal: por tenant (y ruta si collector) =====
  useEffect(() => {
    // necesitamos al menos tenantId para scope amplio; si no hay admin ni tenant, no podemos
    if (!tenantId && !admin) return;

    setLoading(true);
    setListenError(null);
    const unsubs: Unsubscribe[] = [];

    const mergeMap = new Map<string, PrestamoDoc>();

    const pushDoc = (ds: any) => {
      const data = ds.data() as any;
      // status/estado
      const st = (data?.status ?? data?.estado) as string | undefined;
      if (st && st !== 'activo') return;

      const restanteEff = computeSaldo(data);
      if (!(restanteEff > 0)) return;

      const p: PrestamoDoc = {
        ref: ds.ref,
        id: ds.id,
        clienteId: data?.clienteId,
        concepto: (data?.concepto ?? '').toString().trim() || 'Sin nombre',
        creadoPor: data?.creadoPor ?? data?.admin ?? '', // compat
        restante: restanteEff,
        valorCuota: Number(data?.valorCuota || 0),
        clienteAlias: data?.clienteAlias ?? data?.clienteNombre ?? '',
        clienteDireccion1: data?.clienteDireccion1 ?? '',
        clienteDireccion2: data?.clienteDireccion2 ?? '',
        clienteTelefono1: data?.clienteTelefono1 ?? '',
        routeOrder: typeof data?.routeOrder === 'number' ? data.routeOrder : undefined,
        tenantId: data?.tenantId ?? null,
        rutaId: data?.rutaId ?? null,
        status: data?.status,
        estado: data?.estado,
        adminLegacy: data?.admin ?? '',
      };

      mergeMap.set(p.ref.path, p);
    };

    // 1) Scope amplio por tenant (igualdad) y opcional ruta (igualdad)
    //    luego filtramos en memoria por admin si corresponde.
    const constraints: QueryConstraint[] = [];
    if (tenantId) constraints.push(where('tenantId', '==', tenantId));
    if (role === 'collector' && rutaId) constraints.push(where('rutaId', '==', rutaId));

    try {
      if (constraints.length > 0) {
        const qScope = query(collectionGroup(db, 'prestamos'), ...constraints);
        const unsubMain = onSnapshot(
          qScope,
          (sg) => {
            sg.docChanges().forEach((chg) => {
              const path = chg.doc.ref.path;
              if (chg.type === 'removed') mergeMap.delete(path);
              else pushDoc(chg.doc);
            });
            setPrestamos(Array.from(mergeMap.values()));
            setLoading(false);
          },
          (err) => {
            console.warn('[enrutar]/snapshot tenant-scope:', err?.message || err);
            setListenError('stream_error');
            setLoading(false);
          }
        );
        unsubs.push(unsubMain);
      }
    } catch (e) {
      console.warn('[enrutar] no pudo suscribirse tenant/ruta:', e);
      setListenError('stream_error');
      setLoading(false);
    }

    // 2) Compat para casos donde no tengamos tenantId pero sí admin (muy legacy)
    //    o para cubrir si tu índice de tenant aún no está listo.
    if (admin) {
      try {
        const qCreadoPor = query(collectionGroup(db, 'prestamos'), where('creadoPor', '==', admin));
        const unsubA = onSnapshot(
          qCreadoPor,
          (sg) => {
            sg.docChanges().forEach((chg) => {
              const path = chg.doc.ref.path;
              if (chg.type === 'removed') mergeMap.delete(path);
              else pushDoc(chg.doc);
            });
            setPrestamos(Array.from(mergeMap.values()));
            setLoading(false);
          },
          (err) => {
            console.warn('[enrutar]/snapshot creadoPor==admin:', err?.message || err);
          }
        );
        unsubs.push(unsubA);
      } catch (e) {
        console.warn('[enrutar] no pudo suscribirse creadoPor:', e);
      }

      try {
        const qAdminLegacy = query(collectionGroup(db, 'prestamos'), where('admin', '==', admin));
        const unsubB = onSnapshot(
          qAdminLegacy,
          (sg) => {
            sg.docChanges().forEach((chg) => {
              const path = chg.doc.ref.path;
              if (chg.type === 'removed') mergeMap.delete(path);
              else pushDoc(chg.doc);
            });
            setPrestamos(Array.from(mergeMap.values()));
            setLoading(false);
          },
          (err) => {
            console.warn('[enrutar]/snapshot admin(legacy)==admin:', err?.message || err);
          }
        );
        unsubs.push(unsubB);
      } catch (e) {
        console.warn('[enrutar] no pudo suscribirse admin(legacy):', e);
      }
    }

    // 3) Fallback puntual si el stream “transport errored”: un getDocs rápido para no dejar la pantalla vacía
    (async () => {
      if (!tenantId && !admin) return;
      if (!listenError) return;
      try {
        const qOnce = tenantId
          ? query(collectionGroup(db, 'prestamos'), where('tenantId', '==', tenantId))
          : query(collectionGroup(db, 'prestamos'), where('creadoPor', '==', admin as string));
        const snap = await getDocs(qOnce);
        snap.forEach((d) => pushDoc(d));
        setPrestamos(Array.from(mergeMap.values()));
      } catch (e) {
        console.warn('[enrutar] fallback getDocs error:', e);
      }
    })().catch(() => {});

    return () => {
      unsubs.forEach((u) => { try { u(); } catch {} });
    };
  }, [tenantId, rutaId, role, admin, listenError]);

  // Agrupar por cliente
  const clientesBase: ClienteRuta[] = useMemo(() => {
    // Filtrado final por admin si se requiere (admins no super pueden ver sólo lo suyo)
    const onlyMine = (role !== 'superadmin' && role !== 'admin' && !!admin) ? admin : null;

    const map = new Map<string, ClienteRuta>();
    for (const p of prestamos) {
      // Si hay filtro por admin “propietario”, aplica compat (creadoPor/admin legacy)
      if (onlyMine && !(p.creadoPor === onlyMine || p.adminLegacy === onlyMine)) continue;

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
        const ro = typeof cur.routeOrder === 'number' ? cur.routeOrder : Number.POSITIVE_INFINITY;
        const rn = typeof p.routeOrder === 'number' ? p.routeOrder : Number.POSITIVE_INFINITY;
        cur.routeOrder = Math.min(ro, rn) !== Number.POSITIVE_INFINITY ? Math.min(ro, rn) : undefined;
        cur.valorCuota = cur.valorCuota || p.valorCuota;
        cur.restante = Math.max(Number(cur.restante || 0), p.restante || 0);
      }
    }
    return Array.from(map.values());
  }, [prestamos, admin, role]);

  // Orden final
  const clientesOrdenados: ClienteRuta[] = useMemo(() => {
    const BIG = 1e15;
    return [...clientesBase].sort((a, b) => {
      const ra = typeof a.routeOrder === 'number' ? a.routeOrder : BIG;
      const rb = typeof b.routeOrder === 'number' ? b.routeOrder : BIG;
      if (ra !== rb) return ra - rb;
      return (a.nombre || '').localeCompare(b.nombre || '', 'es');
    });
  }, [clientesBase]);

  // Modal helpers
  const openReorder = useCallback((id: string) => { setReorderSourceId(id); setReorderOpen(true); }, []);
  const closeReorder = useCallback(() => { setReorderOpen(false); setReorderSourceId(null); }, []);

  // Calcular orden “sparse”
  const computeNewOrder = useCallback(
    (sourceId: string, targetId: string | null): number => {
      const arr = clientesOrdenados.map((c) => ({
        id: c.id,
        order: typeof c.routeOrder === 'number' ? c.routeOrder : Number.NaN,
      }));

      let last = 0;
      for (let i = 0; i < arr.length; i++) {
        if (Number.isFinite(arr[i].order)) last = arr[i].order as number;
        else { last = last + 1000; arr[i].order = last; }
      }

      if (arr.length === 0) return 1000;

      const srcIdx = arr.findIndex((x) => x.id === sourceId);
      const tgtIdx = targetId ? arr.findIndex((x) => x.id === targetId) : -1;

      const working = arr.slice();
      if (srcIdx >= 0) working.splice(srcIdx, 1);

      if (tgtIdx < 0) {
        const lastOrder = working.length ? (working[working.length - 1].order as number) : 0;
        return (lastOrder || 0) + 1000;
      }

      const targetPos = working.findIndex((x) => x.id === targetId)!;
      const prev = targetPos > 0 ? (working[targetPos - 1].order as number) : undefined;
      const next = working[targetPos].order as number;

      if (prev === undefined) return next - 1;
      return (prev + next) / 2;
    },
    [clientesOrdenados]
  );

  // Aplicar movimiento
  const placeBefore = useCallback(
    async (targetId: string | null) => {
      if (!reorderSourceId) return;
      try {
        const newOrder = computeNewOrder(reorderSourceId, targetId);
        const cliente = clientesBase.find((c) => c.id === reorderSourceId);
        if (!cliente) return;

        await Promise.all(cliente.refsPrestamos.map((ref) => updateDoc(ref, { routeOrder: newOrder })));
        Alert.alert('Ruta', 'Orden guardado.');
      } catch (e) {
        console.warn('[enrutar] actualizar routeOrder:', e);
        Alert.alert('Ruta', 'No se pudo guardar el nuevo orden.');
      } finally {
        closeReorder();
      }
    },
    [reorderSourceId, computeNewOrder, clientesBase, closeReorder]
  );

  // UI
  const { cardBg, cardBorder, text, softText, topBg, topBorder } = palette;
  const dividerColor = (palette as any).divider ?? cardBorder;

  const debugLine = [
    admin ? `admin=${admin}` : 'admin=∅',
    tenantId ? `tenant=${tenantId}` : 'tenant=∅',
    rutaId ? `ruta=${rutaId}` : 'ruta=∅',
    role ? `role=${role}` : 'role=∅',
    `items=${clientesOrdenados.length}`,
  ].join(' · ');

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg }} edges={['left', 'right', 'bottom']}>
      <View style={[styles.header, { backgroundColor: topBg, borderBottomColor: topBorder }]}>
        <Text style={[styles.headerTxt, { color: text }]}>Enrutar clientes</Text>
      </View>

      {/* Banner debug minimal para entender scope actual */}
      <View style={{ paddingHorizontal: 12, paddingVertical: 6 }}>
        <Text style={{ fontSize: 11, color: softText }}>{debugLine}</Text>
        {listenError && (
          <Text style={{ fontSize: 11, color: '#b71c1c' }}>
            stream warning: usando fallback puntual
          </Text>
        )}
      </View>

      {(!tenantId && !admin) ? (
        <View style={{ alignItems: 'center', marginTop: 24, paddingHorizontal: 16 }}>
          <Text style={{ color: softText, textAlign: 'center' }}>
            No se pudo identificar el usuario actual. Vuelve a abrir esta pantalla.
          </Text>
        </View>
      ) : loading ? (
        <ActivityIndicator size="large" style={{ marginTop: 24 }} />
      ) : clientesOrdenados.length === 0 ? (
        <View style={{ alignItems: 'center', marginTop: 24 }}>
          <Text style={{ color: softText, textAlign: 'center', paddingHorizontal: 16 }}>
            No hay clientes activos para enrutar.
            {'\n'}(Se listan los préstamos con saldo pendiente dentro de tu alcance.)
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
                .filter((c) => c.id !== reorderSourceId)
                .map((c) => (
                  <Pressable
                    key={c.id}
                    onPress={() => placeBefore(c.id)}
                    style={({ pressed }) => [
                      styles.targetRow,
                      { borderColor: dividerColor, backgroundColor: pressed ? palette.kpiTrack : 'transparent' },
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
              style={({ pressed }) => [styles.actionBtn, { backgroundColor: pressed ? '#0a7f28' : '#2e7d32' }]}
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
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 10,
    elevation: 1,
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    minHeight: 64,
  },
  title: { fontSize: 14, fontWeight: '800' },
  sub: { fontSize: 12, marginTop: 2 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 },
  modalBox: { width: '95%', maxWidth: 460, borderRadius: 12, padding: 14 },
  modalTitle: { fontSize: 16, fontWeight: '900', textAlign: 'center', marginBottom: 10 },
  targetRow: { paddingVertical: 10, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, marginBottom: 8 },
  actionBtn: { paddingVertical: 10, alignItems: 'center', borderRadius: 8 },
});
