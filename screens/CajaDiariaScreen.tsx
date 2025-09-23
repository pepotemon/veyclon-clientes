// screens/CajaDiariaScreen.tsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ActivityIndicator,
  FlatList, TouchableOpacity, Alert, Modal, TextInput, Platform
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { useAppTheme } from '../theme/ThemeProvider';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { db } from '../firebase/firebaseConfig';
import {
  addDoc, serverTimestamp, query, where, collection, onSnapshot, orderBy,
  getDocs, collectionGroup
} from 'firebase/firestore';

import { todayInTZ, pickTZ, normYYYYMMDD } from '../utils/timezone';
import { logAudit, pick } from '../utils/auditLogs';
import { MaterialCommunityIcons as MIcon } from '@expo/vector-icons';

// 👇 NUEVO: helper de movimientos (tipos/iconos/labels/colores)
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

// Para la lista compacta mostramos ingreso | retiro | gasto_admin
type MovimientoCaja = MovimientoBase & {
  tipo: Extract<MovimientoTipo, 'ingreso' | 'retiro' | 'gasto_admin'>;
  categoria?: string; // solo para gasto_admin
};

type Prestamo = {
  id: string;
  tz?: string;
  createdAt?: any;
  createdAtMs?: number;
  fechaInicio?: any;
  estado?: string;
  valorNeto?: number;
  capital?: number;
  creadoPor?: string;
};

const tz = 'America/Sao_Paulo';

