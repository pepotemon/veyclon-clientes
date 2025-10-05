// screens/DetalleCuotasScreen.tsx
import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { Ionicons } from '@expo/vector-icons';
import { MaterialCommunityIcons as MIcon } from '@expo/vector-icons';
import { useAppTheme } from '../theme/ThemeProvider';

type Props = NativeStackScreenProps<RootStackParamList, 'DetalleCuotas'>;

export default function DetalleCuotasScreen({ route, navigation }: Props) {
  const { abonos, valorCuota, totalPrestamo, nombreCliente } = route.params;
  const { palette } = useAppTheme();

  const totalAbonado = useMemo(
    () => abonos.reduce((sum, abono) => sum + abono.monto, 0),
    [abonos]
  );

  const cuotasPagadas = Math.floor(totalAbonado / valorCuota);
  const sobrante = totalAbonado % valorCuota;
  const faltante = sobrante > 0 ? valorCuota - sobrante : 0;

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
        <Text style={[styles.headerTitle, { color: palette.text }]}>Detalle de cuotas</Text>
        <View style={styles.headerBtn} />
      </View>

      {/* Cliente */}
      <View
        style={[
          styles.card,
          { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
        ]}
      >
        <MIcon name="account" size={28} color={palette.accent} />
        <View style={{ marginLeft: 10 }}>
          <Text style={[styles.clientName, { color: palette.text }]}>{nombreCliente}</Text>
        </View>
      </View>

      {/* KPIs */}
      <View style={styles.kpiRow}>
        <View
          style={[
            styles.kpiBox,
            { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
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
            { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
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
            { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
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
            { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
          ]}
        >
          <Text style={[styles.kpiLabel, { color: palette.softText }]}>Cuotas completas</Text>
          <Text style={[styles.kpiValue, { color: palette.accent }]}>{cuotasPagadas}</Text>
        </View>
      </View>

      {/* Extra */}
      <View
        style={[
          styles.infoBox,
          { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
        ]}
      >
        <Text style={[styles.infoText, { color: palette.text }]}>
          Monto adicional abonado:{' '}
          <Text style={styles.bold}>R$ {sobrante.toFixed(2)}</Text>
        </Text>

        {sobrante > 0 && (
          <Text style={[styles.alertText, { color: palette.accent }]}>
            Faltan <Text style={styles.bold}>R$ {faltante.toFixed(2)}</Text> para completar la cuota #
            {cuotasPagadas + 1}
          </Text>
        )}
      </View>

      {/* Botón */}
      <TouchableOpacity
        onPress={() => navigation.goBack()}
        style={[styles.mainBtn, { backgroundColor: palette.accent }]}
        activeOpacity={0.9}
      >
        <Text style={styles.mainBtnTxt}>Volver</Text>
      </TouchableOpacity>
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
    borderWidth: 1,
  },
  clientName: { fontSize: 16, fontWeight: '800' },

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
    borderWidth: 1,
  },
  kpiLabel: { fontSize: 12, fontWeight: '700' },
  kpiValue: { fontSize: 16, fontWeight: '800', marginTop: 2 },

  infoBox: {
    margin: 12,
    borderRadius: 12,
    padding: 16,
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 },
    borderWidth: 1,
  },
  infoText: { fontSize: 14, marginBottom: 6 },
  alertText: { fontSize: 14, fontWeight: '700' },
  bold: { fontWeight: '900' },

  mainBtn: {
    marginTop: 20,
    marginHorizontal: 40,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  mainBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },
});
