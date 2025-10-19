// screens/PagosDiariosScreen.tsx
import React, {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
  useTransition,
  useDeferredValue,
} from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  AppState,
  StatusBar,
  ListRenderItem,
  Keyboard,
  DeviceEventEmitter,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { db } from '../firebase/firebaseConfig';
import {
  getDocs,
  collection,
  collectionGroup,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import ModalRegistroPago from '../components/ModalRegistroPago';
import InstantOpcionesCliente from '../components/InstantOpcionesCliente';
import { RootStackParamList } from '../App';
import { todayInTZ, nextMidnightDelayInTZ, normYYYYMMDD, pickTZ } from '../utils/timezone';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from '../theme/ThemeProvider';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { computeQuotaBadge } from '../utils/alerts';
import { OUTBOX_FLUSHED } from '../utils/outbox';

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
  clienteTelefono1?: string;

  tz?: string;

  creadoEn?: any;
  createdAtMs?: number;
  fechaInicio?: string;

  permitirAdelantar?: boolean;
  cuotas?: number;
  diasHabiles?: number[];
  feriados?: string[];
  pausas?: { desde: string; hasta: string; motivo?: string }[];
  modoAtraso?: 'porPresencia' | 'porCuota';

  lastAbonoAt?: any;

  routeOrder?: number;
  proximoVencimiento?: string;
  status?: 'activo' | 'cerrado' | 'pausado';
};

type Filtro = 'todos' | 'pendientes' | 'visitados';

