// screens/CajaDiariaScreen.tsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  FlatList,
  TouchableOpacity,
  Alert,
  Modal,
  TextInput,
  Platform,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { useAppTheme } from '../theme/ThemeProvider';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { db } from '../firebase/firebaseConfig';
import {
  addDoc,
  serverTimestamp,
  query,
  where,
  collection,
  onSnapshot,
  getDocs,
  getDoc,
  doc,
} from 'firebase/firestore';

import { todayInTZ } from '../utils/timezone';
import { logAudit, pick } from '../utils/auditLogs';
import { MaterialCommunityIcons as MIcon } from '@expo/vector-icons';

import {
  canonicalTipo,
  iconFor,
  labelFor,
  toneFor,
  type MovimientoTipo,
} from '../utils/movimientoHelper';

type Props = NativeStackScreenProps<RootStackParamList, 'CajaDiaria'>;

type MovimientoBase = {
  id: string;
  monto: number;
  nota?: string;
  operationalDate: string; // YYYY-MM-DD
  tz: string;
  admin: string;
  createdAt?: any;
  createdAtMs?: number;
};

type MovimientoCaja = MovimientoBase & {
  tipo: Extract<MovimientoTipo, 'ingreso' | 'retiro' | 'gasto_admin'>;
  categoria?: string;
};

// MISMA TZ que usamos para definir aperturas
const tz = 'America/Sao_Paulo';

