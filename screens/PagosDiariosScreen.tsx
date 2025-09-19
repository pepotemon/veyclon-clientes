// screens/PagosDiariosScreen.tsx
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  ActivityIndicator,
  Alert,
  AppState,
  StatusBar,
  ListRenderItem,
  Keyboard,
  NativeSyntheticEvent,
  GestureResponderEvent,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native'; // 👈 añadido useFocusEffect
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { db } from '../firebase/firebaseConfig';
import { getDocs, collection, collectionGroup, onSnapshot } from 'firebase/firestore';
import ModalRegistroPago from '../components/ModalRegistroPago';
import InstantOpcionesCliente from '../components/InstantOpcionesCliente';
import { RootStackParamList } from '../App';
import { todayInTZ, nextMidnightDelayInTZ, normYYYYMMDD, pickTZ } from '../utils/timezone';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from '../theme/ThemeProvider';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ✅ Solo cuotas vencidas
import { computeQuotaBadge } from '../utils/alerts';

// 👇 añadido: util para garantizar orden de ruta
import { ensureRouteOrder, loadRutaOrder } from '../utils/ruta'; // 👈 añadí loadRutaOrder

type Cliente = {
  id: string;
  alias?: string;
  direccion1?: string;
  direccion2?: string;
  telefono1?: string;
  telefono2?: string;
  genero?: 'M' | 'F' | 'O';
  // 👇 añadido: orden de ruta
  routeOrder?: number;
};

type Abono = {
  monto: number;
  fecha?: string;
  operationalDate?: string;
  tz?: string;
  registradoPor?: string;
};

type Prestamo = {
  id: string;
  clienteId?: string;
  concepto: string;
  cobradorId: string;
  montoTotal: number;
  restante: number;
  abonos: Abono[];
  totalPrestamo: number;
  creadoPor: string;
  valorCuota: number;
  modalidad?: string;
  clienteAlias?: string;
  clienteDireccion1?: string;
  clienteDireccion2?: string;
  tz?: string;

  // (opcionales para "Nuevo")
  creadoEn?: any;        // Timestamp Firestore
  createdAtMs?: number;  // ms epoch
  fechaInicio?: string;  // 'YYYY-MM-DD'

  // ⬇️ necesarios para adelantar / cálculo robusto
  permitirAdelantar?: boolean;
  cuotas?: number;
  diasHabiles?: number[];
  feriados?: string[];
  pausas?: { desde: string; hasta: string; motivo?: string }[];
  modoAtraso?: 'porPresencia' | 'porCuota';
};

type Filtro = 'todos' | 'pendientes' | 'visitados';
type ItemRow = Prestamo & { cliente?: Cliente };