export default function PagosDiariosScreen({ route }: any) {
  const admin = route?.params?.admin ?? 'AdminDemo';
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();
  const { palette, isDark } = useAppTheme();

  const [prestamos, setPrestamos] = useState<Prestamo[]>([]);
  const [cargando, setCargando] = useState(true);

  const [busqueda, setBusqueda] = useState('');
  const [opcionesVisible, setOpcionesVisible] = useState(false);
  const [modalPagoVisible, setModalPagoVisible] = useState(false);

  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [dayTick, setDayTick] = useState(0);
  const [mensajeExito, setMensajeExito] = useState('');

  const [outboxPulse, setOutboxPulse] = useState(0);

  const tzSession = 'America/Sao_Paulo';
  const [isPending, startTransition] = useTransition();

  // ===== Helpers de fecha =====
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

  // ✅ selección con ref (no dispara renders en toda la lista)
  const selectedRef = useRef<Prestamo | null>(null);

  // ⚡ Prefetch para el modal (lo pasaremos cuando actualicemos ModalRegistroPago)
  const [prefetchedPago, setPrefetchedPago] = useState<{ valorCuota?: number; saldoPendiente?: number } | undefined>();

  const openPagoDirecto = useCallback((item: Prestamo) => {
    selectedRef.current = item;
    // capturamos los datos necesarios para abrir el modal sin I/O
    setPrefetchedPago({
      valorCuota: Number(item.valorCuota) || 0,
      saldoPendiente: Number(item.restante) || 0,
    });
    setOpcionesVisible(false);
    setModalPagoVisible(true);
  }, []);

  const openOpciones = useCallback((item: Prestamo) => {
    selectedRef.current = item;
    setOpcionesVisible(true);
  }, []);

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

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(OUTBOX_FLUSHED, () => {
      setOutboxPulse((n) => n + 1);
    });
    return () => sub.remove();
  }, []);

  const hoySession = useMemo(() => todayInTZ(tzSession), [tzSession, dayTick, outboxPulse]);

  const esVisitadoHoy = useCallback(
    (p: Prestamo) => {
      const tz = pickTZ(p.tz, tzSession);
      const hoy = todayInTZ(tz);
      const viaArray =
        Array.isArray(p.abonos) &&
        p.abonos.some((a) => {
          const dia = a.operationalDate ?? normYYYYMMDD(a.fecha);
          return dia === hoy;
        });
      if (viaArray) return true;
      const lastYmd = anyDateToYYYYMMDD(p.lastAbonoAt, tz);
      return lastYmd === hoy;
    },
    [tzSession]
  );

  // ======== Stream de préstamos ========
  useEffect(() => {
    let unsub: undefined | (() => void);

    const suscribir = async () => {
      try {
        setCargando(true);

        const qPrestamos = query(
          collectionGroup(db, 'prestamos'),
          where('creadoPor', '==', admin)
        );

        unsub = onSnapshot(
          qPrestamos,
          (sg) => {
            const lista: Prestamo[] = [];
            sg.forEach((docSnap) => {
              const data = docSnap.data() as any;

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

                clienteAlias: data.clienteAlias ?? data.clienteNombre ?? '',
                clienteDireccion1: data.clienteDireccion1 ?? '',
                clienteDireccion2: data.clienteDireccion2 ?? '',
                clienteTelefono1: data.clienteTelefono1 ?? '',

                tz: data.tz || 'America/Sao_Paulo',

                creadoEn: data.creadoEn,
                createdAtMs: data.createdAtMs,
                fechaInicio: data.fechaInicio,

                permitirAdelantar: data.permitirAdelantar,
                cuotas: data.cuotas,
                diasHabiles: data.diasHabiles,
                feriados: data.feriados,
                pausas: data.pausas,
                modoAtraso: data.modoAtraso,

                lastAbonoAt: data.lastAbonoAt,

                routeOrder: typeof data.routeOrder === 'number' ? data.routeOrder : undefined,
                proximoVencimiento: typeof data.proximoVencimiento === 'string' ? data.proximoVencimiento : undefined,
                status: data.status,
              });
            });

            startTransition(() => {
              setPrestamos(lista);
              setCargando(false);
            });
          },
          (err) => {
            console.warn('[pagosDiarios] snapshot error:', err?.code || err?.message || err);
            setPrestamos([]);
            setCargando(false);
          }
        );
      } catch (e) {
        console.warn('[pagosDiarios] suscripción no disponible:', e);
        setCargando(false);
      }
    };

    suscribir();
    return () => {
      try { unsub && unsub(); } catch {}
    };
  }, [admin]);

  // ====== Orden barato ======
  const filas: Prestamo[] = useMemo(() => {
    const BIG = 1e9;
    const normDate = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '9999-12-31');

    return [...prestamos]
      .filter((p) => p.creadoPor === admin && (p.status ? p.status === 'activo' : true) && Number(p.restante) > 0)
      .sort((a, b) => {
        const ra = typeof a.routeOrder === 'number' ? a.routeOrder : BIG;
        const rb = typeof b.routeOrder === 'number' ? b.routeOrder : BIG;
        if (ra !== rb) return ra - rb;

        const da = normDate(a.proximoVencimiento);
        const db = normDate(b.proximoVencimiento);
        if (da !== db) return da < db ? -1 : 1;

        return (a.concepto || '').localeCompare(b.concepto || '');
      });
  }, [prestamos, admin, outboxPulse]);

  // ====== Búsqueda ======
  const busquedaDeferred = useDeferredValue(busqueda);
  const filasBuscadas = useMemo(() => {
    const q = busquedaDeferred.trim().toLowerCase();
    if (!q) return filas;
    return filas.filter((x) => {
      const hay = [x.concepto, x.clienteAlias, x.clienteDireccion1, x.clienteDireccion2, x.clienteTelefono1, x.clienteId]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [filas, busquedaDeferred]);

  const filasFiltradas = useMemo(() => {
    if (filtro === 'pendientes') return filasBuscadas.filter((p) => !esVisitadoHoy(p));
    if (filtro === 'visitados') return filasBuscadas.filter((p) => esVisitadoHoy(p));
    return filasBuscadas;
  }, [filasBuscadas, filtro, esVisitadoHoy, hoySession]);

  const abrirModalPago = useCallback(() => {
    const sel = selectedRef.current;
    if (!sel?.clienteId) {
      Alert.alert('Error', 'Este préstamo no tiene cliente asignado');
      return;
    }
    // también precargamos aquí por si vienes del long-press
    setPrefetchedPago({
      valorCuota: Number(sel.valorCuota) || 0,
      saldoPendiente: Number(sel.restante) || 0,
    });
    setOpcionesVisible(false);
    setModalPagoVisible(true);
  }, []);

  const mostrarMensajeExito = (mensaje: string) => {
    setMensajeExito(mensaje);
    setTimeout(() => setMensajeExito(''), 2500);
  };

  const handlePagoSuccess = useCallback((payload?: {
    clienteId: string;
    prestamoId: string;
    monto: number;
    restanteNuevo?: number;
    optimistic?: boolean;
  }) => {
    if (!payload) {
      mostrarMensajeExito('Pago registrado correctamente');
      return;
    }

    const { prestamoId, monto, restanteNuevo, optimistic } = payload;

    setPrestamos((prev) =>
      prev.map((it) => {
        if (it.id !== prestamoId) return it;
        const base = {
          ...it,
          lastAbonoAt: Date.now(),
        };

        if (optimistic) {
          const rest = Math.max((it.restante ?? 0) - (monto ?? 0), 0);
          return { ...base, restante: rest };
        }

        return typeof restanteNuevo === 'number'
          ? { ...base, restante: Math.max(restanteNuevo, 0) }
          : base;
      })
    );

    if (!optimistic) {
      mostrarMensajeExito('Pago registrado correctamente');
    }
  }, []);

  const RowItem = React.memo(function RowItem({ item }: { item: Prestamo }) {
    const visitado = esVisitadoHoy(item);
    const esNuevo = !visitado && esNuevoHoyOPas48h(item);

    const qbRaw = useMemo(
      () => computeQuotaBadge(item),
      [item.id, item.valorCuota, item.restante, item.lastAbonoAt, (item.abonos || []).length]
    );

    let quotaLabel = qbRaw.label;
    const mV = qbRaw.label.match(/^Cuota(?:s)?\s+vencida(?:s)?:\s*(\d+)/i);
    const mA = qbRaw.label.match(/^Cuota(?:s)?\s+adelantada(?:s)?:\s*(\d+)/i);
    if (mV) quotaLabel = `+${mV[1]}`;
    else if (mA) quotaLabel = `+${mA[1]}`;
    else if (/^Cuotas al día$/i.test(qbRaw.label)) quotaLabel = 'Al día';

    return (
      <TouchableOpacity
        activeOpacity={0.85}
        onPressIn={() => Keyboard.dismiss()}
        onPress={() => openPagoDirecto(item)}
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
          <View style={styles.left}>
            <Ionicons name="person" size={28} color={palette.softText} />
          </View>

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
              {item.clienteAlias ? (
                <Text style={[styles.alias, { color: palette.softText }]}> ({item.clienteAlias})</Text>
              ) : null}
            </Text>

            {!!item.clienteTelefono1 && (
              <Text style={[styles.meta, { color: palette.softText }]} numberOfLines={1}>
                Teléfono: {item.clienteTelefono1}
              </Text>
            )}
            {!!item.clienteDireccion1 && (
              <Text style={[styles.meta, { color: palette.softText }]} numberOfLines={1}>
                Dirección: {item.clienteDireccion1}
              </Text>
            )}
            {!!item.clienteDireccion2 && (
              <Text style={[styles.meta, { color: palette.softText }]} numberOfLines={1}>
                Dirección 2: {item.clienteDireccion2}
              </Text>
            )}

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
  });

  const renderItem: ListRenderItem<Prestamo> = useCallback(
    ({ item }) => <RowItem item={item} />,
    []
  );

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: palette.screenBg }}
      edges={['left','right']}
    >
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
          data={filasFiltradas}
          keyExtractor={(it) => it.id}
          renderItem={renderItem}
          contentContainerStyle={{
            paddingHorizontal: 12,
            paddingBottom: 52 + insets.bottom + 12,
          }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', marginTop: 24 }}>
              <Text style={{ color: palette.softText }}>No hay resultados.</Text>
            </View>
          }
          // 🔧 Virtualización
          initialNumToRender={20}
          maxToRenderPerBatch={20}
          windowSize={9}
          updateCellsBatchingPeriod={40}
          removeClippedSubviews={Platform.OS === 'ios'}
          keyboardShouldPersistTaps="always"
          extraData={outboxPulse}
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

      {/* Overlay opciones (long-press) — SIEMPRE MONTADO */}
      <InstantOpcionesCliente
        visible={opcionesVisible}
        cliente={{
          nombre: selectedRef.current?.concepto ?? '',
          comercio: selectedRef.current?.clienteAlias ?? '',
        }}
        onCerrar={() => setOpcionesVisible(false)}
        onSeleccionarOpcion={async (opcion) => {
          const prestamoSeleccionado = selectedRef.current;
          if (!prestamoSeleccionado) return;

          if (opcion === 'pago') {
            // precargamos para la apertura por long-press
            setPrefetchedPago({
              valorCuota: Number(prestamoSeleccionado.valorCuota) || 0,
              saldoPendiente: Number(prestamoSeleccionado.restante) || 0,
            });
            setOpcionesVisible(false);
            setModalPagoVisible(true);
          } else if (opcion === 'historial') {
            setOpcionesVisible(false);

            // 🔎 Traer abonos desde SUBCOLECCIÓN
            let abonosCompat: { monto: number; fecha: string }[] = [];
            try {
              if (prestamoSeleccionado?.clienteId && prestamoSeleccionado?.id) {
                const colRef = collection(
                  db,
                  'clientes',
                  prestamoSeleccionado.clienteId,
                  'prestamos',
                  prestamoSeleccionado.id,
                  'abonos'
                );
                const snap = await getDocs(colRef);
                abonosCompat = snap.docs
                  .map((d) => d.data() as any)
                  .map((a) => ({
                    monto: Number(a?.monto) || 0,
                    fecha:
                      a?.operationalDate ??
                      normYYYYMMDD(a?.fecha) ??
                      todayInTZ(pickTZ(prestamoSeleccionado.tz)),
                  }));
              }
            } catch {
              abonosCompat = (prestamoSeleccionado.abonos || []).map((a: any) => ({
                monto: Number(a.monto) || 0,
                fecha:
                  a.operationalDate ??
                  normYYYYMMDD(a.fecha) ??
                  todayInTZ(pickTZ(prestamoSeleccionado.tz)),
              }));
            }

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

      {/* Modal de pago — SIEMPRE MONTADO
          En el próximo paso le pasaremos:
          prefetched={prefetchedPago}
      */}
      <ModalRegistroPago
        visible={modalPagoVisible}
        onClose={() => setModalPagoVisible(false)}
        clienteNombre={selectedRef.current?.concepto ?? ''}
        clienteId={selectedRef.current?.clienteId ?? ''}
        prestamoId={selectedRef.current?.id ?? ''}
        admin={admin}
        onSuccess={handlePagoSuccess}
        // ⚠️ Próximo paso: cuando actualicemos ModalRegistroPago, descomentar y tipar:
        // prefetched={prefetchedPago}
      />

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
