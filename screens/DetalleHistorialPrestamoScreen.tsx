// screens/DetalleHistorialPrestamoScreen.tsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  FlatList,
  TouchableOpacity,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { db } from '../firebase/firebaseConfig';
import { doc, getDoc } from 'firebase/firestore';
import { Ionicons } from '@expo/vector-icons';
import { MaterialCommunityIcons as MIcon } from '@expo/vector-icons';
import { format } from 'date-fns';
import { useAppTheme } from '../theme/ThemeProvider';

type Props = NativeStackScreenProps<RootStackParamList, 'DetalleHistorialPrestamo'>;

type Abono = {
  monto: number;
  fecha?: any;             // puede venir como ISO/Date/Timestamp
  operationalDate?: string;
  tz?: string;
  registradoPor?: string;
};

type HistDoc = {
  concepto?: string;
  valorCuota?: number;
  totalPrestamo?: number;
  montoTotal?: number;
  restante?: number;
  fechaInicio?: any;
  finalizadoEn?: any;
  creadoPor?: string;
  finalizadoPor?: string;
  diasAtraso?: number;
  faltas?: string[];       // si lo guardaste al cerrar
  abonos?: Abono[];
};

// Helper robusto de fechas
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
  try { return format(d, pattern); } catch { return d.toLocaleString(); }
}