function formatDateToYMD(date: Date, tzLocal: string) {
  const parts = new Intl.DateTimeFormat('es-ES', {
    timeZone: tzLocal, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const y = parts.find(p => p.type === 'year')?.value ?? '0000';
  const m = parts.find(p => p.type === 'month')?.value ?? '01';
  const d = parts.find(p => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}
function anyDateToYYYYMMDD(d: any, tzLocal: string): string | null {
  try {
    if (!d) return null;
    if (typeof d === 'string') return normYYYYMMDD(d) || null;
    if (typeof d === 'number') return formatDateToYMD(new Date(d), tzLocal);
    if (typeof d?.toDate === 'function') return formatDateToYMD(d.toDate(), tzLocal);
    if (typeof d?.seconds === 'number') return formatDateToYMD(new Date(d.seconds * 1000), tzLocal);
    if (d instanceof Date) return formatDateToYMD(d, tzLocal);
    return null;
  } catch {
    return null;
  }
}

export default function CajaDiariaScreen({ route, navigation }: Props) {
  const { admin } = route.params;
  const { palette, isDark } = useAppTheme();
  const insets = useSafeAreaInsets();

  const hoy = useMemo(() => todayInTZ(tz), []);

  const [cargando, setCargando] = useState(true);

  // KPIs desde cajaDiaria
  const [apertura, setApertura] = useState(0);
  const [abonos, setAbonos] = useState(0);     // cobrado (abono/pago)
  const [ingresos, setIngresos] = useState(0); // manuales (⚠️ ventas NO suman aquí)
  const [retiros, setRetiros] = useState(0);   // incluye retiros manuales y ventas (retiro por entrega)

  // Movimientos combinados (ingresos + retiros + gastos admin)
  const [movsCaja, setMovsCaja] = useState<MovimientoCaja[]>([]);

  // Préstamos del día (capital/valorNeto creado hoy)
  const [prestamosDelDia, setPrestamosDelDia] = useState(0);

  // Total de gastos admin (para KPI) a partir de movsCaja
  const totalGastos = useMemo(
    () => movsCaja
      .filter(m => m.tipo === 'gasto_admin')
      .reduce((acc, g) => acc + (Number(g.monto) || 0), 0),
    [movsCaja]
  );

  // Balance operativo del día (incluye préstamos como salida de caja)
  const balance = useMemo(
    () => apertura + ingresos + abonos - retiros - totalGastos - prestamosDelDia,
    [apertura, ingresos, abonos, retiros, totalGastos, prestamosDelDia]
  );

  // Snapshot de movimientos del día (cajaDiaria)
  useEffect(() => {
    setCargando(true);
    try {
      // admin ==, operationalDate ==, orderBy createdAt asc
      const qDia = query(
        collection(db, 'cajaDiaria'),
        where('admin', '==', admin),
        where('operationalDate', '==', hoy),
        orderBy('createdAt', 'asc')
      );

      const unsub = onSnapshot(
        qDia,
        (snap) => {
          // acumuladores
          let lastAperturaMonto = 0;
          let lastAperturaTs = -1; // para elegir la última apertura del día
          let _abonos = 0;
          let _ingresos = 0;
          let _retiros = 0;

          const _movsCaja: MovimientoCaja[] = [];

          snap.forEach((d) => {
            const data = d.data() as any;
            const tip = canonicalTipo(data?.tipo);
            if (!tip) return;

            const m = Number(data?.monto || 0);
            if (!Number.isFinite(m)) return;

            // timestamp robusto
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
                // ✅ Ingreso manual únicamente (ventas NO cuentan como ingreso)
                _ingresos += m;
                _movsCaja.push({
                  id: d.id, tipo: 'ingreso', monto: m,
                  nota: data?.nota || '',
                  operationalDate: data?.operationalDate,
                  tz: data?.tz || tz,
                  admin: data?.admin || admin,
                  createdAt: data?.createdAt,
                  createdAtMs: typeof data?.createdAtMs === 'number' ? data.createdAtMs : undefined,
                });
                break;

              case 'retiro':
                // ✅ Retiro: incluye retiros manuales y ventas (retiro por entrega de préstamo)
                _retiros += m;
                _movsCaja.push({
                  id: d.id, tipo: 'retiro', monto: m,
                  nota: data?.nota || '',
                  operationalDate: data?.operationalDate,
                  tz: data?.tz || tz,
                  admin: data?.admin || admin,
                  createdAt: data?.createdAt,
                  createdAtMs: typeof data?.createdAtMs === 'number' ? data.createdAtMs : undefined,
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
                  createdAtMs: typeof data?.createdAtMs === 'number' ? data.createdAtMs : undefined,
                });
                break;

              case 'gasto_cobrador':
                // Gasto del cobrador: NO se muestra aquí (caja del admin)
                break;

              // ⚠️ 'venta' no es un tipo canónico de caja: la venta se registra como 'retiro'
              // y el KPI de préstamos se calcula leyendo la colección de préstamos del día.
              case 'cierre':
              default:
                // no suma a KPIs mostrados
                break;
            }
          });

          // ordenar la lista combinada por fecha DESC (más reciente primero)
          _movsCaja.sort(
            (a, b) =>
              (b.createdAtMs ?? (b as any).createdAt?.seconds ?? 0) -
              (a.createdAtMs ?? (a as any).createdAt?.seconds ?? 0)
          );

          setApertura(lastAperturaMonto);
          setAbonos(_abonos);
          setIngresos(_ingresos);
          setRetiros(_retiros);
          setMovsCaja(_movsCaja);
          setCargando(false);
        },
        (err) => {
          console.warn('[CajaDiaria] snapshot error:', err?.code || err?.message || err);
          Alert.alert('Atención', 'Firestore requiere crear un índice. Abre el link de la consola para crearlo.');
          setApertura(0); setAbonos(0); setIngresos(0); setRetiros(0); setMovsCaja([]);
          setCargando(false);
        }
      );

      return () => { try { unsub(); } catch {} };
    } catch (e) {
      console.warn('[CajaDiaria] suscripción no disponible:', e);
      setCargando(false);
    }
  }, [admin, hoy]);

  // Cálculo de PRÉSTAMOS DEL DÍA (KPI préstamos)
  // ✅ Se suman los préstamos creados hoy por este admin (valorNeto/capital),
  // y NO se suman como ingreso (la salida de efectivo ya quedó como retiro).
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const qPrest = query(collectionGroup(db, 'prestamos'), where('creadoPor', '==', admin));
        const snap = await getDocs(qPrest);

        let total = 0;
        snap.forEach((d) => {
          const p = d.data() as Prestamo;
          if (p?.estado && p.estado !== 'activo') return;

          const tzP = pickTZ(p?.tz, tz);
          const startYmd = anyDateToYYYYMMDD(
            (typeof p?.createdAtMs === 'number' ? p.createdAtMs : (p?.createdAt ?? p?.fechaInicio)),
            tzP
          );
          if (!startYmd) return;
          if (startYmd !== todayInTZ(tzP)) return;

          const capital = Number(p?.valorNeto ?? p?.capital ?? 0);
          if (Number.isFinite(capital) && capital > 0) total += capital;
        });

        if (active) setPrestamosDelDia(total);
      } catch (e) {
        console.warn('[CajaDiaria] prestamosDelDia error:', e);
        if (active) setPrestamosDelDia(0);
      }
    })();
    return () => { active = false; };
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
        tipo: modalOpen, // 'ingreso' | 'retiro' (canónico). Las ventas NUNCA van como 'ingreso'.
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

      // Auditoría específica
      await logAudit({
        userId: admin,
        action: modalOpen === 'ingreso' ? 'caja_ingreso' : 'caja_retiro',
        ref,
        before: null,
        after: pick(payload, ['tipo','admin','monto','operationalDate','tz','nota','source']),
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
    const title = item.tipo === 'gasto_admin' ? (item.categoria || baseLabel) : baseLabel;

    return (
      <View style={[
        styles.gastoItem,
        { backgroundColor: palette.cardBg, borderColor: palette.cardBorder }
      ]}>
        <View style={{ width: 26, alignItems: 'center' }}>
          <MIcon name={ico.name as any} size={18} color={tone} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.gastoTipo, { color: palette.text }]} numberOfLines={1}>{title}</Text>
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
      <View style={[styles.header, { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder }]}>
        <Text style={[styles.headerTitle, { color: palette.text }]}>Caja diaria</Text>
        <Text style={[styles.headerSub, { color: palette.softText }]}>{hoy}</Text>
      </View>

      {cargando ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : (
        <>
          <View style={[styles.kpis, { borderColor: palette.cardBorder }]}>
            <View style={[styles.kpi, { backgroundColor: isDark ? palette.kpiTrack : '#E8F5E9', borderColor: palette.cardBorder }]}>
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Apertura</Text>
              <Text style={[styles.kpiVal, { color: palette.text }]}>R$ {apertura.toFixed(2)}</Text>
            </View>
            <View style={[styles.kpi, { backgroundColor: isDark ? palette.kpiTrack : '#E3F2FD', borderColor: palette.cardBorder }]}>
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Cobrado</Text>
              <Text style={[styles.kpiVal, { color: palette.text }]}>R$ {abonos.toFixed(2)}</Text>
            </View>
            <View style={[styles.kpi, { backgroundColor: isDark ? palette.kpiTrack : '#FFFDE7', borderColor: palette.cardBorder }]}>
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Ingresos</Text>
              <Text style={[styles.kpiVal, { color: palette.text }]}>R$ {ingresos.toFixed(2)}</Text>
            </View>
          </View>

          <View style={[styles.kpis, { borderColor: palette.cardBorder, marginTop: 8 }]}>
            <View style={[styles.kpi, { backgroundColor: isDark ? palette.kpiTrack : '#FFEBEE', borderColor: palette.cardBorder }]}>
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Retiros</Text>
              <Text style={[styles.kpiVal, { color: palette.text }]}>R$ {retiros.toFixed(2)}</Text>
            </View>
            <View style={[styles.kpi, { backgroundColor: isDark ? palette.kpiTrack : '#FFF8E1', borderColor: palette.cardBorder }]}>
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Gastos (Admin)</Text>
              <Text style={[styles.kpiVal, { color: palette.text }]}>R$ {totalGastos.toFixed(2)}</Text>
            </View>
            <View style={[styles.kpi, { backgroundColor: isDark ? palette.kpiTrack : '#E1F5FE', borderColor: palette.cardBorder }]}>
              <Text style={[styles.kpiLabel, { color: palette.softText }]}>Préstamos</Text>
              <Text style={[styles.kpiVal, { color: palette.text }]}>R$ {prestamosDelDia.toFixed(2)}</Text>
            </View>
          </View>

          {/* Listado combinado */}
          <Text style={[styles.sectionTitle, { color: palette.text, marginTop: 8 }]}>Movimientos de caja</Text>
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

      {/* Barra de acciones: + Ingreso / – Retiro / + Gasto */}
      <View style={[
        styles.actionsBar,
        {
          backgroundColor: palette.commBg,
          borderColor: palette.commBorder,
          bottom: insets.bottom + 8,
          shadowColor: palette.text,
        }
      ]}>
        <TouchableOpacity
          style={[styles.btnSoft, { backgroundColor: isDark ? palette.kpiTrack : '#E8F5E9', borderColor: palette.cardBorder }]}
          onPress={() => setModalOpen('ingreso')}
          activeOpacity={0.9}
        >
          <Text style={[styles.btnSoftTxt, { color: palette.text }]}>+ Ingreso</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.btnSoft, { backgroundColor: isDark ? palette.kpiTrack : '#FFEBEE', borderColor: palette.cardBorder }]}
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
            <TouchableOpacity style={[styles.modalBtn, styles.modalBtnCancel]} onPress={closeModal} disabled={guardandoMov}>
              <Text style={[styles.modalBtnTxt, { color: '#455A64' }]}>Cancelar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalBtn, styles.modalBtnSave]}
              onPress={guardarMovimiento}
              disabled={guardandoMov}
              activeOpacity={0.9}
            >
              <Text style={[styles.modalBtnTxt, { color: '#fff' }]}>{guardandoMov ? 'Guardando…' : 'Guardar'}</Text>
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
    borderRadius: 10, borderWidth: 1, paddingVertical: 10, paddingHorizontal: 12,
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  gastoTipo: { fontSize: 13, fontWeight: '800' },
  gastoMonto: { fontSize: 14, fontWeight: '900' },

  actionsBar: {
    position: 'absolute', left: 12, right: 12, paddingVertical: 8, paddingHorizontal: 10,
    borderRadius: 12, borderWidth: 1, flexDirection: 'row', gap: 10,
    elevation: 6, shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: -2 },
  },
  btnSoft: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', borderWidth: 1 },
  btnSoftTxt: { fontWeight: '800', fontSize: 14 },
  btnGhost: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', borderWidth: 1.5, backgroundColor: 'transparent' },
  btnGhostTxt: { fontWeight: '800', fontSize: 14 },

  // Modal
  modalBackdrop: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.25)' },
  modalCard: {
    position: 'absolute', left: 12, right: 12, bottom: 0,
    backgroundColor: '#fff', borderRadius: 14, padding: 12,
    ...Platform.select({ ios: { shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: -2 } } })
  },
  modalTitle: { fontSize: 14, fontWeight: '900', color: '#263238', textAlign: 'center' },
  modalLabel: { fontSize: 11, fontWeight: '700', color: '#607D8B', marginTop: 8, marginBottom: 4 },
  modalInput: {
    borderWidth: 1, borderColor: '#DFE5E1', borderRadius: 8, paddingHorizontal: 10,
    paddingVertical: Platform.select({ ios: 8, android: 6 }), fontSize: 14, color: '#263238',
    backgroundColor: '#fff',
  },
  modalTextarea: { height: 72, textAlignVertical: 'top' },
  modalActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  modalBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
  modalBtnCancel: { backgroundColor: '#ECEFF1' },
  modalBtnSave: { backgroundColor: '#2e7d32' },
  modalBtnTxt: { fontWeight: '800', fontSize: 13 },
});
