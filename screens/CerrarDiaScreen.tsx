// screens/CerrarDiaScreen.tsx (versión ajustada)
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaView, View, Text, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { useAppTheme } from '../theme/ThemeProvider';
import { db } from '../firebase/firebaseConfig';
import {
  collection,
  collectionGroup,
  doc,
  getDocs,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { pickTZ, todayInTZ, normYYYYMMDD } from '../utils/timezone';
import { ensureAperturaDeHoy, closeMissingDays } from '../utils/cajaEstado';
import { canonicalTipo } from '../utils/movimientoHelper';

type Props = NativeStackScreenProps<RootStackParamList, 'CerrarDia'>;

type Prestamo = {
  id: string;
  creadoPor: string;
  clienteId?: string;
  concepto?: string;
  valorCuota?: number;
  valorNeto?: number; // capital (sin interés)
  capital?: number;
  montoTotal?: number; // NO usar para “Préstamos”
  totalPrestamo?: number; // NO usar para “Préstamos”
  restante?: number;
  tz?: string;
  fechaInicio?: any;
  createdAt?: any;
  createdAtMs?: number;
  estado?: string;
  abonos?: { monto: number; fecha?: any; operationalDate?: string; tz?: string }[];
};

const DISPLAY_LOCALE = 'es-AR';
const TZ_DEFAULT = 'America/Sao_Paulo';
const money = (n: number) => {
  const v = Math.abs(n) < 0.005 ? 0 : n; // evita -0.00
  return `R$ ${Number(v || 0).toLocaleString(DISPLAY_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export default function CerrarDiaScreen({ route }: Props) {
  const { admin } = route.params;
  const { palette } = useAppTheme();

  const tz = pickTZ(undefined, TZ_DEFAULT);
  const hoy = todayInTZ(tz);

  const [loading, setLoading] = useState(true);
  const [prestamos, setPrestamos] = useState<Prestamo[]>([]);
  const [kpiCaja, setKpiCaja] = useState({ cobrado: 0, gastos: 0, ingresos: 0, retiros: 0 });

  // Caja inicial persistente (cajaEstado) + fallback (última apertura del día)
  const [cajaInicialPersistente, setCajaInicialPersistente] = useState<number | null>(null);
  const [aperturaDelDia, setAperturaDelDia] = useState<number>(0);

  // ====== HELPERS ======
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
    } catch { return null; }
  }
  function addDaysYMD(ymd: string, days: number, tzLocal: string) {
    const [Y, M, D] = ymd.split('-').map(n => parseInt(n, 10));
    const dt = new Date(Date.UTC(Y, (M - 1), D));
    dt.setUTCDate(dt.getUTCDate() + days);
    return formatDateToYMD(dt, tzLocal);
  }

  // —— préstamos del cobrador
  useEffect(() => {
    let unsub: undefined | (() => void);
    try {
      const qP = query(collectionGroup(db, 'prestamos'), where('creadoPor', '==', admin));
      unsub = onSnapshot(
        qP,
        (sg) => {
          const list: Prestamo[] = [];
          sg.forEach((d) => {
            const data = d.data() as any;
            const capital =
              Number(data?.valorNeto) ||
              Number(data?.capital) ||
              Number(data?.monto) ||
              Number(data?.montoPrestado) ||
              Number(data?.valorPrestamo) ||
              Number(data?.montoCapital) ||
              Number(data?.valorSinInteres) ||
              0;

            list.push({
              id: d.id,
              creadoPor: data.creadoPor,
              clienteId: data.clienteId,
              concepto: data.concepto,
              valorCuota: Number(data.valorCuota || 0),
              valorNeto: Number(data?.valorNeto ?? 0),
              capital: Number.isFinite(capital) ? capital : 0,
              montoTotal: Number(data?.montoTotal ?? 0),
              totalPrestamo: Number(data?.totalPrestamo ?? 0),
              restante: Number(data.restante || 0),
              tz: typeof data.tz === 'string' ? data.tz : undefined,
              fechaInicio: data.fechaInicio,
              createdAt: data.createdAt,
              createdAtMs: typeof data.createdAtMs === 'number' ? data.createdAtMs : undefined,
              estado: typeof data.estado === 'string' ? data.estado : 'activo',
              abonos: Array.isArray(data.abonos) ? data.abonos : [],
            });
          });
          setPrestamos(list);
          setLoading(false);
        },
        (err) => {
          console.warn('[CerrarDia] prestamos snapshot:', err?.code || err?.message || err);
          Alert.alert('Error', 'No se pudieron leer los préstamos.');
          setPrestamos([]);
          setLoading(false);
        }
      );
    } catch (e) {
      console.warn('[CerrarDia] suscripción no disponible:', e);
      setLoading(false);
    }
    return () => { try { unsub && unsub(); } catch {} };
  }, [admin]);

  // —— caja del día (KPI + última apertura del día)
  useEffect(() => {
    let unsub: undefined | (() => void);
    try {
      const qCaja = query(
        collection(db, 'cajaDiaria'),
        where('admin', '==', admin),
        where('operationalDate', '==', hoy)
      );
      unsub = onSnapshot(
        qCaja,
        (snap) => {
          let lastAperturaMonto = 0;
          let lastAperturaTs = -1;
          let cobrado = 0, ingresos = 0, retiros = 0, gastosAdmin = 0;

          snap.forEach((d) => {
            const data = d.data() as any;
            const tip = canonicalTipo(data?.tipo);
            if (!tip) return;

            const monto = Number(data?.monto ?? data?.balance ?? 0) || 0;
            const ts =
              (typeof data?.createdAtMs === 'number' && data.createdAtMs) ||
              (typeof data?.createdAt?.seconds === 'number' && data.createdAt.seconds * 1000) ||
              0;

            switch (tip) {
              case 'apertura':
                if (ts >= lastAperturaTs) { lastAperturaTs = ts; lastAperturaMonto = monto; }
                break;
              case 'abono':
                cobrado += monto; break;
              case 'ingreso':
                ingresos += monto; break;
              case 'retiro':
                retiros += monto; break;
              case 'gasto_admin':
                gastosAdmin += monto; break;
              default:
                break; // cierre y otros no suman en KPIs
            }
          });

          setAperturaDelDia(lastAperturaMonto);
          setKpiCaja({ cobrado, gastos: gastosAdmin, ingresos, retiros });
        },
        (err) => {
          console.warn('[CerrarDia] cajaDiaria snapshot:', err?.code || err?.message || err);
          setAperturaDelDia(0);
          setKpiCaja({ cobrado: 0, gastos: 0, ingresos: 0, retiros: 0 });
        }
      );
    } catch (e) {
      console.warn('[CerrarDia] suscripción cajaDiaria no disponible:', e);
    }
    return () => { try { unsub && unsub(); } catch {} };
  }, [admin, hoy]);

  // —— saldo persistente de la caja (cajaEstado/{admin})
  useEffect(() => {
    let unsub: undefined | (() => void);
    try {
      const ref = doc(db, 'cajaEstado', admin);
      unsub = onSnapshot(
        ref,
        (snap) => {
          const data = snap.data() as any;
          const saldo = Number(data?.saldoActual);
          setCajaInicialPersistente(Number.isFinite(saldo) ? saldo : null);
        },
        (err) => {
          console.warn('[cajaEstado] snapshot:', err?.code || err?.message || err);
          setCajaInicialPersistente(null);
        }
      );
    } catch (e) {
      console.warn('[cajaEstado] suscripción no disponible:', e);
      setCajaInicialPersistente(null);
    }
    return () => { try { unsub && unsub(); } catch {} };
  }, [admin]);

  // —— KPIs de clientes
  const totalProgramados = prestamos.length;
  const visitadosHoy = useMemo(() => {
    let count = 0;
    for (const p of prestamos) {
      const tzP = pickTZ(p.tz, tz);
      const hoyP = todayInTZ(tzP);
      const abonos = Array.isArray(p.abonos) ? p.abonos : [];
      const pagoHoy = abonos.some((a) => {
        const dia = a.operationalDate ?? normYYYYMMDD(a.fecha);
        return dia === hoyP;
      });
      if (pagoHoy) count++;
    }
    return count;
  }, [prestamos, tz]);
  const pendientes = Math.max(0, totalProgramados - visitadosHoy);

  // —— Fallback “Cobrado”
  const cobradoFallback = useMemo(() => {
    let total = 0;
    for (const p of prestamos) {
      const tzP = pickTZ(p.tz, tz);
      const hoyP = todayInTZ(tzP);
      for (const a of p.abonos || []) {
        const dia = a.operationalDate ?? normYYYYMMDD(a.fecha);
        if (dia === hoyP) total += Number(a.monto || 0);
      }
    }
    return total;
  }, [prestamos, tz]);
  const cobrado = kpiCaja.cobrado > 0 ? kpiCaja.cobrado : cobradoFallback;

  // —— “Préstamos” del día = suma SOLO de valorNeto/capital creado HOY
  const prestamosDelDia = useMemo(() => {
    let total = 0;
    for (const p of prestamos) {
      if (p.estado && p.estado !== 'activo') continue;
      const tzP = pickTZ(p.tz, tz);
      const startYmd = anyDateToYYYYMMDD(
        (typeof p.createdAtMs === 'number' ? p.createdAtMs : (p.createdAt ?? p.fechaInicio)),
        tzP
      );
      if (!startYmd) continue;
      if (startYmd !== todayInTZ(tzP)) continue;
      const capital = Number(p.valorNeto ?? p.capital ?? 0);
      if (Number.isFinite(capital) && capital > 0) total += capital;
    }
    return total;
  }, [prestamos, tz]);

  const ingresos = kpiCaja.ingresos;
  const retiros = kpiCaja.retiros;
  const gastos = kpiCaja.gastos; // solo gasto_admin

  // Caja Inicial mostrada = saldo persistente si existe, si no, última apertura del día
  const cajaInicial = (cajaInicialPersistente ?? aperturaDelDia) || 0;

  // —— Caja final del día
  const cajaFinalRaw = cajaInicial + ingresos + cobrado - retiros - prestamosDelDia - gastos;
  const cajaFinal = useMemo(() => Math.round(cajaFinalRaw * 100) / 100, [cajaFinalRaw]);

  // ====== SANEADOR: Cierra días pendientes y luego asegura apertura de HOY ======
  const autoCloseGuard = useRef(false);
  useEffect(() => {
    if (autoCloseGuard.current) return;
    autoCloseGuard.current = true;

    (async () => {
      // 1) Cerrar en cadena días faltantes (si no abriste la app por 1–N días)
      await closeMissingDays(admin, hoy, tz); // ← calcula KPIs y registra 'cierre' por cada día faltante

      // 2) Ahora sí, asegurar APERTURA de HOY (basada en el CIERRE inmediato anterior)
      await ensureAperturaDeHoy(admin, hoy, tz);
    })().catch((e) => {
      console.warn('[CerrarDia] auto-saneador error:', e?.message || e);
    });
  }, [admin, hoy, tz]);

  // ====== UI ======
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg }}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: palette.topBorder }]}>
        <View>
          <Text style={[styles.hTitle, { color: palette.text }]}>Reporte diario</Text>
          <Text style={[styles.hSub, { color: palette.softText }]}>{hoy} • {tz}</Text>
        </View>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          {/* KPI Grid */}
          <View style={styles.grid}>
            <KpiCard label="Caja inicial" value={cajaInicial} money palette={palette} />
            <KpiCard label="Cobrado" value={cobrado} money palette={palette} />
            <KpiCard label="Ingresos" value={ingresos} money palette={palette} />
            <KpiCard label="Retiros" value={retiros} money palette={palette} />
            <KpiCard label="Préstamos (día)" value={prestamosDelDia} money palette={palette} />
            <KpiCard label="Gastos admin" value={gastos} money palette={palette} />
          </View>

          {/* Separador */}
          <View style={[styles.sep, { backgroundColor: palette.topBorder }]} />

          {/* Clientes */}
          <Card title="Clientes" palette={palette}>
            <Row label="Programados" value={prestamos.length} palette={palette} />
            <Row label="Visitados" value={visitadosHoy} palette={palette} />
            <Row label="Pendientes" value={Math.max(0, prestamos.length - visitadosHoy)} palette={palette} />
          </Card>

          {/* Resultado */}
          <Card title="Resultado" palette={palette}>
            <Row label="Caja final" value={money(cajaFinal)} palette={palette} />
          </Card>
        </View>
      )}
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
  const display = isMoney ? `R$ ${Number(value || 0).toLocaleString(DISPLAY_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(value);
  return (
    <View style={[styles.kpi, { backgroundColor: palette.cardBg, borderColor: palette.cardBorder }]}>
      <Text style={[styles.kpiLbl, { color: palette.softText }]}>{label}</Text>
      <Text style={[styles.kpiVal, { color: palette.text }]}>{display}</Text>
    </View>
  );
}

/** ——— Styles ——— */
const styles = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hTitle: { fontSize: 16, fontWeight: '900' },
  hSub: { fontSize: 12, marginTop: 2 },

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
});