export default function DetalleHistorialPrestamoScreen({ route, navigation }: Props) {
  const { clienteId, historialId, nombreCliente } = route.params;
  const { palette } = useAppTheme();

  const [docData, setDocData] = useState<HistDoc | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    const cargar = async () => {
      try {
        setCargando(true);
        const ref = doc(db, 'clientes', clienteId, 'historialPrestamos', historialId);
        const snap = await getDoc(ref);
        if (snap.exists()) {
          setDocData(snap.data() as HistDoc);
        } else {
          setDocData(null);
        }
      } catch (e) {
        console.error('Error leyendo historial:', e);
        setDocData(null);
      } finally {
        setCargando(false);
      }
    };
    cargar();
  }, [clienteId, historialId]);

  // Cálculos
  const totalPrestamo = useMemo(
    () => Number(docData?.totalPrestamo ?? docData?.montoTotal ?? 0),
    [docData]
  );
  const valorCuota = useMemo(() => Number(docData?.valorCuota ?? 0), [docData]);

  const abonosOrdenados = useMemo(() => {
    const arr = Array.isArray(docData?.abonos) ? [...docData!.abonos] : [];
    return arr.sort((a, b) => {
      const da = (a.fecha?.seconds ? a.fecha.seconds * 1000 : Date.parse(a.fecha ?? a.operationalDate ?? 0)) || 0;
      const dbb = (b.fecha?.seconds ? b.fecha.seconds * 1000 : Date.parse(b.fecha ?? b.operationalDate ?? 0)) || 0;
      return dbb - da;
    });
  }, [docData]);

  const totalAbonado = useMemo(
    () => abonosOrdenados.reduce((acc, a) => acc + Number(a.monto || 0), 0),
    [abonosOrdenados]
  );

  const cuotasPagadas = useMemo(
    () => (valorCuota > 0 ? Math.floor(totalAbonado / valorCuota) : 0),
    [totalAbonado, valorCuota]
  );

  // Días de atraso final: preferimos length de faltas; si no, diasAtraso numérico; si no, 0
  const diasAtrasoFinal = useMemo(() => {
    if (Array.isArray(docData?.faltas)) return docData!.faltas.length;
    if (typeof docData?.diasAtraso === 'number') return docData!.diasAtraso;
    return 0;
  }, [docData]);

  const periodoStr = useMemo(() => {
    const ini = fmtDate(docData?.fechaInicio);
    const fin = fmtDate(docData?.finalizadoEn);
    return `${ini} → ${fin}`;
  }, [docData]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg }}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder },
        ]}
      >
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Ionicons name="chevron-back" size={22} color={palette.accent} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: palette.text }]}>Detalle del Préstamo</Text>
        <View style={styles.headerBtn} />
      </View>

      {/* Encabezado cliente / concepto */}
      <View
        style={[
          styles.card,
          { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
        ]}
      >
        <MIcon name="file-document" size={28} color={palette.accent} />
        <View style={{ marginLeft: 10, flex: 1 }}>
          <Text style={[styles.clientName, { color: palette.text }]} numberOfLines={1}>
            {docData?.concepto || nombreCliente || 'Préstamo'}
          </Text>
          <Text style={[styles.clientSub, { color: palette.softText }]} numberOfLines={1}>
            Periodo: {periodoStr}
          </Text>
        </View>
      </View>

      {cargando ? (
        <ActivityIndicator size="large" style={{ marginTop: 24 }} />
      ) : !docData ? (
        <View style={{ alignItems: 'center', marginTop: 24 }}>
          <Text style={{ color: palette.softText }}>No se encontró este historial.</Text>
        </View>
      ) : (
        <>
          {/* KPIs */}
          <View style={styles.kpiRow}>
            <View
              style={[
                styles.kpiBox,
                { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
              ]}
            >
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Total préstamo</Text>
              <Text style={[styles.kpiValue, { color: palette.text }]}>
                R$ {totalPrestamo.toFixed(2)}
              </Text>
            </View>
            <View
              style={[
                styles.kpiBox,
                { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
              ]}
            >
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Valor cuota</Text>
              <Text style={[styles.kpiValue, { color: palette.text }]}>
                R$ {valorCuota.toFixed(2)}
              </Text>
            </View>
          </View>

          <View style={styles.kpiRow}>
            <View
              style={[
                styles.kpiBox,
                { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
              ]}
            >
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Total abonado</Text>
              <Text style={[styles.kpiValue, { color: palette.text }]}>
                R$ {totalAbonado.toFixed(2)}
              </Text>
            </View>
            <View
              style={[
                styles.kpiBox,
                { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
              ]}
            >
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Cuotas pagadas</Text>
              <Text style={[styles.kpiValue, { color: palette.accent }]}>{cuotasPagadas}</Text>
            </View>
          </View>

          <View style={styles.kpiRow}>
            <View
              style={[
                styles.kpiBox,
                { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
              ]}
            >
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Días de atraso (final)</Text>
              <Text style={[styles.kpiValue, { color: palette.text }]}>{diasAtrasoFinal}</Text>
            </View>
            <View
              style={[
                styles.kpiBox,
                { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
              ]}
            >
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Finalizado por</Text>
              <Text style={[styles.kpiValue, { color: palette.text }]}>{docData.finalizadoPor || '—'}</Text>
            </View>
          </View>

          {/* Lista de pagos */}
          <Text style={[styles.sectionTitle, { color: palette.text }]}>Pagos realizados</Text>
          <FlatList
            data={abonosOrdenados}
            keyExtractor={(_, i) => String(i)}
            contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 16 }}
            ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
            ListEmptyComponent={
              <View style={{ alignItems: 'center', marginTop: 6 }}>
                <Text style={{ color: palette.softText }}>No hay abonos registrados.</Text>
              </View>
            }
            renderItem={({ item }) => {
              // mostrar fecha (prioriza a.fecha; fallback operationalDate)
              const fechaTxt = item.fecha
                ? fmtDate(item.fecha, 'dd/MM/yyyy HH:mm')
                : (item.operationalDate || '—');
              return (
                <View
                  style={[
                    styles.itemCard,
                    { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
                  ]}
                >
                  <View style={styles.itemLeftIcon}>
                    <MIcon name="cash-multiple" size={22} color={palette.accent} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.itemMonto, { color: palette.text }]}>
                      R$ {Number(item.monto || 0).toFixed(2)}
                    </Text>
                    <View style={styles.itemMetaRow}>
                      <MIcon name="calendar" size={14} color={palette.softText} />
                      <Text style={[styles.itemFecha, { color: palette.softText }]}>{fechaTxt}</Text>
                    </View>
                  </View>
                </View>
              );
            }}
          />
        </>
      )}
    </SafeAreaView>
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
  headerBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700' },

  card: {
    margin: 12,
    borderRadius: 12,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  clientName: { fontSize: 16, fontWeight: '800' },
  clientSub: { fontSize: 12, marginTop: 2 },

  kpiRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    marginTop: 6,
  },
  kpiBox: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 },
  },
  kpiLabel: { fontSize: 12, fontWeight: '700' },
  kpiValue: { fontSize: 16, fontWeight: '800', marginTop: 2 },

  sectionTitle: {
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 14,
    fontSize: 14,
    fontWeight: '800',
  },

  itemCard: {
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 },
  },
  itemLeftIcon: { width: 34, alignItems: 'center' },
  itemMonto: { fontSize: 16, fontWeight: '800' },
  itemMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  itemFecha: { fontSize: 12 },
});
