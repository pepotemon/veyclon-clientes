// screens/HistorialPagosScreen.tsx
import React, { useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Platform,
} from 'react-native';
import { format } from 'date-fns';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { Ionicons } from '@expo/vector-icons';
import { MaterialCommunityIcons as MIcon } from '@expo/vector-icons';
import { useAppTheme } from '../theme/ThemeProvider';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Props = NativeStackScreenProps<RootStackParamList, 'HistorialPagos'>;

export default function HistorialPagosScreen({ route, navigation }: Props) {
  const { abonos, nombreCliente, valorCuota, totalPrestamo } = route.params;
  const { palette } = useAppTheme();
  const insets = useSafeAreaInsets();

  const abonosOrdenados = useMemo(
    () =>
      [...abonos].sort(
        (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime()
      ),
    [abonos]
  );

  const totalAbonado = useMemo(
    () => abonos.reduce((acc, abono) => acc + Number(abono.monto || 0), 0),
    [abonos]
  );

  const cuotasPagadas = useMemo(
    () => (valorCuota > 0 ? Math.floor(totalAbonado / valorCuota) : 0),
    [totalAbonado, valorCuota]
  );

  const pagosRealizados = abonos.length;

  const saldoEstimado = useMemo(
    () => Math.max((Number(totalPrestamo) || 0) - totalAbonado, 0),
    [totalPrestamo, totalAbonado]
  );

  const isToday = (isoOrDateLike: string) => {
    const d = new Date(isoOrDateLike);
    const today = new Date();
    return d.toDateString() === today.toDateString();
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg }}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder },
        ]}
      >
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={22} color={palette.accent} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: palette.text }]}>Historial de pagos</Text>
        <View style={styles.headerBtn} />
      </View>

      {/* Encabezado del cliente */}
      <View
        style={[
          styles.clientCard,
          { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
        ]}
      >
        <MIcon name="account" size={24} color={palette.accent} />
        <View style={{ marginLeft: 8, flex: 1 }}>
          <Text style={[styles.clientName, { color: palette.text }]} numberOfLines={1}>
            {nombreCliente}
          </Text>
          <Text style={[styles.clientSub, { color: palette.softText }]}>
            Cuota: R$ {Number(valorCuota || 0).toFixed(2)} · Total préstamo: R$ {Number(totalPrestamo || 0).toFixed(2)}
          </Text>
        </View>
      </View>

      {/* KPIs */}
      <View style={styles.kpiRow}>
        {/* Total abonado */}
        <View
          style={[
            styles.kpiBox,
            { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
          ]}
        >
          <Text style={[styles.kpiLabel, { color: palette.softText }]}>Total abonado</Text>
          <Text style={[styles.kpiValue, { color: palette.text }]}>R$ {totalAbonado.toFixed(2)}</Text>
        </View>

        {/* Cuotas pagadas + Pagos realizados (mini-dúo) */}
        <View
          style={[
            styles.kpiBox,
            { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
          ]}
        >
          <View style={styles.kpiDuoRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.kpiMiniLabel, { color: palette.softText }]}>Cuotas realiz.</Text>
              <Text style={[styles.kpiMiniValue, { color: palette.text }]}>{cuotasPagadas}</Text>
            </View>
            <View style={styles.kpiDuoDivider} />
            <View style={{ flex: 1, alignItems: 'flex-end' }}>
              <Text style={[styles.kpiMiniLabel, { color: palette.softText }]}>Pagos realiz.</Text>
              <Text style={[styles.kpiMiniValue, { color: palette.text }]}>{pagosRealizados}</Text>
            </View>
          </View>
        </View>

        {/* Saldo estimado */}
        <View
          style={[
            styles.kpiBox,
            { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
          ]}
        >
          <Text style={[styles.kpiLabel, { color: palette.softText }]}>Saldo estimado</Text>
          <Text
            style={[
              styles.kpiValue,
              { color: saldoEstimado === 0 ? palette.accent : palette.text },
            ]}
          >
            R$ {saldoEstimado.toFixed(2)}
          </Text>
        </View>
      </View>

      {/* Botón a detalle de cuotas */}
      <TouchableOpacity
        onPress={() =>
          navigation.navigate('DetalleCuotas', { abonos, valorCuota, totalPrestamo, nombreCliente })
        }
        style={[styles.detailBtn, { backgroundColor: palette.accent }]}
        activeOpacity={0.9}
      >
        <MIcon name="chart-areaspline" size={16} color="#fff" style={{ marginRight: 6 }} />
        <Text style={styles.detailBtnTxt}>Ver detalle de cuotas</Text>
      </TouchableOpacity>

      {/* Lista de abonos (compacta + respeta home-indicator) */}
      <FlatList
        data={abonosOrdenados}
        keyExtractor={(_, index) => index.toString()}
        contentContainerStyle={{
          paddingHorizontal: 12,
          paddingTop: 8,
          paddingBottom: insets.bottom + 16, // evita que el último item se esconda
        }}
        scrollIndicatorInsets={{ bottom: insets.bottom }}
        ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
        renderItem={({ item }) => {
          const fecha = new Date(item.fecha);
          const hoy = isToday(item.fecha);
          return (
            <View
              style={[
                styles.itemCard,
                {
                  backgroundColor: palette.cardBg,
                  borderColor: palette.cardBorder,
                  borderWidth: StyleSheet.hairlineWidth,
                },
                hoy && {
                  borderLeftWidth: 3,
                  borderLeftColor: palette.accent,
                  backgroundColor: Platform.OS === 'ios' ? palette.topBg : palette.cardBg,
                },
              ]}
            >
              <View style={styles.itemLeftIcon}>
                <MIcon name="cash-multiple" size={18} color={hoy ? palette.accent : palette.softText} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.itemMonto, { color: palette.text }]}>
                  R$ {Number(item.monto || 0).toFixed(2)}
                </Text>
                <View style={styles.itemMetaRow}>
                  <MIcon name="calendar" size={12} color={palette.softText} />
                  <Text style={[styles.itemFecha, { color: palette.softText }]}>
                    {format(fecha, 'dd/MM/yyyy HH:mm')}
                  </Text>
                  {hoy && (
                    <Text
                      style={[
                        styles.badgeHoy,
                        {
                          backgroundColor: palette.topBg,
                          color: palette.accent,
                          borderColor: palette.topBorder,
                        },
                      ]}
                    >
                      HOY
                    </Text>
                  )}
                </View>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={{ alignItems: 'center', marginTop: 20 }}>
            <Text style={{ color: palette.softText }}>Aún no hay pagos registrados.</Text>
          </View>
        }
      />
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

  clientCard: {
    marginHorizontal: 12,
    marginTop: 10,
    marginBottom: 8,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  clientName: { fontSize: 15, fontWeight: '800' },
  clientSub: { fontSize: 11, marginTop: 2 },

  kpiRow: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
    marginBottom: 6,
  },
  kpiBox: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  kpiLabel: { fontSize: 10.5, fontWeight: '700' },
  kpiValue: { fontSize: 15, fontWeight: '800', marginTop: 1 },

  // mini-dúo dentro de la caja central
  kpiDuoRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  kpiMiniLabel: {
    fontSize: 10,
    fontWeight: '700',
    marginBottom: 2,
  },
  kpiMiniValue: {
    fontSize: 14.5,
    fontWeight: '800',
    lineHeight: 16,
  },
  kpiDuoDivider: {
    width: 1,
    alignSelf: 'stretch',
    marginHorizontal: 8,
    backgroundColor: 'rgba(0,0,0,0.06)',
  },

  detailBtn: {
    marginHorizontal: 12,
    marginTop: 4,
    marginBottom: 4,
    paddingVertical: 10,
    borderRadius: 9,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
  },
  detailBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 13.5 },

  // Ítems compactos
  itemCard: {
    borderRadius: 9,
    paddingVertical: 8,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  itemLeftIcon: { width: 24, alignItems: 'center' },
  itemMonto: { fontSize: 14.5, fontWeight: '800' },
  itemMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  itemFecha: { fontSize: 11 },

  badgeHoy: {
    marginLeft: 6,
    fontSize: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    fontWeight: '900',
  },
});
