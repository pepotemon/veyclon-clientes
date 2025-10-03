// screens/InfoClienteScreen.tsx
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  FlatList,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { db } from '../firebase/firebaseConfig';
import {
  doc,
  getDoc,
  getDocs,
  collection,
  onSnapshot,
} from 'firebase/firestore';
import { MaterialCommunityIcons as MIcon, Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';
import { todayInTZ, normYYYYMMDD, pickTZ } from '../utils/timezone';
import { useAppTheme } from '../theme/ThemeProvider';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Props = NativeStackScreenProps<RootStackParamList, 'InfoCliente'>;

type Cliente = {
  id: string;
  alias?: string;
  direccion1?: string;
  direccion2?: string;
  telefono1?: string;
  telefono2?: string;
  genero?: 'M' | 'F' | 'O';
};

type Abono = {
  monto: number;
  fecha?: string;                 // ISO opcional
  operationalDate?: string;       // YYYY-MM-DD (preferido para “hoy”)
  tz?: string;
  registradoPor?: string;
  createdAtMs?: number;
};

type Prestamo = {
  id: string;
  clienteId?: string;
  concepto: string;
  cobradorId?: string;
  totalPrestamo: number;
  montoTotal?: number;
  restante: number;
  valorCuota: number;
  modalidad?: string;
  // KPIs denormalizados (NO recalcular) — pueden venir inconsistentes
  diasAtraso?: number;
  cuotasPagadas?: number;
  // opcionales
  tz?: string;
  fechaInicio?: string;
  estado?: string;   // compat local
  cuotas?: number;
  status?: string;   // fuente real
};

type HistorialItem = {
  id: string;
  concepto: string;
  fechaInicio?: any;
  fechaCierre?: any;
  totalPrestamo: number;
  valorNeto?: number;
  finalizadoPor?: string;
};

function fmtDate(value: any, pattern = 'dd/MM/yyyy') {
  if (!value) return '—';
  let d: Date | null = null;
  if (value?.toDate) d = value.toDate();
  else if (typeof value?.seconds === 'number') d = new Date(value.seconds * 1000);
  else if (typeof value === 'string') {
    const parsed = new Date(value);
    d = isNaN(+parsed) ? null : parsed;
  } else if (typeof value === 'number') d = new Date(value);
  if (!d || isNaN(+d)) return '—';
  return format(d, pattern);
}

const iconoPorGenero = (g?: 'F' | 'M' | 'O') => {
  if (g === 'F') return 'account-outline' as const;
  if (g === 'M') return 'account-tie' as const;
  return 'account-circle-outline' as const;
};

/** ============== PROGRESO ROBUSTO (evita 20/20 fantasma) ============== */
function calcProgresoPagadas(p: Prestamo) {
  const EPS = 0.009;

  const valorCuota = Number(p?.valorCuota || 0);
  const total = Number(p?.totalPrestamo ?? p?.montoTotal ?? 0);
  const restante = Number(p?.restante ?? total);

  // totalPlan
  let cuotasTotales = Number(p?.cuotas || 0);
  if (!(cuotasTotales > 0) && valorCuota > 0 && total > 0) {
    cuotasTotales = Math.ceil(total / valorCuota);
  }

  // candidato 1: campo agregado (si viene razonable)
  let pagadas = Number.isFinite(p?.cuotasPagadas) ? Math.max(0, Math.floor(Number(p.cuotasPagadas))) : NaN;

  // candidato 2: derivado de agregados (más confiable si hay restante/total)
  let pagadasDerivadas = NaN;
  if (valorCuota > 0 && total >= 0 && restante >= 0 && total >= restante) {
    const pagado = total - restante;
    pagadasDerivadas = Math.max(0, Math.floor((pagado + EPS) / valorCuota));
  }

  // elegir mejor fuente:
  // - si el agregado luce inconsistente (ej. igual a totales pero aún hay restante>0), usar derivado
  // - si no hay agregado o no es finito, usar derivado
  // - en última instancia, 0
  const agregadoLuceMalo =
    Number.isFinite(pagadas) &&
    cuotasTotales > 0 &&
    pagadas === cuotasTotales &&
    restante > 0;

  if (!Number.isFinite(pagadas) || agregadoLuceMalo) {
    if (Number.isFinite(pagadasDerivadas)) pagadas = Number(pagadasDerivadas);
    else pagadas = 0;
  }

  // clamp a [0, cuotasTotales] si hay totales
  if (cuotasTotales > 0) {
    pagadas = Math.max(0, Math.min(pagadas, cuotasTotales));
  }

  return { pagadas, cuotasTotales };
}

export default function InfoClienteScreen({ route, navigation }: Props) {
  const { clienteId, nombreCliente, admin } = route.params;
  const { palette } = useAppTheme();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [cliente, setCliente] = useState<Cliente | null>(null);
  const [prestamosActivos, setPrestamosActivos] = useState<Prestamo[]>([]);
  const [historial, setHistorial] = useState<HistorialItem[]>([]);
  const [loadingAbonosId, setLoadingAbonosId] = useState<string | null>(null);

  // Cargar cliente + escuchar préstamos (virtualizados en FlatList)
  useEffect(() => {
    let unsub: undefined | (() => void);
    (async () => {
      try {
        setLoading(true);

        // 1) Doc cliente (one-shot)
        const cSnap = await getDoc(doc(db, 'clientes', clienteId));
        const cData = cSnap.exists() ? ({ id: cSnap.id, ...(cSnap.data() as any) } as Cliente) : null;
        setCliente(cData);

        // 2) Listener solo a préstamos del cliente
        unsub = onSnapshot(
          collection(db, 'clientes', clienteId, 'prestamos'),
          (snap) => {
            const arr: Prestamo[] = [];
            snap.forEach((d) => {
              const data = d.data() as any;
              arr.push({
                id: d.id,
                clienteId,
                concepto: (data.concepto ?? '').trim() || 'Sin nombre',
                totalPrestamo: Number(data.totalPrestamo ?? data.montoTotal ?? 0),
                restante: Number(data.restante ?? 0),
                valorCuota: Number(data.valorCuota ?? 0),
                modalidad: data.modalidad ?? 'Diaria',
                tz: data.tz || 'America/Sao_Paulo',
                fechaInicio: data.fechaInicio,
                // estado real: muchos docs nuevos usan 'status'
                estado: data.status ?? data.estado,
                cuotas: typeof data.cuotas === 'number' ? data.cuotas : undefined,
                // KPIs denormalizados (pueden venir inconsistentes)
                diasAtraso: typeof data.diasAtraso === 'number' ? data.diasAtraso : undefined,
                cuotasPagadas: typeof data.cuotasPagadas === 'number' ? data.cuotasPagadas : undefined,
                status: data.status,
              });
            });

            // Filtrar "activos" sin bloquear (usa 'status' si está)
            const activos = arr.filter(
              (p) => (p.status ?? p.estado ?? 'activo') === 'activo' && Number(p.restante || 0) > 0
            );
            setPrestamosActivos(activos);
            setLoading(false);
          },
          (err) => {
            console.warn('[InfoCliente] prestamos snapshot error:', err?.code || err?.message || err);
            setPrestamosActivos([]);
            setLoading(false);
          }
        );

        // 3) Historial de préstamos finalizados (one-shot)
        const hSnap = await getDocs(collection(db, 'clientes', clienteId, 'historialPrestamos'));
        const hist: HistorialItem[] = [];
        hSnap.forEach((d) => {
          const data = d.data() as any;
          if (!admin || data?.finalizadoPor === admin) {
            hist.push({
              id: d.id,
              concepto: data.concepto ?? 'Sin nombre',
              fechaInicio: data.fechaInicio,
              fechaCierre: data.finalizadoEn,
              totalPrestamo: Number(data.totalPrestamo ?? data.montoTotal ?? 0),
              valorNeto: Number(data.valorNeto ?? 0),
              finalizadoPor: data.finalizadoPor,
            });
          }
        });
        hist.sort((a, b) => (b?.fechaCierre?.seconds || 0) - (a?.fechaCierre?.seconds || 0));
        setHistorial(hist);
      } catch (e) {
        console.error('❌ Error cargando InfoCliente:', e);
        Alert.alert('Error', 'No fue posible cargar la información del cliente.');
        setLoading(false);
      }
    })();

    return () => {
      try { unsub && unsub(); } catch {}
    };
  }, [clienteId, admin]);

  const handleAbrirHistorialPagos = useCallback(async (p: Prestamo) => {
    try {
      setLoadingAbonosId(p.id);
      // Cargar abonos SOLO al abrir historial (lazy)
      const sub = collection(db, 'clientes', clienteId, 'prestamos', p.id, 'abonos');
      const snap = await getDocs(sub);
      const abonosCompat = snap.docs.map((dd) => {
        const a = dd.data() as any;
        const tz = pickTZ(a?.tz, 'America/Sao_Paulo');
        const ymd = a?.operationalDate ?? normYYYYMMDD(a?.fecha) ?? todayInTZ(tz);
        return {
          monto: Number(a?.monto) || 0,
          fecha: ymd,
        };
      });

      navigation.navigate('HistorialPagos', {
        abonos: abonosCompat,
        nombreCliente: p.concepto ?? 'Cliente',
        valorCuota: p.valorCuota,
        totalPrestamo: p.totalPrestamo,
      });
    } catch (e) {
      console.warn('[InfoCliente] cargar historial pagos:', e);
      Alert.alert('Error', 'No se pudo cargar el historial de pagos.');
    } finally {
      setLoadingAbonosId(null);
    }
  }, [clienteId, navigation]);

  // ====== UI ======
  const { palette: pal } = useAppTheme();
  const ListHeader = (
    <View style={{ padding: 12 }}>
      {/* Card: Cliente */}
      <View
        style={[
          styles.card,
          { backgroundColor: pal.cardBg, borderColor: pal.cardBorder, borderWidth: 1 },
        ]}
      >
        <View style={styles.cardHeader}>
          <MIcon name={iconoPorGenero(cliente?.genero)} size={36} color={pal.accent} />
          <View style={{ marginLeft: 10, flex: 1 }}>
            <Text style={[styles.title, { color: pal.text }]}>
              {nombreCliente || 'Cliente'}
            </Text>
            {!!cliente?.alias && (
              <Text style={[styles.sub, { color: pal.softText }]}>{cliente.alias}</Text>
            )}
          </View>
        </View>

        {!!cliente?.telefono1 && (
          <Text style={[styles.line, { color: pal.softText }]}>
            <MIcon name="phone" size={14} color={pal.softText} />  {cliente.telefono1}
          </Text>
        )}
        {!!cliente?.telefono2 && (
          <Text style={[styles.line, { color: pal.softText }]}>
            <MIcon name="phone-outline" size={14} color={pal.softText} />  {cliente.telefono2}
          </Text>
        )}
        {!!cliente?.direccion1 && (
          <Text style={[styles.line, { color: pal.softText }]}>
            <MIcon name="map-marker" size={14} color={pal.softText} />  {cliente.direccion1}
          </Text>
        )}
        {!!cliente?.direccion2 && (
          <Text style={[styles.line, { color: pal.softText }]}>
            <MIcon name="map-marker-outline" size={14} color={pal.softText} />  {cliente.direccion2}
          </Text>
        )}
      </View>

      {/* Header de lista de préstamos activos */}
      <View
        style={[
          styles.card,
          { backgroundColor: pal.cardBg, borderColor: pal.cardBorder, borderWidth: 1 },
        ]}
      >
        <View style={styles.cardHeaderRow}>
          <MIcon name="cash-multiple" size={20} color={pal.accent} />
          <Text style={[styles.cardTitle, { color: pal.text }]}>Préstamos activos</Text>
          <Text
            style={[
              styles.pill,
              { backgroundColor: pal.topBg, color: pal.accent, borderColor: pal.topBorder, borderWidth: 1 },
            ]}
          >
            {prestamosActivos.length}
          </Text>
        </View>
        {prestamosActivos.length === 0 && (
          <Text style={[styles.empty, { color: pal.softText }]}>No hay préstamos activos.</Text>
        )}
      </View>
    </View>
  );

  const ListFooter = (
    <View style={{ padding: 12 }}>
      {/* Card: Historial de préstamos finalizados */}
      <View
        style={[
          styles.card,
          { backgroundColor: pal.cardBg, borderColor: pal.cardBorder, borderWidth: 1 },
        ]}
      >
        <View style={styles.cardHeaderRow}>
          <MIcon name="file-document" size={20} color={pal.accent} />
          <Text style={[styles.cardTitle, { color: pal.text }]}>Historial de préstamos</Text>
        </View>

        {historial.length === 0 ? (
          <Text style={[styles.empty, { color: pal.softText }]}>No hay préstamos finalizados.</Text>
        ) : (
          <>
            {historial.slice(0, 3).map((h) => (
              <TouchableOpacity
                key={h.id}
                activeOpacity={0.9}
                onPress={() =>
                  navigation.navigate('DetalleHistorialPrestamo', {
                    clienteId,
                    historialId: h.id,
                    nombreCliente: h.concepto,
                  })
                }
                style={[
                  styles.histRow,
                  { borderColor: pal.cardBorder, backgroundColor: pal.kpiBg },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.histName, { color: pal.text }]}>{h.concepto}</Text>
                  <Text style={[styles.histMeta, { color: pal.softText }]}>
                    {fmtDate(h.fechaInicio)} → {fmtDate(h.fechaCierre)}
                  </Text>
                </View>
                <Text style={[styles.histTotal, { color: pal.text }]}>
                  R$ {Number(h.totalPrestamo || 0).toFixed(2)}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={() =>
                navigation.navigate('HistorialPrestamos', {
                  clienteId,
                  nombreCliente: nombreCliente || cliente?.alias || 'Cliente',
                  admin,
                })
              }
              style={{ marginTop: 8, alignSelf: 'flex-start' }}
            >
              <Text style={[styles.link, { color: pal.accent }]}>ver todo</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );

  const renderPrestamo = ({ item: p }: { item: Prestamo }) => {
    const { pagadas, cuotasTotales } = calcProgresoPagadas(p);
    const progreso =
      cuotasTotales > 0 ? `${pagadas}/${cuotasTotales}` : `${pagadas}`;

    return (
      <View
        style={[
          styles.loanBox,
          { borderColor: palette.cardBorder, backgroundColor: palette.kpiBg, marginHorizontal: 12, marginTop: 8 },
        ]}
      >
        <Text style={[styles.loanName, { color: palette.text }]} numberOfLines={1}>{p.concepto}</Text>

        <Text style={[styles.loanMeta, { color: palette.softText }]}>
          Modalidad: {p.modalidad || 'Diaria'} • Cuota: R$ {Number(p.valorCuota || 0).toFixed(2)}
        </Text>

        <Text style={[styles.loanMeta, { color: palette.softText }]}>
          Saldo{' '}
          <Text style={[styles.kpiStrong, { color: palette.text }]}>
            R$ {Number(p.restante || 0).toFixed(2)}
          </Text>
        </Text>

        {!!p.fechaInicio && (
          <Text style={[styles.loanMeta, { color: palette.softText }]}>
            Inicio: {fmtDate(p.fechaInicio)}
          </Text>
        )}

        <View style={styles.badgesRow}>
          <Text
            style={[
              styles.badge,
              { backgroundColor: palette.topBg, color: palette.text, borderColor: palette.topBorder, borderWidth: 1 },
            ]}
          >
            {p.modalidad || 'Diaria'}
          </Text>

          <Text
            style={[
              styles.badge,
              { backgroundColor: palette.topBg, color: palette.accent, borderColor: palette.topBorder, borderWidth: 1 },
            ]}
          >
            Pagadas: {progreso}
          </Text>

          <Text
            style={[
              styles.badge,
              { backgroundColor: palette.topBg, color: '#1565C0', borderColor: palette.topBorder, borderWidth: 1 },
            ]}
          >
            Atraso: {Number(p.diasAtraso || 0)} d
          </Text>
        </View>

        <View style={styles.rowActions}>
          <TouchableOpacity
            activeOpacity={0.9}
            style={[styles.btn, { backgroundColor: palette.accent }]}
            onPress={() => handleAbrirHistorialPagos(p)}
            disabled={loadingAbonosId === p.id}
          >
            <Text style={[styles.btnTxt, { color: '#fff' }]}>
              {loadingAbonosId === p.id ? 'Cargando…' : 'Historial de pagos'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: palette.screenBg,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
      }}
    >
      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder },
        ]}
      >
        <Ionicons name="information-circle-outline" size={22} color={palette.accent} />
        <Text style={[styles.headerTitle, { color: palette.text }]}>Info completa</Text>
        <View style={{ width: 22 }} />
      </View>

      {loading ? (
        <ActivityIndicator size="large" style={{ marginTop: 32 }} />
      ) : !cliente ? (
        <View style={{ alignItems: 'center', marginTop: 24 }}>
          <Text style={{ color: palette.softText }}>Cliente no encontrado.</Text>
        </View>
      ) : (
        <FlatList
          data={prestamosActivos}
          keyExtractor={(p) => p.id}
          renderItem={renderPrestamo}
          ListHeaderComponent={ListHeader}
          ListFooterComponent={ListFooter}
          contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}
          initialNumToRender={8}
          windowSize={7}
          maxToRenderPerBatch={16}
          updateCellsBatchingPeriod={16}
          removeClippedSubviews
        />
      )}
    </View>
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

  card: {
    borderRadius: 12,
    padding: 14,
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    marginBottom: 12,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  title: { fontSize: 16, fontWeight: '800' },
  sub: { fontSize: 12, marginTop: 2 },

  line: { fontSize: 13, marginTop: 6 },

  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  cardTitle: { fontSize: 15, fontWeight: '800', flex: 1 },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: 'hidden',
  },

  loanBox: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
  },
  loanName: { fontSize: 14, fontWeight: '800' },
  loanMeta: { fontSize: 12, marginTop: 4 },

  badgesRow: { flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  badge: {
    fontSize: 11,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    overflow: 'hidden',
  },

  rowActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  btn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  btnTxt: { fontWeight: '800' },
  kpiStrong: { fontWeight: '900' },

  empty: { fontStyle: 'italic', paddingVertical: 4 },

  histRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginTop: 8,
    gap: 10,
  },
  histName: { fontSize: 14, fontWeight: '800' },
  histMeta: { fontSize: 12, marginTop: 2 },
  histTotal: { fontSize: 12, fontWeight: '800' },

  link: {
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
});
