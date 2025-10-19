// screens/DefinirCajaScreen.tsx
import React, { useMemo, useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  Alert, KeyboardAvoidingView, Platform, ActivityIndicator
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { useAppTheme } from '../theme/ThemeProvider';

import { db } from '../firebase/firebaseConfig';
import { setDoc, doc, getDoc, serverTimestamp } from 'firebase/firestore';

import { pickTZ, todayInTZ } from '../utils/timezone';
import { logAudit, pick } from '../utils/auditLogs';
// 🔐 scoping
import { getAuthCtx } from '../utils/authCtx';

type Props = NativeStackScreenProps<RootStackParamList, 'DefinirCaja'>;

const DISPLAY_LOCALE = 'es-AR';
const MIN_APERTURA = 0.01;

function parseMoney(input: string): number {
  if (!input) return NaN;
  // admitir "3400", "3.400,50", "3400,50", "3400.50"
  const s = input.trim()
    .replace(/\s/g, '')
    .replace(/\./g, '')        // separador de miles
    .replace(',', '.');        // coma -> punto decimal
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export default function DefinirCajaScreen({ navigation }: Props) {
  const { palette } = useAppTheme();

  // 🔐 cargar contexto auth (incluye admin real)
  const [ctx, setCtx] = useState<{
    admin: string | null;
    tenantId: string | null;
    role: 'collector' | 'admin' | 'superadmin' | null;
    rutaId: string | null;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const c = await getAuthCtx();
      if (!alive) return;
      setCtx({
        admin: c?.admin ?? null,
        tenantId: c?.tenantId ?? null,
        role: (c?.role as any) ?? null,
        rutaId: c?.rutaId ?? null,
      });
    })();
    return () => { alive = false; };
  }, []);

  const authAdminId = ctx?.admin ?? null;

  // Info para UI; el payload toma TZ/fecha en el momento de guardar
  const tzUI = useMemo(() => pickTZ(undefined, 'America/Sao_Paulo'), []);
  const opDateUI = useMemo(() => todayInTZ(tzUI), [tzUI]);

  const [montoStr, setMontoStr] = useState('');
  const [nota, setNota] = useState('');

  const montoNum = useMemo(() => parseMoney(montoStr), [montoStr]);
  const disabled = !(Number.isFinite(montoNum) && montoNum >= MIN_APERTURA);

  const onApertura = async () => {
    try {
      if (!authAdminId) {
        Alert.alert('Sesión', 'No se pudo identificar el usuario (admin). Intenta nuevamente.');
        return;
      }

      if (disabled) {
        Alert.alert('Monto inválido', `Ingresa un valor ≥ R$ ${MIN_APERTURA.toFixed(2)}.`);
        return;
      }

      // Redondeo seguro a 2 decimales (evita -0.00)
      const val = Math.abs(montoNum) < 0.005 ? 0 : Math.round(montoNum * 100) / 100;
      if (val < MIN_APERTURA) {
        Alert.alert('Monto muy pequeño', `El valor debe ser al menos R$ ${MIN_APERTURA.toFixed(2)}.`);
        return;
      }

      // Recalcular TZ/fecha con la MISMA TZ que usan las pantallas
      const tzNow = pickTZ(undefined, 'America/Sao_Paulo');
      const opDateNow = todayInTZ(tzNow);
      const notaTrim = (nota || '').trim() || null;

      // ✅ doc idempotente: evita duplicados si se toca varias veces
      const aperturaId = `apertura_${authAdminId}_${opDateNow}`;
      const aperturaRef = doc(db, 'cajaDiaria', aperturaId);

      // Si ya existe, avisamos y salimos
      const exists = await getDoc(aperturaRef);
      if (exists.exists()) {
        Alert.alert('Apertura ya registrada', `Ya existe una apertura para hoy (${opDateNow}).`);
        navigation.goBack();
        return;
      }

      // APERTURA canónica en cajaDiaria (define CAJA INICIAL del día)
      const payload = {
        tipo: 'apertura' as const,
        admin: authAdminId!,                // << unificado
        monto: val,
        operationalDate: opDateNow,         // YYYY-MM-DD
        tz: tzNow,
        nota: notaTrim,
        createdAt: serverTimestamp(),
        createdAtMs: Date.now(),
        source: 'manual' as const,
        // 🔐 scoping
        tenantId: ctx?.tenantId ?? null,
        rutaId: ctx?.role === 'collector' ? ctx?.rutaId ?? null : null,
      };

      await setDoc(aperturaRef, payload, { merge: false });

      // Auditoría
      await logAudit({
        userId: authAdminId!,
        action: 'caja_apertura_manual',
        ref: aperturaRef,
        before: null,
        after: pick(payload, [
          'tipo','admin','monto','operationalDate','tz','nota','source','tenantId','rutaId'
        ]),
      });

      Alert.alert(
        'Listo',
        `Apertura registrada: R$ ${val.toLocaleString(DISPLAY_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.\nSerá la caja inicial de hoy.`
      );
      navigation.goBack();
    } catch (e: any) {
      console.warn('[DefinirCaja] onApertura error:', e?.message || e);
      Alert.alert('Error', 'No se pudo registrar la apertura de caja.');
    }
  };

  // Mientras cargamos el contexto (para tener admin real)
  if (!ctx || !authAdminId) {
    return (
      <SafeAreaView style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: palette.screenBg }}
      edges={['left','right','bottom']}   // 👈 evita el hueco
    >
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
            • La apertura fija la caja inicial de hoy. La caja final (saldo) se actualizará con tus movimientos y cierre.
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
