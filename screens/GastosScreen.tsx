// screens/GastosScreen.tsx
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, FlatList, Alert,
  SafeAreaView, ActivityIndicator, KeyboardAvoidingView, Platform, Keyboard,
  TouchableWithoutFeedback,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { useAppTheme } from '../theme/ThemeProvider';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { db } from '../firebase/firebaseConfig';
import { addDoc, collection, onSnapshot, query, where, serverTimestamp } from 'firebase/firestore';
import { todayInTZ, pickTZ } from '../utils/timezone';
import { logAudit } from '../utils/auditLogs';

type Props = NativeStackScreenProps<RootStackParamList, 'Gastos'>;

type MovimientoGasto = {
  id?: string;
  admin: string;
  tz: string;
  operationalDate: string; // YYYY-MM-DD
  createdAt?: { seconds?: number };
  createdAtMs?: number;
  // 👇 lectura tolera antiguo y nuevo; escritura usa SIEMPRE el canónico 'gasto_cobrador'
  tipo: 'gasto_cobrador' | 'gastoCobrador';
  categoria: string;
  monto: number;
  nota?: string | null;
};

export default function GastosScreen({ route }: Props) {
  const { admin } = route.params;
  const { palette, isDark } = useAppTheme();
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState<'lista' | 'nuevo'>('lista');

  // ------- LISTA “Gastos del cobrador hoy” (en cajaDiaria) -------
  const tz = useMemo(() => pickTZ(), []);
  const hoy = useMemo(() => todayInTZ(tz), [tz]);

  const [cargando, setCargando] = useState(true);
  const [gastos, setGastos] = useState<MovimientoGasto[]>([]);

  useEffect(() => {
    if (!admin) return;
    setCargando(true);

    // ✅ Compatibilidad: aceptamos ambos tipos (viejo y canónico)
    const ref = collection(db, 'cajaDiaria');
    const qy = query(
      ref,
      where('admin', '==', admin),
      where('operationalDate', '==', hoy),
      where('tipo', 'in', ['gasto_cobrador', 'gastoCobrador']),
    );

    const unsub = onSnapshot(
      qy,
      (snap) => {
        const arr: MovimientoGasto[] = [];
        snap.forEach((d) => arr.push({ id: d.id, ...(d.data() as any) }));
        // Orden descendente por createdAtMs / createdAt
        arr.sort(
          (a, b) =>
            (b.createdAtMs ?? b.createdAt?.seconds ?? 0) -
            (a.createdAtMs ?? a.createdAt?.seconds ?? 0)
        );
        setGastos(arr);
        setCargando(false);
      },
      (err) => {
        console.error(err);
        setCargando(false);
      }
    );
    return () => unsub();
  }, [admin, hoy]);

  const total = useMemo(
    () => gastos.reduce((acc, g) => acc + Number(g.monto || 0), 0),
    [gastos]
  );

  // ------- NUEVO GASTO (guardar en cajaDiaria como gasto_cobrador) -------
  const [categoria, setCategoria] = useState('');
  const [monto, setMonto] = useState('');
  const [nota, setNota] = useState('');
  const [enviando, setEnviando] = useState(false);

  const guardar = useCallback(async () => {
    const m = Number((monto || '').replace(',', '.'));
    if (!categoria.trim()) return Alert.alert('Falta categoría', 'Escribe el tipo de gasto.');
    if (!isFinite(m) || m <= 0) return Alert.alert('Monto inválido', 'Ingresa un monto válido.');

    try {
      setEnviando(true);

      const tzNow = pickTZ();
      const operationalDateNow = todayInTZ(tzNow);

      const payload: MovimientoGasto = {
        admin,
        tz: tzNow,
        operationalDate: operationalDateNow,
        createdAt: undefined,         // lo setea serverTimestamp abajo
        createdAtMs: Date.now(),
        // ✅ canónico fase 2
        tipo: 'gasto_cobrador',
        categoria: categoria.trim(),
        monto: Math.round(m * 100) / 100,
        nota: nota.trim() ? nota.trim() : null,
      };

      const ref = await addDoc(collection(db, 'cajaDiaria'), {
        ...payload,
        createdAt: serverTimestamp(),
        source: 'cobrador',
      });

      await logAudit({
        userId: admin,
        action: 'caja_gasto',
        ref,
        after: {
          tipo: payload.tipo,
          categoria: payload.categoria,
          monto: payload.monto,
          nota: payload.nota ?? null,
          operationalDate: payload.operationalDate,
          tz: payload.tz,
          admin: payload.admin,
          source: 'cobrador',
        },
      });

      setCategoria('');
      setMonto('');
      setNota('');
      setTab('lista');
      Alert.alert('✔️ Guardado', 'Gasto registrado.');
    } catch (e) {
      console.error(e);
      Alert.alert('❌ Error', 'No se pudo guardar el gasto.');
    } finally {
      setEnviando(false);
    }
  }, [admin, categoria, monto, nota]);

  // ------- UI -------
  const renderItem = ({ item }: { item: MovimientoGasto }) => (
    <View
      style={[
        styles.row,
        { borderColor: palette.cardBorder, backgroundColor: palette.cardBg },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowTitle, { color: palette.text }]} numberOfLines={1}>
          {item.categoria}
        </Text>
        {item.nota ? (
          <Text style={[styles.rowNote, { color: palette.softText }]} numberOfLines={2}>
            {item.nota}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.rowMoney, { color: palette.text }]}>
        R$ {Number(item.monto || 0).toFixed(2)}
      </Text>
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg }}>
      {/* Header simple */}
      <View
        style={[
          styles.header,
          { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder },
        ]}
      >
        <Text style={[styles.headerTxt, { color: palette.text }]}>Gastos</Text>
      </View>

      {/* Tabs */}
      <View
        style={[
          styles.tabs,
          { backgroundColor: palette.commBg, borderBottomColor: palette.commBorder },
        ]}
      >
        <TabBtn label="Gastos de hoy" active={tab === 'lista'} onPress={() => setTab('lista')} palette={palette} />
        <TabBtn label="Nuevo gasto" active={tab === 'nuevo'} onPress={() => setTab('nuevo')} palette={palette} />
      </View>

      {/* Contenido */}
      {tab === 'lista' ? (
        <>
          {cargando ? (
            <ActivityIndicator style={{ marginTop: 20 }} />
          ) : (
            <FlatList
              data={gastos}
              keyExtractor={(g, i) => g.id ?? String(i)}
              renderItem={renderItem}
              ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
              contentContainerStyle={{ padding: 12, paddingBottom: 120 + insets.bottom }}
              ListFooterComponent={
                <View
                  style={[
                    styles.totalBox,
                    { backgroundColor: isDark ? '#1f1f1f' : '#f2f6ff', borderColor: palette.cardBorder },
                  ]}
                >
                  <Text style={[styles.totalLbl, { color: palette.softText }]}>Total de hoy</Text>
                  <Text style={[styles.totalMoney, { color: palette.text }]}>R$ {total.toFixed(2)}</Text>
                </View>
              }
              ListEmptyComponent={
                <View style={{ alignItems: 'center', marginTop: 20 }}>
                  <Text style={{ color: palette.softText }}>Sin gastos registrados hoy.</Text>
                </View>
              }
            />
          )}
        </>
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={80}
        >
          <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
            <View style={{ flex: 1, padding: 12 }}>
              <Text style={[styles.label, { color: palette.softText }]}>Categoría</Text>
              <TextInput
                value={categoria}
                onChangeText={setCategoria}
                placeholder="Ej: Comisión, Transporte…"
                placeholderTextColor={palette.softText}
                style={[
                  styles.input,
                  { color: palette.text, backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
                ]}
                autoCapitalize="sentences"
              />

              <Text style={[styles.label, { color: palette.softText }]}>Monto</Text>
              <TextInput
                value={monto}
                onChangeText={setMonto}
                keyboardType="decimal-pad"
                placeholder="0,00"
                placeholderTextColor={palette.softText}
                style={[
                  styles.input,
                  { color: palette.text, backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
                ]}
              />

              <Text style={[styles.label, { color: palette.softText }]}>Nota (opcional)</Text>
              <TextInput
                value={nota}
                onChangeText={setNota}
                placeholder="Detalle breve"
                placeholderTextColor={palette.softText}
                style={[
                  styles.input,
                  styles.textarea,
                  { color: palette.text, backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
                ]}
                multiline
              />
            </View>
          </TouchableWithoutFeedback>

          {/* CTA flotante despegado del home-indicator */}
          <View
            style={[
              styles.ctaBar,
              { backgroundColor: palette.topBg, borderTopColor: palette.topBorder, bottom: insets.bottom },
            ]}
          >
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: palette.accent, opacity: enviando ? 0.7 : 1 }]}
              activeOpacity={0.9}
              disabled={enviando}
              onPress={guardar}
            >
              <Text style={styles.btnTxt}>{enviando ? 'Guardando…' : 'Guardar gasto'}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
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
      onPress={onPress}
      activeOpacity={0.85}
      style={[styles.tabBtn, active && { borderBottomColor: palette.accent, borderBottomWidth: 3 }]}
    >
      <Text style={[styles.tabTxt, { color: active ? palette.accent : palette.text }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  header: { borderBottomWidth: 1, paddingVertical: 8, alignItems: 'center' },
  headerTxt: { fontSize: 16, fontWeight: '800' },

  tabs: { flexDirection: 'row', borderBottomWidth: 1 },
  tabBtn: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  tabTxt: { fontSize: 13, fontWeight: '800' },

  row: {
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowTitle: { fontSize: 14, fontWeight: '800' },
  rowNote: { fontSize: 12, marginTop: 2 },
  rowMoney: { fontSize: 15, fontWeight: '800', marginLeft: 10 },

  totalBox: { marginTop: 12, padding: 12, borderRadius: 10, borderWidth: 1, alignItems: 'center' },
  totalLbl: { fontSize: 12, fontWeight: '700' },
  totalMoney: { fontSize: 18, fontWeight: '900', marginTop: 2 },

  // Nuevo gasto
  label: { fontSize: 12, fontWeight: '700', marginBottom: 6, marginTop: 8 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
  textarea: { height: 88, textAlignVertical: 'top' },

  ctaBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderTopWidth: 1,
    padding: 12,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: -2 },
  },
  btn: { paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  btnTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },
});
