// screens/CerrarDiaScreen.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, FlatList, Modal, Platform } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppTheme } from '../theme/ThemeProvider';
import { db } from '../firebase/firebaseConfig';
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  query,
  where,
  orderBy,
  limit,
  type QuerySnapshot,
  type DocumentData,
} from 'firebase/firestore';
import { Ionicons } from '@expo/vector-icons';
import { pickTZ, todayInTZ } from '../utils/timezone';
import { ensureAperturaDeHoy, closeMissingDays } from '../utils/cajaEstado';
import { canonicalTipo } from '../utils/movimientoHelper';

// Helpers de Fallback (sin índices compuestos/orderBy)
import { onSnapshotWithFallback, getDocsWithFallback } from '../utils/firestoreFallback';

type Props = NativeStackScreenProps<RootStackParamList, 'CerrarDia'>;

const DISPLAY_LOCALE = 'es-AR';
const TZ_DEFAULT = 'America/Sao_Paulo';
const money = (n: number) =>
  `R$ ${Number(Math.abs(n) < 0.005 ? 0 : n).toLocaleString(DISPLAY_LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

type Totales = {
  apertura: number;
  cobrado: number;
  ingresos: number;
  retiros: number;
  gastos: number;
  prestamos: number;
  abonosCount: number; // visitados = cantidad de abonos del día
};

const EMPTY_TOTALES: Totales = { apertura: 0, cobrado: 0, ingresos: 0, retiros: 0, gastos: 0, prestamos: 0, abonosCount: 0 };

function ymdAdd(ymd: string, deltaDays: number) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + deltaDays);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
function rangeLastDays(tz: string, n = 30) {
  const today = todayInTZ(tz);
  const arr: string[] = [];
  for (let i = 0; i < n; i++) arr.push(ymdAdd(today, -i));
  return arr;
}

export default function CerrarDiaScreen({ route }: Props) {
  const { admin } = route.params;
  const { palette } = useAppTheme();

  const tz = pickTZ(undefined, TZ_DEFAULT);
  const hoy = todayInTZ(tz);

  // ===== Estado =====
  const [selectedYmd, setSelectedYmd] = useState(hoy);
  const [pickerVisible, setPickerVisible] = useState(false);

  // Cargas
  const [loadingCaja, setLoadingCaja] = useState(true);
  const [loadingProg, setLoadingProg] = useState(true);

  // Totales del día mostrado (derivados 100% desde cajaDiaria)
  const [kpiCaja, setKpiCaja] = useState<Totales>(EMPTY_TOTALES);

  // Conteo “programados” (solo HOY en vivo; histórico: se intenta leer snapshot)
  const [programadosCount, setProgramadosCount] = useState<number>(0);

  // Caja inicial base (cierre del día anterior al mostrado)
  const [cajaInicial, setCajaInicial] = useState<number>(0);

  // ===== Helpers =====
  async function getCajaInicialUI(adminId: string, baseYmd: string): Promise<number> {
    // AYER respecto al día seleccionado
    const [Y, M, D] = baseYmd.split('-').map((n) => parseInt(n, 10));
    const dt = new Date(Date.UTC(Y, M - 1, D));
    dt.setUTCDate(dt.getUTCDate() - 1);
    const ayer = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;

    // 1) Preferimos cierre idempotente EXACTO de AYER
    try {
      const cierreId = `cierre_${adminId}_${ayer}`;
      const cierreSnap = await getDoc(doc(db, 'cajaDiaria', cierreId));
      if (cierreSnap.exists()) return Number(cierreSnap.data()?.balance || 0);
    } catch {}

    // 2) Último cierre ≤ AYER (main con índices; fallback sin índices, filtrando en cliente)
    const qCMain = query(
      collection(db, 'cajaDiaria'),
      where('admin', '==', adminId),
      where('tipo', '==', 'cierre'),
      where('operationalDate', '<=', ayer),
      orderBy('operationalDate', 'desc'),
      orderBy('createdAt', 'desc'),
      limit(25)
    );
    const qCFallback = query(
      collection(db, 'cajaDiaria'),
      where('admin', '==', adminId),
      where('tipo', '==', 'cierre')
    );

   try {
  const snap = await getDocsWithFallback(qCMain, qCFallback);

  // ✅ acumuladores primitivos (evita 'never')
  let bestOp: string = '';
  let bestMs: number = -1;
  let bestBal: number = 0;

  snap.forEach((d: any) => {
    const data = d.data ? d.data() : d;
    const op = String(data?.operationalDate || '');
    if (!op || op > ayer) return; // solo ≤ AYER

    const ms =
      (typeof data?.createdAtMs === 'number' && data.createdAtMs) ||
      (typeof data?.createdAt?.seconds === 'number' && data.createdAt.seconds * 1000) ||
      0;

    const bal = Number(data?.balance || 0);

    // Prioridad: fecha operativa más reciente; si empata, el createdAt más nuevo
    if (!bestOp || op > bestOp || (op === bestOp && ms > bestMs)) {
      bestOp = op;
      bestMs = ms;
      bestBal = bal;
    }
  });

  if (bestMs >= 0) {
    return Number.isFinite(bestBal) ? bestBal : 0;
  }
} catch {
  // silencioso: seguimos al retorno 0
}
    // 3) Sin cierres históricos → 0
    return 0;
  }

  function computeTotalsFromDocs(snap: QuerySnapshot<DocumentData> | any): Totales {
    let apertura = 0;
    let aperturaTs = -1;
    let cobrado = 0;
    let ingresos = 0;
    let retiros = 0;
    let gastos = 0;
    let prestamos = 0;
    let abonosCount = 0;

    snap.forEach((d: any) => {
      const data = d.data ? d.data() : d; // soporta docs plain (getDocs) o adaptados
      const tip = canonicalTipo(data?.tipo);
      if (!tip) return;

      const monto = Number(data?.monto ?? data?.balance ?? 0) || 0;
      const ts =
        (typeof data?.createdAtMs === 'number' && data.createdAtMs) ||
        (typeof data?.createdAt?.seconds === 'number' && data.createdAt.seconds * 1000) ||
        0;

      switch (tip) {
        case 'apertura':
          if (ts >= aperturaTs) {
            aperturaTs = ts;
            apertura = monto;
          }
          break;
        case 'abono':
          cobrado += monto;
          abonosCount += 1;
          break;
        case 'ingreso':
          ingresos += monto;
          break;
        case 'retiro':
          retiros += monto;
          break;
        case 'gasto_admin':
          gastos += monto;
          break;
        case 'prestamo':
          prestamos += monto;
          break;
        default:
          break;
      }
    });

    return { apertura, cobrado, ingresos, retiros, gastos, prestamos, abonosCount };
  }

  // —— Listener LIGERO de “programados” — SOLO HOY
  useEffect(() => {
    if (selectedYmd !== hoy) {
      setProgramadosCount(0);
      setLoadingProg(false);
      return;
    }

    setLoadingProg(true);
    try {
      const qPMain = query(
        collectionGroup(db, 'prestamos'),
        where('creadoPor', '==', admin),
        where('status', '==', 'activo'),
        where('restante', '>', 0)
      );
      const qPFallback = query(collectionGroup(db, 'prestamos'), where('creadoPor', '==', admin));

      const unsub = onSnapshotWithFallback(
        qPMain,
        qPFallback,
        (sg) => {
          let n = 0;
          sg.forEach((docSnap) => {
            const data: any = docSnap.data();
            const st = (data?.status ?? 'activo') as string;
            if (st !== 'activo') return;
            if (!(Number(data?.restante) > 0)) return;
            n++;
          });
          setProgramadosCount(n);
          setLoadingProg(false);
        },
        (err) => {
          console.warn('[CerrarDia] prestamos (conteo) snapshot:', err?.code || err?.message || err);
          setProgramadosCount(0);
          setLoadingProg(false);
        }
      );

      return () => { try { unsub(); } catch {} };
    } catch (e) {
      console.warn('[CerrarDia] suscripción prestamos (conteo) no disponible:', e);
      setProgramadosCount(0);
      setLoadingProg(false);
    }
  }, [admin, hoy, selectedYmd]);

  // —— Caja del día seleccionado
  useEffect(() => {
    let unsub: undefined | (() => void);
    const load = async () => {
      setLoadingCaja(true);
      setKpiCaja(EMPTY_TOTALES);

      // 1) Caja inicial: cierre del día anterior al seleccionado (heredado)
      try {
        const base = await getCajaInicialUI(admin, selectedYmd);
        setCajaInicial(Number.isFinite(base) ? base : 0);
      } catch (e) {
        console.warn('[CerrarDia] getCajaInicialUI error:', e);
        setCajaInicial(0);
      }

      // 2) Si existe snapshot histórico, úsalo para programados si lo guarda
      try {
        const histRef = doc(db, 'cierresDiarios', admin, 'dias', selectedYmd);
        const hist = await getDoc(histRef);
        if (hist.exists() && selectedYmd !== hoy) {
          const data: any = hist.data();
          if (typeof data?.programados === 'number') {
            setProgramadosCount(Number(data.programados));
          }
        }
      } catch (e) {
        // silencioso
      }

      try {
        // HOY: live; HISTÓRICO: lectura puntual
        const qMain = query(
          collection(db, 'cajaDiaria'),
          where('admin', '==', admin),
          where('operationalDate', '==', selectedYmd),
          orderBy('createdAt', 'asc')
        );
        const qFallback = query(
          collection(db, 'cajaDiaria'),
          where('admin', '==', admin),
          where('operationalDate', '==', selectedYmd)
        );

        if (selectedYmd === hoy) {
          unsub = onSnapshotWithFallback(
            qMain,
            qFallback,
            (snap) => {
              const totals = computeTotalsFromDocs(snap);
              setKpiCaja(totals);
              setLoadingCaja(false);
            },
            (err) => {
              console.warn('[CerrarDia] cajaDiaria snapshot:', err?.code || err?.message || err);
              setKpiCaja(EMPTY_TOTALES);
              setLoadingCaja(false);
              Alert.alert('Atención', 'Si ves un enlace de índice en la consola, créalo para continuar.');
            }
          );
        } else {
          const s = await getDocsWithFallback(qMain, qFallback);
          const totals = computeTotalsFromDocs(s);
          setKpiCaja(totals);
          setLoadingCaja(false);
        }
      } catch (e) {
        console.warn('[CerrarDia] carga caja (día seleccionado) error:', e);
        setKpiCaja(EMPTY_TOTALES);
        setLoadingCaja(false);
      }
    };

    load();
    return () => { try { unsub && unsub(); } catch {} };
  }, [admin, hoy, selectedYmd]);

  // —— SANEADOR: solo para HOY
  const autoCloseGuard = useRef(false);
  useEffect(() => {
    if (selectedYmd !== hoy) return;
    if (autoCloseGuard.current) return;
    autoCloseGuard.current = true;
    (async () => {
      await closeMissingDays(admin, hoy, tz);
      await ensureAperturaDeHoy(admin, hoy, tz);
    })().catch((e) => {
      console.warn('[CerrarDia] auto-saneador error:', e?.message || e);
    });
  }, [admin, hoy, tz, selectedYmd]);

  // ===== KPIs derivados =====
  const baseInicial = kpiCaja.apertura > 0 ? kpiCaja.apertura : cajaInicial;
  const cajaFinalRaw =
    baseInicial +
    kpiCaja.ingresos +
    kpiCaja.cobrado -
    kpiCaja.retiros -
    kpiCaja.prestamos -
    kpiCaja.gastos;
  const cajaFinal = useMemo(() => Math.round(cajaFinalRaw * 100) / 100, [cajaFinalRaw]);

  const programados = programadosCount;
  const visitadosHoy = kpiCaja.abonosCount;
  const pendientes = Math.max(0, programados - visitadosHoy);

  const loading = loadingCaja || loadingProg;

  // ===== UI =====
  const disabledNext = selectedYmd >= hoy;
  const days = useMemo(() => rangeLastDays(tz, 30), [tz]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg }} edges={['left','right','bottom']}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: palette.topBorder }]}>
        <Text style={[styles.hTitle, { color: palette.text }]}>Reporte diario</Text>
      </View>

      {/* Selector de fecha */}
      <View style={[styles.dateRow, { borderBottomColor: palette.topBorder, backgroundColor: palette.topBg }]}>
        <TouchableOpacity
          style={styles.navBtn}
          onPress={() => setSelectedYmd(ymdAdd(selectedYmd, -1))}
          activeOpacity={0.8}
        >
          <Ionicons name="chevron-back" size={20} color={palette.text} />
        </TouchableOpacity>

        <TouchableOpacity onPress={() => setPickerVisible(true)} activeOpacity={0.85} style={{ alignItems: 'center' }}>
          <Text style={[styles.ymd, { color: palette.text }]}>{selectedYmd}</Text>
          <Text style={[styles.ymdSub, { color: palette.softText }]}>
            {selectedYmd === hoy ? `Hoy • ${tz}` : `Histórico • ${tz}`}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.navBtn, disabledNext && { opacity: 0.4 }]}
          onPress={() => !disabledNext && setSelectedYmd(ymdAdd(selectedYmd, +1))}
          activeOpacity={disabledNext ? 1 : 0.8}
        >
          <Ionicons name="chevron-forward" size={20} color={palette.text} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          {/* KPI Grid (todo desde cajaDiaria + cierre del día anterior) */}
          <View style={styles.grid}>
            <KpiCard label="Caja inicial" value={baseInicial} money palette={palette} />
            <KpiCard label="Cobrado" value={kpiCaja.cobrado} money palette={palette} />
            <KpiCard label="Ingresos" value={kpiCaja.ingresos} money palette={palette} />
            <KpiCard label="Retiros" value={kpiCaja.retiros} money palette={palette} />
            <KpiCard label="Préstamos (día)" value={kpiCaja.prestamos} money palette={palette} />
            <KpiCard label="Gastos admin" value={kpiCaja.gastos} money palette={palette} />
          </View>

          <View style={[styles.sep, { backgroundColor: palette.topBorder }]} />

          {/* Clientes */}
          <Card title="Clientes" palette={palette}>
            <Row label="Programados" value={programados} palette={palette} />
            <Row label="Visitados" value={visitadosHoy} palette={palette} />
            <Row label="Pendientes" value={pendientes} palette={palette} />
          </Card>

          {/* Resultado */}
          <Card title="Resultado" palette={palette}>
            <Row label="Caja final" value={money(cajaFinal)} palette={palette} />
          </Card>
        </View>
      )}

      {/* Modal: últimos 30 días */}
      <Modal visible={pickerVisible} transparent animationType="fade" onRequestClose={() => setPickerVisible(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setPickerVisible(false)} />
        <View style={[styles.pickerCard, { backgroundColor: palette.cardBg, borderColor: palette.cardBorder }]}>
          <Text style={[styles.pickerTitle, { color: palette.text }]}>Ir a fecha</Text>
          <FlatList
            data={days}
            keyExtractor={(d) => d}
            showsVerticalScrollIndicator={false}
            style={{ maxHeight: 360 }}
            renderItem={({ item }) => (
              <TouchableOpacity
                onPress={() => { setPickerVisible(false); setSelectedYmd(item); }}
                style={[styles.pickerItem, { borderBottomColor: palette.cardBorder }]}
                activeOpacity={0.8}
              >
                <Text style={{ color: palette.text, fontWeight: item === selectedYmd ? '800' : '600' }}>
                  {item}{item === hoy ? '  ·  Hoy' : ''}
                </Text>
              </TouchableOpacity>
            )}
          />
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/** ——— UI helpers ——— */
function Card({ title, children, palette }: { title: string; children: React.ReactNode; palette: any }) {
  return (
    <View style={[styles.card, { backgroundColor: palette.cardBg, borderColor: palette.cardBorder }]}>
      <Text style={[styles.cardTitle, { color: palette.softText }]}>{title}</Text>
      {children}
    </View>
  );
}
function Row({ label, value, palette }: { label: string; value: number | string; palette: any }) {
  return (
    <View style={styles.rowLine}>
      <Text style={[styles.rowLabel, { color: palette.softText }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: palette.text }]}>{String(value)}</Text>
    </View>
  );
}
function KpiCard({ label, value, money: isMoney, palette }: { label: string; value: number; money?: boolean; palette: any }) {
  const display = isMoney
    ? `R$ ${Number(value || 0).toLocaleString(DISPLAY_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : String(value);
  return (
    <View style={[styles.kpi, { backgroundColor: palette.cardBg, borderColor: palette.cardBorder }]}>
      <Text style={[styles.kpiLbl, { color: palette.softText }]}>{label}</Text>
      <Text style={[styles.kpiVal, { color: palette.text }]}>{display}</Text>
    </View>
  );
}

/** ——— Styles ——— */
const styles = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hTitle: { fontSize: 16, fontWeight: '900' },

  dateRow: {
    paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  navBtn: { padding: 6 },
  ymd: { fontSize: 17, fontWeight: '900', textAlign: 'center' },
  ymdSub: { fontSize: 12, textAlign: 'center' },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, padding: 12 },
  kpi: { width: '48%', borderWidth: 1, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12 },
  kpiLbl: { fontSize: 11, fontWeight: '700' },
  kpiVal: { fontSize: 16, fontWeight: '900', marginTop: 4 },

  sep: { height: 1, marginHorizontal: 12, marginBottom: 12, opacity: 0.8 },

  card: { marginHorizontal: 12, marginBottom: 12, borderWidth: 1, borderRadius: 12, padding: 12 },
  cardTitle: { fontSize: 12, fontWeight: '800', marginBottom: 8 },

  rowLine: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  rowLabel: { fontSize: 13, fontWeight: '700' },
  rowValue: { fontSize: 13, fontWeight: '800' },

  backdrop: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.25)' },
  pickerCard: {
    position: 'absolute', left: 20, right: 20, top: Platform.select({ ios: 120, android: 100 }),
    borderWidth: 1, borderRadius: 12, padding: 12,
  },
  pickerTitle: { fontSize: 16, fontWeight: '800', marginBottom: 8, textAlign: 'center' },
  pickerItem: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
});