export default function CajaDiariaScreen({ route, navigation }: Props) {
  const { admin } = route.params;
  const { palette, isDark } = useAppTheme();
  const insets = useSafeAreaInsets();

  const hoy = useMemo(() => todayInTZ(tz), []);

  const [cargando, setCargando] = useState(true);

  // KPIs desde cajaDiaria
  const [apertura, setApertura] = useState(0); // SOLO lectura (no seteamos caja inicial desde aquí)
  const [abonos, setAbonos] = useState(0);
  const [ingresos, setIngresos] = useState(0);
  const [retiros, setRetiros] = useState(0);
  const [prestamosDelDia, setPrestamosDelDia] = useState(0); // ✅ desde cajaDiaria (tipo:'prestamo')
  const [movsCaja, setMovsCaja] = useState<MovimientoCaja[]>([]);

  // Caja inicial base = CIERRE DE AYER (nunca se pisa desde snapshot)
  const [cajaInicialBase, setCajaInicialBase] = useState(0);

  // Total de gastos admin
  const totalGastos = useMemo(
    () =>
      movsCaja
        .filter((m) => m.tipo === 'gasto_admin')
        .reduce((acc, g) => acc + (Number(g.monto) || 0), 0),
    [movsCaja]
  );

  // Caja inicial DERIVADA: si hay apertura hoy, esa es la inicial; si no, la base
  const cajaInicial = useMemo(
    () => (apertura > 0 ? apertura : cajaInicialBase),
    [apertura, cajaInicialBase]
  );

  // Caja final (viva)
  const cajaFinal = useMemo(
    () =>
      Math.round(
        (cajaInicial + ingresos + abonos - retiros - totalGastos - prestamosDelDia) * 100
      ) / 100,
    [cajaInicial, ingresos, abonos, retiros, totalGastos, prestamosDelDia]
  );

  /** ======= MISMA LÓGICA QUE CerrarDia: caja inicial base = cierre de AYER ======= */
  async function getCajaInicialUI(adminId: string, hoyYmd: string): Promise<number> {
    // AYER a partir de 'hoy'
    const [Y, M, D] = hoyYmd.split('-').map((n) => parseInt(n, 10));
    const dt = new Date(Date.UTC(Y, M - 1, D));
    dt.setUTCDate(dt.getUTCDate() - 1);
    const ayer = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(
      2,
      '0'
    )}-${String(dt.getUTCDate()).padStart(2, '0')}`;

    // 1) Preferimos cierre idempotente
    const cierreId = `cierre_${adminId}_${ayer}`;
    const cierreSnap = await getDoc(doc(db, 'cajaDiaria', cierreId));
    if (cierreSnap.exists()) return Number(cierreSnap.data()?.balance || 0);

    // 2) Último cierre de AYER (sin orderBy para evitar índice compuesto → elegimos en cliente el más reciente)
    const qC = query(
      collection(db, 'cajaDiaria'),
      where('admin', '==', adminId),
      where('operationalDate', '==', ayer),
      where('tipo', '==', 'cierre')
    );
    const sC = await getDocs(qC);
    if (!sC.empty) {
      let bestTs = -1;
      let bestBalance = 0;
      sC.forEach((d) => {
        const data: any = d.data();
        const bal = Number(data?.balance || 0);
        const ts =
          (typeof data?.createdAtMs === 'number' && data.createdAtMs) ||
          (typeof data?.createdAt?.seconds === 'number' && data.createdAt.seconds * 1000) ||
          0;
        if (ts >= bestTs) {
          bestTs = ts;
          bestBalance = bal;
        }
      });
      return bestBalance;
    }

    // 3) Nada → 0
    return 0;
  }

  // --- Cargar CAJA INICIAL BASE = cierre de AYER
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const base = await getCajaInicialUI(admin, hoy);
        if (!cancelled) setCajaInicialBase(Number.isFinite(base) ? base : 0);
      } catch (e) {
        console.warn('[CajaDiaria] cajaInicialBase error:', e);
        if (!cancelled) setCajaInicialBase(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [admin, hoy]);

  // Snapshot de movimientos del día (todas las KPIs salen de aquí)
  useEffect(() => {
    setCargando(true);
    try {
      // ❌ Sin orderBy para evitar índices compuestos → ordenamos en cliente
      const qDia = query(
        collection(db, 'cajaDiaria'),
        where('admin', '==', admin),
        where('operationalDate', '==', hoy)
      );

      const unsub = onSnapshot(
        qDia,
        (snap) => {
          let lastAperturaMonto = 0;
          let lastAperturaTs = -1;
          let _abonos = 0;
          let _ingresos = 0;
          let _retiros = 0;
          let _prestamos = 0; // ✅ suma de capital entregado hoy

          const _movsCaja: MovimientoCaja[] = [];

          snap.forEach((d) => {
            const data = d.data() as any;
            const tip = canonicalTipo(data?.tipo);
            if (!tip) return;

          const m = Number(
  tip === 'apertura' || tip === 'cierre'
    ? (data?.monto ?? data?.balance ?? 0)  // 🟢 tomar monto o balance
    : (data?.monto ?? 0)
);

            if (!Number.isFinite(m)) return;

            const ts =
              (typeof data?.createdAtMs === 'number' && data.createdAtMs) ||
              (typeof data?.createdAt?.seconds === 'number' && data.createdAt.seconds * 1000) ||
              0;

            switch (tip) {
              case 'apertura':
                if (ts >= lastAperturaTs) {
                  lastAperturaTs = ts;
                  lastAperturaMonto = m;
                }
                break;

              case 'abono':
                _abonos += m;
                break;

              case 'ingreso':
                _ingresos += m;
                _movsCaja.push({
                  id: d.id,
                  tipo: 'ingreso',
                  monto: m,
                  nota: data?.nota || '',
                  operationalDate: data?.operationalDate,
                  tz: data?.tz || tz,
                  admin: data?.admin || admin,
                  createdAt: data?.createdAt,
                  createdAtMs:
                    typeof data?.createdAtMs === 'number' ? data.createdAtMs : undefined,
                });
                break;

              case 'retiro':
                _retiros += m;
                _movsCaja.push({
                  id: d.id,
                  tipo: 'retiro',
                  monto: m,
                  nota: data?.nota || '',
                  operationalDate: data?.operationalDate,
                  tz: data?.tz || tz,
                  admin: data?.admin || admin,
                  createdAt: data?.createdAt,
                  createdAtMs:
                    typeof data?.createdAtMs === 'number' ? data.createdAtMs : undefined,
                });
                break;

              case 'gasto_admin':
                _movsCaja.push({
                  id: d.id,
                  tipo: 'gasto_admin',
                  categoria: data?.categoria || 'Gasto admin',
                  monto: m,
                  nota: data?.nota || '',
                  operationalDate: data?.operationalDate,
                  tz: data?.tz || tz,
                  admin: data?.admin || admin,
                  createdAt: data?.createdAt,
                  createdAtMs:
                    typeof data?.createdAtMs === 'number' ? data.createdAtMs : undefined,
                });
                break;

              case 'prestamo':
                // ✅ capital entregado hoy, resta caja y va a KPI “Préstamos”
                _prestamos += m;
                break;

              default:
                // cierres u otros tipos informativos
                break;
            }
          });

          // ⛔ NO setear cajaInicialBase aquí (evita pisar con 0 por carreras)
          setApertura(lastAperturaMonto);

          // Orden descendente por timestamp (cliente)
          _movsCaja.sort(
            (a, b) =>
              (b.createdAtMs ?? (b as any).createdAt?.seconds ?? 0) -
              (a.createdAtMs ?? (a as any).createdAt?.seconds ?? 0)
          );

          setAbonos(_abonos);
          setIngresos(_ingresos);
          setRetiros(_retiros);
          setPrestamosDelDia(_prestamos); // ✅ sólo de cajaDiaria
          setMovsCaja(_movsCaja);
          setCargando(false);
        },
        (err) => {
          console.warn('[CajaDiaria] snapshot error:', err?.code || err?.message || err);
          Alert.alert('Atención', 'No fue posible leer la caja del día.');
          setApertura(0);
          setAbonos(0);
          setIngresos(0);
          setRetiros(0);
          setPrestamosDelDia(0);
          setMovsCaja([]);
          setCargando(false);
        }
      );

      return () => {
        try {
          unsub();
        } catch {}
      };
    } catch (e) {
      console.warn('[CajaDiaria] suscripción no disponible:', e);
      setCargando(false);
    }
  }, [admin, hoy]);

  // ======= Quick add: Ingreso / Retiro (modal) =======
  const [modalOpen, setModalOpen] = useState<false | 'ingreso' | 'retiro'>(false);
  const [montoTxt, setMontoTxt] = useState('');
  const [notaTxt, setNotaTxt] = useState('');
  const [guardandoMov, setGuardandoMov] = useState(false);

  const closeModal = () => {
    setModalOpen(false);
    setMontoTxt('');
    setNotaTxt('');
  };

  const parseMonto = (t: string) => {
    const norm = (t || '').replace(',', '.').trim();
    if (!/^\d+(\.\d{0,2})?$/.test(norm)) return NaN;
    return parseFloat(norm);
  };

  const guardarMovimiento = async () => {
    if (!modalOpen) return;
    const num = parseMonto(montoTxt);
    if (!isFinite(num) || num <= 0) {
      Alert.alert('Monto inválido', 'Ingresa un monto mayor a 0 con hasta 2 decimales.');
      return;
    }
    try {
      setGuardandoMov(true);
      const payload = {
        tipo: modalOpen,
        admin,
        monto: Math.round(num * 100) / 100,
        operationalDate: hoy,
        tz,
        nota: notaTxt.trim() ? notaTxt.trim() : null,
        createdAt: serverTimestamp(),
        createdAtMs: Date.now(),
        source: 'manual' as const,
      };
      const ref = await addDoc(collection(db, 'cajaDiaria'), payload);

      await logAudit({
        userId: admin,
        action: modalOpen === 'ingreso' ? 'caja_ingreso' : 'caja_retiro',
        ref,
        before: null,
        after: pick(payload, ['tipo', 'admin', 'monto', 'operationalDate', 'tz', 'nota', 'source']),
      });

      closeModal();
      Alert.alert('Listo', modalOpen === 'ingreso' ? 'Ingreso registrado.' : 'Retiro registrado.');
    } catch (e) {
      console.error('[CajaDiaria] guardarMovimiento:', e);
      Alert.alert('Error', 'No se pudo guardar el movimiento.');
    } finally {
      setGuardandoMov(false);
    }
  };

  // ==== UI ====
  const renderMovimiento = ({ item }: { item: MovimientoCaja }) => {
    const ico = iconFor(item.tipo);
    const tone = toneFor(item.tipo);
    const baseLabel = labelFor(item.tipo);
    const title = item.tipo === 'gasto_admin' ? item.categoria || baseLabel : baseLabel;

    return (
      <View
        style={[
          styles.gastoItem,
          { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
        ]}
      >
        <View style={{ width: 26, alignItems: 'center' }}>
          <MIcon name={ico.name as any} size={18} color={tone} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.gastoTipo, { color: palette.text }]} numberOfLines={1}>
            {title}
          </Text>
          {!!item.nota && (
            <Text style={{ fontSize: 12, color: palette.softText }} numberOfLines={1}>
              {item.nota}
            </Text>
          )}
        </View>
        <Text style={[styles.gastoMonto, { color: palette.text }]}>
          R$ {Number(item.monto || 0).toFixed(2)}
        </Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg }}>
      <View
        style={[styles.header, { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder }]}
      >
        <Text style={[styles.headerTitle, { color: palette.text }]}>Caja diaria</Text>
        <Text style={[styles.headerSub, { color: palette.softText }]}>{hoy}</Text>
      </View>

      {cargando ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : (
        <>
          {/* KPIs */}
          <View style={[styles.kpis, { borderColor: palette.cardBorder }]}>
            <View
              style={[
                styles.kpi,
                { backgroundColor: isDark ? palette.kpiTrack : '#E8F5E9', borderColor: palette.cardBorder },
              ]}
            >
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Caja inicial</Text>
              <Text style={[styles.kpiVal, { color: palette.text }]}>R$ {cajaInicial.toFixed(2)}</Text>
            </View>
            <View
              style={[
                styles.kpi,
                { backgroundColor: isDark ? palette.kpiTrack : '#E3F2FD', borderColor: palette.cardBorder },
              ]}
            >
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Cobrado</Text>
              <Text style={[styles.kpiVal, { color: palette.text }]}>R$ {abonos.toFixed(2)}</Text>
            </View>
            <View
              style={[
                styles.kpi,
                { backgroundColor: isDark ? palette.kpiTrack : '#FFFDE7', borderColor: palette.cardBorder },
              ]}
            >
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Ingresos</Text>
              <Text style={[styles.kpiVal, { color: palette.text }]}>R$ {ingresos.toFixed(2)}</Text>
            </View>
          </View>

          <View style={[styles.kpis, { borderColor: palette.cardBorder, marginTop: 8 }]}>
            <View
              style={[
                styles.kpi,
                { backgroundColor: isDark ? palette.kpiTrack : '#FFEBEE', borderColor: palette.cardBorder },
              ]}
            >
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Retiros</Text>
              <Text style={[styles.kpiVal, { color: palette.text }]}>R$ {retiros.toFixed(2)}</Text>
            </View>
            <View
              style={[
                styles.kpi,
                { backgroundColor: isDark ? palette.kpiTrack : '#FFF8E1', borderColor: palette.cardBorder },
              ]}
            >
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Gastos (Admin)</Text>
              <Text style={[styles.kpiVal, { color: palette.text }]}>R$ {totalGastos.toFixed(2)}</Text>
            </View>
            <View
              style={[
                styles.kpi,
                { backgroundColor: isDark ? palette.kpiTrack : '#E1F5FE', borderColor: palette.cardBorder },
              ]}
            >
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Préstamos</Text>
              <Text style={[styles.kpiVal, { color: palette.text }]}>
                R$ {prestamosDelDia.toFixed(2)}
              </Text>
            </View>
          </View>

          {/* Resultado */}
          <View style={[styles.kpis, { borderColor: palette.cardBorder, marginTop: 8 }]}>
            <View
              style={[
                styles.kpi,
                { backgroundColor: isDark ? palette.kpiTrack : '#F3E5F5', borderColor: palette.cardBorder },
              ]}
            >
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Caja final (viva)</Text>
              <Text style={[styles.kpiVal, { color: palette.text }]}>R$ {cajaFinal.toFixed(2)}</Text>
            </View>
            {!!apertura && (
              <View
                style={[
                  styles.kpi,
                  { backgroundColor: isDark ? palette.kpiTrack : '#ECEFF1', borderColor: palette.cardBorder },
                ]}
              >
                <Text style={[styles.kpiLabel, { color: palette.softText }]}>Apertura (referencia)</Text>
                <Text style={[styles.kpiVal, { color: palette.text }]}>R$ {apertura.toFixed(2)}</Text>
              </View>
            )}
          </View>

          {/* Listado combinado */}
          <Text style={[styles.sectionTitle, { color: palette.text, marginTop: 8 }]}>
            Movimientos de caja
          </Text>
          {movsCaja.length === 0 ? (
            <Text style={{ textAlign: 'center', marginTop: 8, color: palette.softText }}>
              No hay movimientos registrados.
            </Text>
          ) : (
            <FlatList
              data={movsCaja}
              keyExtractor={(x) => x.id}
              style={{ paddingHorizontal: 12 }}
              ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
              renderItem={renderMovimiento}
              contentContainerStyle={{ paddingBottom: 120 + Math.max(0, insets.bottom) }}
            />
          )}
        </>
      )}

      {/* Barra de acciones */}
      <View
        style={[
          styles.actionsBar,
          {
            backgroundColor: palette.commBg,
            borderColor: palette.commBorder,
            bottom: insets.bottom + 8,
            shadowColor: palette.text,
          },
        ]}
      >
        <TouchableOpacity
          style={[
            styles.btnSoft,
            { backgroundColor: isDark ? palette.kpiTrack : '#E8F5E9', borderColor: palette.cardBorder },
          ]}
          onPress={() => setModalOpen('ingreso')}
          activeOpacity={0.9}
        >
          <Text style={[styles.btnSoftTxt, { color: palette.text }]}>+ Ingreso</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.btnSoft,
            { backgroundColor: isDark ? palette.kpiTrack : '#FFEBEE', borderColor: palette.cardBorder },
          ]}
          onPress={() => setModalOpen('retiro')}
          activeOpacity={0.9}
        >
          <Text style={[styles.btnSoftTxt, { color: palette.text }]}>– Retiro</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.btnGhost, { borderColor: palette.accent }]}
          onPress={() => navigation.navigate('NuevoGasto', { admin })}
          activeOpacity={0.9}
        >
          <Text style={[styles.btnGhostTxt, { color: palette.accent }]}>+ Nuevo gasto</Text>
        </TouchableOpacity>
      </View>

      {/* Modal simple para ingreso/retiro */}
      <Modal
        visible={!!modalOpen}
        transparent
        animationType="fade"
        onRequestClose={closeModal}
        statusBarTranslucent
        hardwareAccelerated
      >
        <View style={styles.modalBackdrop} />
        <View style={[styles.modalCard, { marginBottom: Math.max(insets.bottom + 16, 24) }]}>
          <Text style={styles.modalTitle}>
            {modalOpen === 'ingreso' ? 'Registrar ingreso' : 'Registrar retiro'}
          </Text>

          <Text style={styles.modalLabel}>Monto</Text>
          <TextInput
            value={montoTxt}
            onChangeText={setMontoTxt}
            keyboardType={Platform.select({ ios: 'decimal-pad', android: 'decimal-pad' })}
            placeholder="0,00"
            style={styles.modalInput}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={guardarMovimiento}
          />

          <Text style={styles.modalLabel}>Nota (opcional)</Text>
          <TextInput
            value={notaTxt}
            onChangeText={setNotaTxt}
            placeholder="Detalle breve"
            style={[styles.modalInput, styles.modalTextarea]}
            multiline
          />

          <View style={styles.modalActions}>
            <TouchableOpacity
              style={[styles.modalBtn, styles.modalBtnCancel]}
              onPress={closeModal}
              disabled={guardandoMov}
            >
              <Text style={[styles.modalBtnTxt, { color: '#455A64' }]}>Cancelar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalBtn, styles.modalBtnSave]}
              onPress={guardarMovimiento}
              disabled={guardandoMov}
              activeOpacity={0.9}
            >
              <Text style={[styles.modalBtnTxt, { color: '#fff' }]}>
                {guardandoMov ? 'Guardando…' : 'Guardar'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { paddingVertical: 10, alignItems: 'center', borderBottomWidth: 1 },
  headerTitle: { fontSize: 16, fontWeight: '800' },
  headerSub: { fontSize: 12, marginTop: 2 },

  kpis: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, marginTop: 12 },
  kpi: { flex: 1, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1 },
  kpiLabel: { fontSize: 11, fontWeight: '700' },
  kpiVal: { fontSize: 16, fontWeight: '900', marginTop: 4 },

  sectionTitle: { fontSize: 13, fontWeight: '800', paddingHorizontal: 12, marginTop: 12, marginBottom: 6 },

  gastoItem: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  gastoTipo: { fontSize: 13, fontWeight: '800' },
  gastoMonto: { fontSize: 14, fontWeight: '900' },

  actionsBar: {
    position: 'absolute',
    left: 12,
    right: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    elevation: 6,
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: -2 },
  },
  btnSoft: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', borderWidth: 1 },
  btnSoftTxt: { fontWeight: '800', fontSize: 14 },
  btnGhost: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1.5,
    backgroundColor: 'transparent',
  },
  btnGhostTxt: { fontWeight: '800', fontSize: 14 },

  modalBackdrop: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.25)' },
  modalCard: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 0,
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 12,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: -2 } },
    }),
  },
  modalTitle: { fontSize: 14, fontWeight: '900', color: '#263238', textAlign: 'center' },
  modalLabel: { fontSize: 11, fontWeight: '700', color: '#607D8B', marginTop: 8, marginBottom: 4 },
  modalInput: {
    borderWidth: 1,
    borderColor: '#DFE5E1',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: Platform.select({ ios: 8, android: 6 }),
    fontSize: 14,
    color: '#263238',
    backgroundColor: '#fff',
  },
  modalTextarea: { height: 72, textAlignVertical: 'top' },
  modalActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  modalBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
  modalBtnCancel: { backgroundColor: '#ECEFF1' },
  modalBtnSave: { backgroundColor: '#2e7d32' },
  modalBtnTxt: { fontWeight: '800', fontSize: 13 },
});
