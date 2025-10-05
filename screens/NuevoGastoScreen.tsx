// screens/NuevoGastoScreen.tsx
import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { useAppTheme } from '../theme/ThemeProvider';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { db } from '../firebase/firebaseConfig';
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { todayInTZ, pickTZ } from '../utils/timezone';
import { logAudit } from '../utils/auditLogs';

type Props = NativeStackScreenProps<RootStackParamList, 'NuevoGasto'>;

const CATEGORIAS = ['Transporte', 'Comisión', 'Comida', 'Suministros', 'Otro'] as const;
type CategoriaGasto = typeof CATEGORIAS[number];

export default function NuevoGastoScreen({ route, navigation }: Props) {
  const admin = route.params.admin;
  const tzSession = 'America/Sao_Paulo';

  const { palette } = useAppTheme();
  const insets = useSafeAreaInsets();

  const [monto, setMonto] = useState('');
  const [categoria, setCategoria] = useState<CategoriaGasto>('Transporte');
  const [nota, setNota] = useState('');
  const [guardando, setGuardando] = useState(false);

  const hoy = useMemo(() => todayInTZ(pickTZ(tzSession, tzSession)), [tzSession]);

  const guardar = async () => {
    const num = Number((monto || '').replace(',', '.'));
    if (!isFinite(num) || num <= 0) {
      Alert.alert('Monto inválido', 'Ingresa un monto mayor a 0.');
      return;
    }
    try {
      setGuardando(true);

      const payload = {
        // ✅ tipo canónico para Fase 2 (coincide con movimientoHelper / consultas)
        tipo: 'gasto_admin' as const,
        admin,
        categoria,
        monto: Math.round(num * 100) / 100,
        operationalDate: hoy,
        tz: tzSession,
        nota: nota.trim() ? nota.trim() : null,
        createdAt: serverTimestamp(),
        createdAtMs: Date.now(),
        source: 'manual' as const,
      };

      const ref = await addDoc(collection(db, 'cajaDiaria'), payload);

      // Auditoría
      await logAudit({
        userId: admin,
        action: 'caja_gasto_admin',
        ref,
        after: {
          tipo: payload.tipo,
          categoria: payload.categoria,
          monto: payload.monto,
          nota: payload.nota ?? null,
          operationalDate: payload.operationalDate,
          tz: payload.tz,
          admin: payload.admin,
          source: payload.source,
        },
      });

      Alert.alert('Listo', 'Gasto registrado.');
      navigation.goBack();
    } catch (e) {
      console.error('Error guardando gasto:', e);
      Alert.alert('Error', 'No se pudo guardar el gasto.');
    } finally {
      setGuardando(false);
    }
  };

  return (
      <SafeAreaView
    style={{ flex: 1, backgroundColor: palette.screenBg }}
    edges={['left','right','bottom']}   // 👈 evita el hueco
  >
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* Header */}
        <View style={[styles.header, { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder }]}>
          <Text style={[styles.headerTxt, { color: palette.text }]}>Nuevo Gasto</Text>
        </View>

        <View style={{ flex: 1, padding: 12, gap: 8 }}>
          {/* Monto */}
          <Text style={[styles.label, { color: palette.softText }]}>Monto</Text>
          <TextInput
            value={monto}
            onChangeText={setMonto}
            keyboardType="decimal-pad"
            placeholder="0,00"
            placeholderTextColor={palette.softText}
            style={[
              styles.input,
              { color: palette.text, borderColor: palette.cardBorder, backgroundColor: palette.cardBg },
            ]}
          />

          {/* Categoría */}
          <Text style={[styles.label, { color: palette.softText, marginTop: 4 }]}>Categoría</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {CATEGORIAS.map((c) => {
              const active = c === categoria;
              return (
                <TouchableOpacity
                  key={c}
                  onPress={() => setCategoria(c)}
                  activeOpacity={0.9}
                  style={[
                    styles.pill,
                    {
                      backgroundColor: active ? palette.topBg : palette.kpiTrack,
                      borderColor: active ? palette.accent : palette.cardBorder,
                    },
                  ]}
                >
                  <Text style={[styles.pillTxt, { color: active ? palette.accent : palette.softText }]}>{c}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Nota */}
          <Text style={[styles.label, { color: palette.softText, marginTop: 4 }]}>Nota (opcional)</Text>
          <TextInput
            value={nota}
            onChangeText={setNota}
            placeholder="Detalle corto"
            placeholderTextColor={palette.softText}
            style={[
              styles.input,
              { color: palette.text, borderColor: palette.cardBorder, backgroundColor: palette.cardBg, height: 70 },
            ]}
            multiline
          />

          <View style={{ flex: 1 }} />

          {/* Botón */}
          <View
            style={[
              styles.ctaBar,
              {
                backgroundColor: palette.topBg,
                borderTopColor: palette.topBorder,
                paddingBottom: Math.max(10, insets.bottom),
              },
            ]}
          >
            <TouchableOpacity
              onPress={guardar}
              disabled={guardando}
              activeOpacity={0.92}
              style={[styles.btn, { backgroundColor: palette.accent, opacity: guardando ? 0.6 : 1 }]}
            >
              <Text style={styles.btnTxt}>{guardando ? 'Guardando…' : 'Guardar gasto'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { paddingVertical: 8, alignItems: 'center', borderBottomWidth: 1 },
  headerTxt: { fontSize: 14, fontWeight: '800', opacity: 0.9 },

  label: { fontSize: 11, fontWeight: '700' },

  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 14,
  },

  pill: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
  },
  pillTxt: { fontSize: 12, fontWeight: '700' },

  ctaBar: {
    borderTopWidth: 1,
    paddingTop: 10,
  },
  btn: { paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
  btnTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
