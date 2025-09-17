// screens/DefinirCajaScreen.tsx
import React, { useMemo, useState } from 'react';
import {
  SafeAreaView, View, Text, StyleSheet, TouchableOpacity, TextInput,
  Alert, KeyboardAvoidingView, Platform
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { useAppTheme } from '../theme/ThemeProvider';
import { setCajaInicial } from '../utils/cajaManual';
import { setSaldoActual } from '../utils/cajaEstado';
import { pickTZ, todayInTZ } from '../utils/timezone';

type Props = NativeStackScreenProps<RootStackParamList, 'DefinirCaja'>;

const DISPLAY_LOCALE = 'es-AR';
const MIN_APERTURA = 0.01;

function parseMoney(input: string): number {
  if (!input) return NaN;
  // admitir "3400", "3.400,50", "3400,50", "3400.50"
  const s = input.trim()
    .replace(/\s/g, '')
    .replace(/\./g, '')        // quita separadores de miles
    .replace(',', '.');        // coma -> punto decimal
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export default function DefinirCajaScreen({ route, navigation }: Props) {
  const { admin } = route.params;
  const { palette } = useAppTheme();

  // Info inicial solo para mostrar en UI; el cálculo real se hace al guardar
  const tzUI = useMemo(() => pickTZ(undefined, 'America/Sao_Paulo'), []);
  const opDateUI = useMemo(() => todayInTZ(tzUI), [tzUI]);

  const [montoStr, setMontoStr] = useState('');
  const [nota, setNota] = useState('');

  const montoNum = useMemo(() => parseMoney(montoStr), [montoStr]);
  const disabled = !(Number.isFinite(montoNum) && montoNum >= MIN_APERTURA);

  const onApertura = async () => {
    try {
      if (disabled) {
        Alert.alert('Monto inválido', `Ingresa un valor mayor o igual a R$ ${MIN_APERTURA.toFixed(2)}.`);
        return;
      }

      // Redondeo seguro a 2 decimales (evita -0.00)
      const val = Math.abs(montoNum) < 0.005 ? 0 : Math.round(montoNum * 100) / 100;
      if (val < MIN_APERTURA) {
        Alert.alert('Monto muy pequeño', `El valor debe ser al menos R$ ${MIN_APERTURA.toFixed(2)}.`);
        return;
      }

      // Recalcular TZ y fecha operativa justo al guardar (evita desfasajes al pasar de día)
      const tzNow = pickTZ();
      const opDateNow = todayInTZ(tzNow);
      const notaTrim = nota.trim() || undefined;

      // 1) asiento del día (visibilidad en reportes del día)
      await setCajaInicial(admin, val, opDateNow, tzNow, notaTrim);

      // 2) saldo persistente (Caja Inicial acumulada que arrastra al siguiente día)
      await setSaldoActual(admin, val, tzNow);

      Alert.alert('Listo', `Caja inicial registrada por ${val.toLocaleString(DISPLAY_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} y saldo persistente actualizado.`);
      navigation.goBack();
    } catch (e: any) {
      console.warn('[DefinirCaja] onApertura error:', e?.message || e);
      Alert.alert('Error', 'No se pudo registrar la apertura de caja.');
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={[styles.container, { padding: 16 }]}>
          <Text style={[styles.title, { color: palette.text }]}>Definir caja</Text>
          <Text style={{ color: palette.softText, marginBottom: 16 }}>
            Fecha operativa: {opDateUI} • Zona horaria: {tzUI}
          </Text>

          <View style={[styles.card, { backgroundColor: palette.cardBg, borderColor: palette.cardBorder }]}>
            <Text style={[styles.label, { color: palette.text }]}>Monto</Text>
            <TextInput
              keyboardType="decimal-pad"
              placeholder="0,00"
              value={montoStr}
              onChangeText={setMontoStr}
              style={[styles.input, { color: palette.text, borderColor: palette.cardBorder }]}
              placeholderTextColor={palette.softText}
            />

            <Text style={[styles.label, { color: palette.text, marginTop: 12 }]}>Nota (opcional)</Text>
            <TextInput
              placeholder="Detalle breve"
              value={nota}
              onChangeText={setNota}
              style={[styles.input, { color: palette.text, borderColor: palette.cardBorder }]}
              placeholderTextColor={palette.softText}
            />

            <View style={styles.btnRow}>
              <ActionBtn label="Apertura" onPress={onApertura} disabled={disabled} color={palette.accent} />
            </View>
          </View>

          <Text style={{ color: palette.softText, marginTop: 10, fontSize: 12 }}>
            • La apertura fija la caja inicial del día y el saldo persistente de la caja.
          </Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ActionBtn({ label, onPress, disabled, color }: { label: string; onPress: () => void; disabled?: boolean; color: string }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.9}
      disabled={disabled}
      style={[styles.actionBtn, { backgroundColor: color, opacity: disabled ? 0.5 : 1 }]}
    >
      <Text style={styles.actionTxt}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  title: { fontSize: 18, fontWeight: '800', marginBottom: 4, textAlign: 'center' },
  card: { borderRadius: 12, borderWidth: 1, padding: 12 },
  label: { fontSize: 12, fontWeight: '700', marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, fontSize: 16 },
  btnRow: { flexDirection: 'row', gap: 8, marginTop: 14, justifyContent: 'space-between' },
  actionBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  actionTxt: { color: '#fff', fontWeight: '800' },
});
