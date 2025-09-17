// screens/HistorialPrestamosScreen.tsx
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  ActivityIndicator,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
} from 'react-native';
import { db } from '../firebase/firebaseConfig';
import { collection, getDocs } from 'firebase/firestore';
import { Ionicons } from '@expo/vector-icons';
import { MaterialCommunityIcons as MIcon } from '@expo/vector-icons';
import { format } from 'date-fns';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { useAppTheme } from '../theme/ThemeProvider';

type Props = NativeStackScreenProps<RootStackParamList, 'HistorialPrestamos'>;

type HistorialItem = {
  id: string;
  clienteId: string;
  concepto: string;
  fechaInicio?: any;
  fechaCierre?: any;
  valorNeto: number;
  totalPrestamo: number;
  creadoPor: string;
  finalizadoPor?: string;
};

// ✅ Helper para convertir cualquier fecha/timestamp en string
function fmtDate(value: any, pattern = 'dd/MM/yyyy HH:mm') {
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

export default function HistorialPrestamosScreen({ route, navigation }: Props) {
  const { clienteId, nombreCliente, admin } = route?.params ?? {};
  const { palette } = useAppTheme();

  const [historial, setHistorial] = useState<HistorialItem[]>([]);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    const cargarHistorial = async () => {
      if (!clienteId) {
        setCargando(false);
        return;
      }
      setCargando(true);
      try {
        const snap = await getDocs(collection(db, 'clientes', clienteId, 'historialPrestamos'));
        const lista: HistorialItem[] = [];

        snap.forEach((docSnap) => {
          const data = docSnap.data() as any;
          if (!admin || data?.finalizadoPor === admin) {
            lista.push({
              id: docSnap.id,
              clienteId: data.clienteId ?? clienteId,
              concepto: data.concepto ?? 'Sin nombre',
              fechaInicio: data.fechaInicio,
              fechaCierre: data.finalizadoEn,
              valorNeto: data.valorNeto ?? 0,
              totalPrestamo: data.totalPrestamo ?? data.montoTotal ?? 0,
              creadoPor: data.creadoPor ?? '',
              finalizadoPor: data.finalizadoPor,
            });
          }
        });

        // Orden por cierre (Timestamp o undefined)
        lista.sort((a, b) =>
          (b.fechaCierre?.seconds || 0) - (a.fechaCierre?.seconds || 0)
        );
        setHistorial(lista);
      } catch (error) {
        console.error('Error cargando historial:', error);
      } finally {
        setCargando(false);
      }
    };

    cargarHistorial();
  }, [clienteId, admin]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg }}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder },
        ]}
      >
        <Ionicons name="time-outline" size={22} color={palette.accent} />
        <Text style={[styles.headerTitle, { color: palette.text }]}>
          Historial de Préstamos
        </Text>
        <View style={{ width: 22 }} />
      </View>

      {!!nombreCliente && (
        <Text style={[styles.subtitulo, { color: palette.softText }]}>
          Cliente: {nombreCliente}
        </Text>
      )}

      {cargando ? (
        <ActivityIndicator size="large" style={{ marginTop: 40 }} />
      ) : historial.length === 0 ? (
        <View style={{ marginTop: 40, alignItems: 'center' }}>
          <Text style={{ color: palette.softText }}>No hay préstamos finalizados.</Text>
        </View>
      ) : (
        <FlatList
          data={historial}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 12, paddingBottom: 20 }}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          renderItem={({ item }) => (
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={() =>
                navigation.navigate('DetalleHistorialPrestamo', {
                  clienteId,
                  historialId: item.id,
                  nombreCliente: item.concepto,
                })
              }
            >
              <View
                style={[
                  styles.itemCard,
                  { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
                ]}
              >
                <View style={styles.itemHeader}>
                  <MIcon name="file-document" size={22} color={palette.accent} />
                  <Text style={[styles.itemTitle, { color: palette.text }]}>
                    {item.concepto}
                  </Text>
                </View>

                <Text style={[styles.linea, { color: palette.softText }]}>
                  <MIcon name="calendar-start" size={14} color={palette.softText} /> Inicio: {fmtDate(item.fechaInicio)}
                </Text>
                <Text style={[styles.linea, { color: palette.softText }]}>
                  <MIcon name="calendar-end" size={14} color={palette.softText} /> Cierre: {fmtDate(item.fechaCierre)}
                </Text>

                <View style={styles.kpiRow}>
                  <View
                    style={[
                      styles.kpiBox,
                      { backgroundColor: palette.kpiBg, borderColor: palette.cardBorder, borderWidth: 1 },
                    ]}
                  >
                    <Text style={[styles.kpiLabel, { color: palette.softText }]}>Neto</Text>
                    <Text style={[styles.kpiValue, { color: palette.text }]}>
                      R$ {item.valorNeto.toFixed(2)}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.kpiBox,
                      { backgroundColor: palette.kpiBg, borderColor: palette.cardBorder, borderWidth: 1 },
                    ]}
                  >
                    <Text style={[styles.kpiLabel, { color: palette.softText }]}>Total</Text>
                    <Text style={[styles.kpiValue, { color: palette.text }]}>
                      R$ {item.totalPrestamo.toFixed(2)}
                    </Text>
                  </View>
                </View>

                {!!item.finalizadoPor && (
                  <Text style={[styles.finalizadoPor, { color: palette.softText }]}>
                    Finalizado por: {item.finalizadoPor}
                  </Text>
                )}
              </View>
            </TouchableOpacity>
          )}
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
  subtitulo: {
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 12,
    fontSize: 13,
  },

  itemCard: {
    borderRadius: 12,
    padding: 14,
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  itemHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  itemTitle: { fontSize: 16, fontWeight: '800' },

  linea: { fontSize: 13, marginTop: 2 },

  kpiRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  kpiBox: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  kpiLabel: { fontSize: 11, fontWeight: '700' },
  kpiValue: { fontSize: 14, fontWeight: '800', marginTop: 2 },

  finalizadoPor: { fontSize: 12, marginTop: 10, fontStyle: 'italic' },
});