export default function PagosDiariosScreen({ route }: any) {
  const admin = route?.params?.admin ?? 'AdminDemo';
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();
  const { palette, isDark } = useAppTheme();

  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [prestamos, setPrestamos] = useState<Prestamo[]>([]);
  const [cargando, setCargando] = useState(true);

  const [busqueda, setBusqueda] = useState('');
  const [prestamoSeleccionado, setPrestamoSeleccionado] = useState<Prestamo | null>(null);
  const [opcionesVisible, setOpcionesVisible] = useState(false);
  const [modalPagoVisible, setModalPagoVisible] = useState(false);

  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [dayTick, setDayTick] = useState(0);
  const [mensajeExito, setMensajeExito] = useState('');

  // 👇 añadido: orden guardado en AsyncStorage por admin
  const [routeOrderIds, setRouteOrderIds] = useState<string[]>([]); // ← ids de clientes ordenados

  const tzSession = 'America/Sao_Paulo';

  // ===== Helpers =====
  function toYYYYMMDDInTZ(date: Date, tz: string) {
    const parts = new Intl.DateTimeFormat('es-ES', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const y = parts.find(p => p.type === 'year')?.value ?? '0000';
    const m = parts.find(p => p.type === 'month')?.value ?? '01';
    const d = parts.find(p => p.type === 'day')?.value ?? '01';
    return `${y}-${m}-${d}`;
  }
  function anyDateToYYYYMMDD(d: any, tz: string): string | null {
    try {
      if (!d) return null;
      if (typeof d === 'string') {
        const n = normYYYYMMDD(d);
        return n || null;
      }
      if (typeof d === 'number') return toYYYYMMDDInTZ(new Date(d), tz);
      if (typeof d?.toDate === 'function') return toYYYYMMDDInTZ(d.toDate(), tz);
      if (typeof d?.seconds === 'number') return toYYYYMMDDInTZ(new Date(d.seconds * 1000), tz);
      if (d instanceof Date) return toYYYYMMDDInTZ(d, tz);
      return null;
    } catch {
      return null;
    }
  }
  function getCreatedMs(p: any): number {
    if (typeof p?.createdAtMs === 'number') return p.createdAtMs;
    if (p?.creadoEn?.toMillis) return p.creadoEn.toMillis();
    if (typeof p?.creadoEn?.seconds === 'number') return p.creadoEn.seconds * 1000;
    if (typeof p?.fechaInicio === 'string') {
      const t = Date.parse(p.fechaInicio + 'T00:00:00');
      if (!Number.isNaN(t)) return t;
    }
    return NaN;
  }
  function esNuevoHoyOPas48h(p: Prestamo): boolean {
    const tz = pickTZ(p.tz, tzSession);
    const createdDay =
      anyDateToYYYYMMDD((p as any).creadoEn, tz) ??
      anyDateToYYYYMMDD((p as any).createdAtMs, tz) ??
      anyDateToYYYYMMDD(p.fechaInicio, tz);
    if (createdDay && createdDay === todayInTZ(tz)) return true;
    const ms = getCreatedMs(p);
    if (Number.isFinite(ms)) return Date.now() - ms < 48 * 3600 * 1000;
    return false;
  }
  // ====================

  // ====== Inercia: capturar tap y abrir pago directo ======
  const flatRef = useRef<FlatList<ItemRow>>(null);
  const lastOffsetRef = useRef(0);
  const momentumRef = useRef(false);
  const justHandledCaptureRef = useRef(false);

  const ROW_HEIGHT = 86;
  const SEP_HEIGHT = 8;
  const ROW_STRIDE = ROW_HEIGHT + SEP_HEIGHT;

  const filasFiltradasRef = useRef<ItemRow[]>([]);

  const openPagoDirecto = useCallback((item: Prestamo) => {
    setPrestamoSeleccionado(item);
    setOpcionesVisible(false);
    setModalPagoVisible(true);
  }, []);

  const openOpciones = useCallback((item: Prestamo) => {
    setPrestamoSeleccionado(item);
    setOpcionesVisible(true);
  }, []);

  const handleTouchEndCapture = useCallback(
    (e: NativeSyntheticEvent<GestureResponderEvent['nativeEvent']> | any) => {
      if (!momentumRef.current) return;
      const y = e.nativeEvent?.locationY ?? 0;
      const contentY = lastOffsetRef.current + y;
      const index = Math.floor(contentY / ROW_STRIDE);

      const withinRow = (contentY % ROW_STRIDE) <= ROW_HEIGHT;
      if (!withinRow) {
        momentumRef.current = false;
        return;
      }

      const data = filasFiltradasRef.current;
      const item = data[index];
      if (!item) {
        momentumRef.current = false;
        return;
      }

      flatRef.current?.scrollToOffset({ offset: lastOffsetRef.current, animated: false });

      momentumRef.current = false;
      justHandledCaptureRef.current = true;
      requestAnimationFrame(() => {
        openPagoDirecto(item); // 👈 tap durante inercia = pago directo
        requestAnimationFrame(() => { justHandledCaptureRef.current = false; });
      });
    },
    [ROW_STRIDE, openPagoDirecto]
  );
  // ========================================================


useFocusEffect(
  useCallback(() => {
    let alive = true;
    (async () => {
      const u = await AsyncStorage.getItem('usuarioSesion');
      if (alive && !u) {
        navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
      }
    })();
    return () => { alive = false; };
  }, [navigation])
);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const schedule = () => {
      t = setTimeout(() => {
        setDayTick((n) => n + 1);
        schedule();
      }, nextMidnightDelayInTZ(tzSession));
    };
    schedule();
    return () => clearTimeout(t);
  }, [tzSession]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') setDayTick((n) => n + 1);
    });
    return () => sub.remove();
  }, []);

  // 👇 añadido: recargar orden cuando la pantalla gana foco
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        const ids = await loadRutaOrder(admin);
        if (alive) setRouteOrderIds(ids);
      })();
      return () => { alive = false; };
    }, [admin])
  );

  const hoySession = useMemo(() => todayInTZ(tzSession), [tzSession, dayTick]);

  const esVisitadoHoy = useCallback(
    (p: Prestamo) => {
      const tz = pickTZ(p.tz, tzSession);
      const hoy = todayInTZ(tz);
      return (
        Array.isArray(p.abonos) &&
        p.abonos.some((a) => {
          const dia = a.operationalDate ?? normYYYYMMDD(a.fecha);
          return dia === hoy;
        })
      );
    },
    [tzSession]
  );

  useEffect(() => {
    let unsub: any;
    const cargar = async () => {
      try {
        setCargando(true);

        // 👇 añadido: garantizar que todos los clientes del admin tengan routeOrder (compat)
        try {
          await ensureRouteOrder(admin);
        } catch (e) {
          console.warn('[ensureRouteOrder]', e);
        }

        const snapC = await getDocs(collection(db, 'clientes'));
        const listaC = snapC.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            alias: data?.alias,
            direccion1: data?.direccion1,
            direccion2: data?.direccion2,
            telefono1: data?.telefono1,
            telefono2: data?.telefono2,
            genero: data?.genero,
            // 👇 traemos routeOrder si existe (backup)
            routeOrder: typeof data?.routeOrder === 'number' ? data.routeOrder : undefined,
          } as Cliente;
        });
        setClientes(listaC);

        unsub = onSnapshot(collectionGroup(db, 'prestamos'), (sg) => {
          const lista: Prestamo[] = [];
          sg.forEach((docSnap) => {
            const data = docSnap.data() as any;
            const cliente = listaC.find((c) => c.id === data.clienteId);
            lista.push({
              id: docSnap.id,
              concepto: (data.concepto ?? '').trim() || 'Sin concepto',
              cobradorId: data.cobradorId ?? '',
              montoTotal: data.montoTotal ?? data.totalPrestamo ?? 0,
              totalPrestamo: data.totalPrestamo ?? data.montoTotal ?? 0,
              restante: data.restante ?? 0,
              abonos: Array.isArray(data.abonos) ? data.abonos : [],
              creadoPor: data.creadoPor ?? '',
              valorCuota: data.valorCuota ?? 0,
              modalidad: data.modalidad ?? 'Diaria',
              clienteId: data.clienteId,
              clienteAlias: cliente?.alias ?? '',
              clienteDireccion1: cliente?.direccion1 ?? '',
              clienteDireccion2: cliente?.direccion2 ?? '',
              tz: data.tz || 'America/Sao_Paulo',

              // opcionales para "nuevo"
              creadoEn: (data as any)?.creadoEn,
              createdAtMs: (data as any)?.createdAtMs,
              fechaInicio: (data as any)?.fechaInicio,

              // ⬇️ para cálculo de cuotas vencidas y “adelantado”
              permitirAdelantar: data.permitirAdelantar,
              cuotas: data.cuotas,
              diasHabiles: data.diasHabiles,
              feriados: data.feriados,
              pausas: data.pausas,
              modoAtraso: data.modoAtraso,
            });
          });
          setPrestamos(lista);
          setCargando(false);
        });
      } catch (e) {
        console.error('❌ Error al cargar PagosDiarios:', e);
        setCargando(false);
      }
    };
    cargar();
    return () => unsub && unsub();
  }, [admin]);

  const filas: ItemRow[] = useMemo(() => {
    const idx: Record<string, Cliente> = {};
    for (const c of clientes) idx[c.id] = c;

    const BIG = 1e9;
    const pos = new Map<string, number>(routeOrderIds.map((id, i) => [id, i])); // 👈 posiciones según AsyncStorage

    return prestamos
      .filter((p) => p.creadoPor === admin)
      .map((p) => ({ ...p, cliente: idx[p.clienteId || ''] }))
      // 👇 ordenar por orden de ruta (ids de cliente); si no está en la lista, al final
      .sort((a, b) => {
        const pa = a.clienteId ? (pos.has(a.clienteId) ? (pos.get(a.clienteId) as number) : BIG) : BIG;
        const pb = b.clienteId ? (pos.has(b.clienteId) ? (pos.get(b.clienteId) as number) : BIG) : BIG;
        if (pa !== pb) return pa - pb;

        // backup: si ninguno está en lista, usamos routeOrder Firestore si existe, luego nombre
        const ra = typeof a.cliente?.routeOrder === 'number' ? a.cliente!.routeOrder! : BIG;
        const rb = typeof b.cliente?.routeOrder === 'number' ? b.cliente!.routeOrder! : BIG;
        if (ra !== rb) return ra - rb;
        return (a.concepto || '').localeCompare(b.concepto || '');
      });
  }, [clientes, prestamos, admin, routeOrderIds]); // 👈 dependemos de routeOrderIds

  const filasBuscadas = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return filas;
    return filas.filter((x) => {
      const c = x.cliente;
      const hay = [x.concepto, c?.alias, c?.direccion1, c?.direccion2, x.clienteId]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [filas, busqueda]);

  const filasFiltradas = useMemo(() => {
    if (filtro === 'pendientes') return filasBuscadas.filter((p) => !esVisitadoHoy(p));
    if (filtro === 'visitados') return filasBuscadas.filter((p) => esVisitadoHoy(p));
    return filasBuscadas;
  }, [filasBuscadas, filtro, esVisitadoHoy, hoySession]);

  useEffect(() => {
    filasFiltradasRef.current = filasFiltradas;
  }, [filasFiltradas]);

  const abrirModalPago = useCallback(() => {
    if (!prestamoSeleccionado?.clienteId) {
      Alert.alert('Error', 'Este préstamo no tiene cliente asignado');
      return;
    }
    setOpcionesVisible(false);
    setModalPagoVisible(true);
  }, [prestamoSeleccionado]);

  const mostrarMensajeExito = (mensaje: string) => {
    setMensajeExito(mensaje);
    setTimeout(() => setMensajeExito(''), 2500);
  };

  const avatarFor = (c?: Cliente) => {
    const color = palette.softText;
    const g = ((c?.genero ?? '') + '').trim().toLowerCase();
    if (g.startsWith('f')) return <Ionicons name="woman" size={28} color={color} />;
    if (g.startsWith('m')) return <Ionicons name="man" size={28} color={color} />;
    return <Ionicons name="person" size={28} color={color} />;
  };

  const keyExtractor = useCallback((it: ItemRow) => it.id, []);
  const getItemLayout = useCallback(
    (_data: ArrayLike<ItemRow> | null | undefined, index: number) => ({
      length: ROW_HEIGHT,
      offset: index * (ROW_HEIGHT + SEP_HEIGHT),
      index,
    }),
    []
  );

  const renderItem: ListRenderItem<ItemRow> = useCallback(
    ({ item }) => {
      const c = item.cliente;
      const visitado = esVisitadoHoy(item);
      const esNuevo = !visitado && esNuevoHoyOPas48h(item);
const qbRaw = computeQuotaBadge(item);
let quotaLabel = qbRaw.label;

// Compactar a “+N” tanto para vencidas como adelantadas
const mV = qbRaw.label.match(/^Cuota(?:s)?\s+vencida(?:s)?:\s*(\d+)/i);
const mA = qbRaw.label.match(/^Cuota(?:s)?\s+adelantada(?:s)?:\s*(\d+)/i);

if (mV) {
  quotaLabel = `+${mV[1]}`;        // rojo (viene del color de qbRaw)
} else if (mA) {
  quotaLabel = `+${mA[1]}`;        // verde (viene del color de qbRaw)
} else if (/^Cuotas al día$/i.test(qbRaw.label)) {
  quotaLabel = 'Al día';
}


      return (
        <TouchableOpacity
          activeOpacity={0.85}
          onPressIn={() => Keyboard.dismiss()}
          onPress={() => {
            if (justHandledCaptureRef.current) return;
            openPagoDirecto(item);
          }}
          onLongPress={() => openOpciones(item)}
          delayLongPress={220}
        >
          <View
            style={[
              styles.card,
              {
                backgroundColor: palette.cardBg,
                shadowColor: palette.text,
                borderColor: palette.cardBorder,
              },
              visitado && {
                borderLeftWidth: 4,
                borderLeftColor: palette.accent,
                backgroundColor: isDark ? palette.kpiTrack : '#F1FAF2',
              },
              !visitado && esNuevo && {
                borderLeftWidth: 4,
                borderLeftColor: '#1E88E5',
                backgroundColor: isDark ? '#0E2436' : '#E3F2FD',
              },
            ]}
          >
            <View style={styles.left}>{avatarFor(c)}</View>
            <View style={styles.mid}>
              <Text
                style={[
                  styles.name,
                  { color: palette.text },
                  visitado && { color: palette.accent },
                ]}
                numberOfLines={1}
              >
                {item.concepto}
                {c?.alias ? (
                  <Text style={[styles.alias, { color: palette.softText }]}> ({c.alias})</Text>
                ) : null}
              </Text>
              {c?.telefono1 ? (
                <Text style={[styles.meta, { color: palette.softText }]} numberOfLines={1}>
                  Teléfono: {c.telefono1}
                </Text>
              ) : null}
              {c?.direccion1 ? (
                <Text style={[styles.meta, { color: palette.softText }]} numberOfLines={1}>
                  Dirección: {c.direccion1}
                </Text>
              ) : null}
              {c?.direccion2 ? (
                <Text style={[styles.meta, { color: palette.softText }]} numberOfLines={1}>
                  Dirección 2: {c.direccion2}
                </Text>
              ) : null}

              <View style={styles.badgesRow}>
                <Text
                  style={[
                    styles.badge,
                    {
                      backgroundColor: qbRaw.bg,
                      color: qbRaw.text,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: qbRaw.border,
                    },
                  ]}
                >
                  {quotaLabel}
                </Text>

                {visitado ? (
                  <Text
                    style={[
                      styles.badge,
                      { backgroundColor: isDark ? palette.topBg : '#E8F5E9', color: palette.accent },
                    ]}
                  >
                    Visitado hoy
                  </Text>
                ) : (
                  <Text
                    style={[
                      styles.badge,
                      { backgroundColor: isDark ? '#3a2f14' : '#FFF8E1', color: isDark ? '#ffb74d' : '#e65100' },
                    ]}
                  >
                    Pendiente
                  </Text>
                )}
                {!visitado && esNuevo && (
                  <Text
                    style={[
                      styles.badge,
                      { backgroundColor: isDark ? '#0E2436' : '#E3F2FD', color: '#1565C0' },
                    ]}
                  >
                    Nuevo
                  </Text>
                )}
                <Text style={[styles.badge, { backgroundColor: palette.kpiTrack, color: palette.softText }]}>
                  {item.modalidad || 'Diaria'}
                </Text>
              </View>
            </View>
            <View style={styles.right}>
              <Text style={[styles.moneyCuota, { color: palette.text }]}>
                ${Number(item.valorCuota || 0).toFixed(0)}
              </Text>
              <Text style={[styles.moneySaldo, { color: palette.softText }]}>
                ${Number(item.restante || 0).toFixed(0)}
              </Text>
            </View>
          </View>
        </TouchableOpacity>
      );
    },
    [openPagoDirecto, openOpciones, esVisitadoHoy, palette, isDark, tzSession]
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg }}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder },
        ]}
      >
        <View style={{ width: 54 }} />
        <Text style={[styles.title, { color: palette.text }]}>Todos los Clientes</Text>
        <View style={{ width: 54 }} />
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
          placeholder="Buscar Cliente:"
          placeholderTextColor={palette.softText}
          style={[styles.searchInput, { color: palette.text }]}
          value={busqueda}
          onChangeText={setBusqueda}
          returnKeyType="search"
          onSubmitEditing={() => Keyboard.dismiss()}
        />
      </View>

      {cargando ? (
        <ActivityIndicator size="large" style={{ marginTop: 24 }} />
      ) : (
        <FlatList
          ref={flatRef}
          data={filasFiltradas}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={{
            paddingHorizontal: 12,
            paddingBottom: 52 + insets.bottom + 12,
          }}
          ItemSeparatorComponent={() => <View style={{ height: SEP_HEIGHT }} />}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', marginTop: 24 }}>
              <Text style={{ color: palette.softText }}>No hay resultados.</Text>
            </View>
          }
          initialNumToRender={16}
          windowSize={7}
          maxToRenderPerBatch={24}
          updateCellsBatchingPeriod={16}
          removeClippedSubviews
          getItemLayout={getItemLayout}
          keyboardShouldPersistTaps="always"
          onScroll={(e) => { lastOffsetRef.current = e.nativeEvent.contentOffset.y; }}
          scrollEventThrottle={16}
          onMomentumScrollBegin={() => { momentumRef.current = true; }}
          onMomentumScrollEnd={() => { momentumRef.current = false; }}
          onTouchEndCapture={handleTouchEndCapture}
        />
      )}

      {/* Tabs fijos */}
      <View
        style={[
          styles.tabs,
          {
            backgroundColor: palette.commBg,
            borderTopColor: palette.commBorder,
            paddingBottom: Math.max(8, insets.bottom),
          },
        ]}
      >
        <TabBtn label="Todos" active={filtro === 'todos'} onPress={() => setFiltro('todos')} palette={palette} />
        <TabBtn label="Pendientes" active={filtro === 'pendientes'} onPress={() => setFiltro('pendientes')} palette={palette} />
        <TabBtn label="Visitados" active={filtro === 'visitados'} onPress={() => setFiltro('visitados')} palette={palette} />
      </View>

      {/* Overlay opciones (long-press) */}
      {prestamoSeleccionado && (
        <InstantOpcionesCliente
          visible={opcionesVisible}
          cliente={{
            nombre: prestamoSeleccionado.concepto,
            comercio: prestamoSeleccionado.clienteAlias ?? '',
          }}
          onCerrar={() => setOpcionesVisible(false)}
          onSeleccionarOpcion={(opcion) => {
            if (opcion === 'pago') {
              setOpcionesVisible(false);
              setModalPagoVisible(true);
            } else if (opcion === 'historial') {
              setOpcionesVisible(false);
              const abonosCompat = (prestamoSeleccionado.abonos || []).map((a: any) => ({
                monto: Number(a.monto) || 0,
                fecha:
                  a.operationalDate ?? normYYYYMMDD(a.fecha) ?? todayInTZ(pickTZ(prestamoSeleccionado.tz)),
              }));
              navigation.navigate('HistorialPagos', {
                abonos: abonosCompat,
                nombreCliente: prestamoSeleccionado.concepto ?? 'Cliente',
                valorCuota: prestamoSeleccionado.valorCuota,
                totalPrestamo: prestamoSeleccionado.totalPrestamo,
              });
            } else if (opcion === 'historialPrestamos') {
              if (!prestamoSeleccionado?.clienteId) return;
              setOpcionesVisible(false);
              navigation.navigate('HistorialPrestamos', {
                clienteId: prestamoSeleccionado.clienteId as string,
                nombreCliente: prestamoSeleccionado.concepto ?? 'Cliente',
                admin,
              });
            } else if (opcion === 'info') {
              if (!prestamoSeleccionado?.clienteId) {
                Alert.alert('Falta ID', 'Este préstamo no tiene cliente asignado.');
                return;
              }
              setOpcionesVisible(false);
              navigation.navigate('InfoCliente', {
                clienteId: prestamoSeleccionado.clienteId as string,
                nombreCliente: prestamoSeleccionado.concepto ?? 'Cliente',
                admin,
              });
            }
          }}
        />
      )}

      {/* Modal de pago (tap simple) */}
      {prestamoSeleccionado && (
        <ModalRegistroPago
          visible={modalPagoVisible}
          onClose={() => setModalPagoVisible(false)}
          clienteNombre={prestamoSeleccionado?.concepto ?? ''}
          clienteId={prestamoSeleccionado?.clienteId ?? ''}
          prestamoId={prestamoSeleccionado?.id ?? ''}
          admin={admin}
          onSuccess={() => mostrarMensajeExito('Pago registrado correctamente')}
        />
      )}

      {mensajeExito !== '' && (
        <View
          style={[
            styles.toast,
            {
              backgroundColor: isDark ? '#000' : '#333',
              bottom: 52 + insets.bottom + 20,
            },
          ]}
        >
          <Text style={{ color: '#fff' }}>{mensajeExito}</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

function TabBtn({
  label,
  active,
  onPress,
  palette,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  palette: ReturnType<typeof useAppTheme>['palette'];
}) {
  return (
    <TouchableOpacity
      style={[
        styles.tabBtn,
        active && {
          backgroundColor: palette.topBg,
          borderTopWidth: 3,
          borderTopColor: palette.accent,
        },
      ]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <Text
        style={[
          styles.tabTxt,
          { color: palette.text },
          active && { color: palette.accent, fontWeight: '800' },
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  header: {
    borderBottomWidth: 1,
    paddingTop: 6,
    paddingBottom: 8,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 18, fontWeight: '700' },

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
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    elevation: 1,
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    minHeight: 86,
    borderWidth: 1,
  },

  left: { width: 42, alignItems: 'center' },
  mid: { flex: 1, paddingHorizontal: 10 },
  right: { width: 70, alignItems: 'flex-end' },

  name: { fontSize: 16, fontWeight: '700' },
  alias: { fontWeight: '400' },
  meta: { fontSize: 12, marginTop: 2 },

  badgesRow: { flexDirection: 'row', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  badge: {
    fontSize: 11,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    overflow: 'hidden',
    fontWeight: '700',
  },

  moneyCuota: { fontSize: 16, fontWeight: '700' },
  moneySaldo: { fontSize: 14, fontWeight: '700', marginTop: 6 },

  tabs: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    borderTopWidth: 1,
    paddingTop: 8,
  },
  tabBtn: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabTxt: { fontWeight: '600' },

  toast: {
    position: 'absolute',
    left: 20,
    right: 20,
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
});
