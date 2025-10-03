// screens/CerrarDiaScreen.tsx
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
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
  limit,
} from 'firebase/firestore';
import { pickTZ, todayInTZ } from '../utils/timezone';
import { ensureAperturaDeHoy, closeMissingDays } from '../utils/cajaEstado';
import { canonicalTipo } from '../utils/movimientoHelper';

// 👇 NUEVO: helpers de fallback (sin índices)
import { onSnapshotWithFallback, getDocsWithFallback } from '../utils/firestoreFallback';

type Props = NativeStackScreenProps<RootStackParamList, 'CerrarDia'>;

const DISPLAY_LOCALE = 'es-AR';
const TZ_DEFAULT = 'America/Sao_Paulo';
const money = (n: number) =>
  `R$ ${Number(Math.abs(n) < 0.005 ? 0 : n).toLocaleString(DISPLAY_LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export default function CerrarDiaScreen({ route }: Props) {
  const { admin } = route.params;
  const { palette } = useAppTheme();

  const tz = pickTZ(undefined, TZ_DEFAULT);
  const hoy = todayInTZ(tz);

  // ===== Estado =====
  const [loadingCaja, setLoadingCaja] = useState(true);
  const [loadingProg, setLoadingProg] = useState(true);

  // KPIs 100% desde cajaDiaria
  const [kpiCaja, setKpiCaja] = useState({
    apertura: 0,
    cobrado: 0,
    ingresos: 0,
    retiros: 0,
    gastos: 0,
    prestamos: 0,
    abonosCount: 0, // 👈 visitadosHoy = cantidad de abonos del día
  });

  // Conteo “programados” (listener filtrado, ligero)
  const [programadosCount, setProgramadosCount] = useState(0);

  // Caja inicial BASE (cierre de ayer). No se actualiza durante el día.
  const [cajaInicial, setCajaInicial] = useState<number>(0);

  // ===== Helpers =====
  async function getCajaInicialUI(adminId: string, hoyYmd: string): Promise<number> {
    // AYER a partir de 'hoy'
    const [Y, M, D] = hoyYmd.split('-').map((n) => parseInt(n, 10));
    const dt = new Date(Date.UTC(Y, M - 1, D));
    dt.setUTCDate(dt.getUTCDate() - 1);
    const ayer = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
      dt.getUTCDate(),
    ).padStart(2, '0')}`;

    // 1) Preferimos cierre idempotente
    const cierreId = `cierre_${adminId}_${ayer}`;
    const cierreSnap = await getDoc(doc(db, 'cajaDiaria', cierreId));
    if (cierreSnap.exists()) return Number(cierreSnap.data()?.balance || 0);

    // 2) Último cierre “no idempotente” (compat) — con fallback sin orderBy
    const qCMain = query(
      collection(db, 'cajaDiaria'),
      where('admin', '==', adminId),
      where('operationalDate', '==', ayer),
      where('tipo', '==', 'cierre'),
      orderBy('createdAt', 'desc'),
      limit(1)
    );

    // Fallback sin orderBy; luego elegimos el más reciente client-side
    const qCFallback = query(
      collection(db, 'cajaDiaria'),
      where('admin', '==', adminId),
      where('operationalDate', '==', ayer),
      where('tipo', '==', 'cierre')
    );

    const sC = await getDocsWithFallback(qCMain, qCFallback);
    if (!sC.empty) {
      // Si vino sin orderBy, tomamos el más “reciente” manualmente
      const best = sC.docs.reduce((acc, d) => {
        const data: any = d.data();
        const ms =
          (typeof data?.createdAtMs === 'number' && data.createdAtMs) ||
          (typeof data?.createdAt?.seconds === 'number' && data.createdAt.seconds * 1000) ||
          0;
        if (!acc) return { d, ms };
        return ms > acc.ms ? { d, ms } : acc;
      }, null as null | { d: typeof sC.docs[number]; ms: number });
      const base = Number((best?.d?.data() as any)?.balance || 0);
      return Number.isFinite(base) ? base : 0;
    }

    // 3) Nada → 0
    return 0;
  }

  // —— Listener LIGERO de “programados” (préstamos activos del admin) con fallback
  useEffect(() => {
    setLoadingProg(true);

    try {
      const qPMain = query(
        collectionGroup(db, 'prestamos'),
        where('creadoPor', '==', admin),
        where('status', '==', 'activo'),
        where('restante', '>', 0)
      );

      // Fallback sin inequality/extra filtros (evita índice); filtramos client-side
      const qPFallback = query(collectionGroup(db, 'prestamos'), where('creadoPor', '==', admin));

      const unsub = onSnapshotWithFallback(
        qPMain,
        qPFallback,
        (sg) => {
          // Filtrar SIEMPRE client-side para consistencia entre main y fallback
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

      return () => {
        try { unsub(); } catch {}
      };
    } catch (e) {
      console.warn('[CerrarDia] suscripción prestamos (conteo) no disponible:', e);
      setProgramadosCount(0);
      setLoadingProg(false);
    }
  }, [admin]);

  // —— caja del día (TODOS los KPIs salen de aquí) con fallback
  useEffect(() => {
    setLoadingCaja(true);
    try {
      const qCajaMain = query(
        collection(db, 'cajaDiaria'),
        where('admin', '==', admin),
        where('operationalDate', '==', hoy),
        orderBy('createdAt', 'asc')
      );

      // Fallback sin orderBy (ordenaremos client-side por createdAtMs/createdAt)
      const qCajaFallback = query(
        collection(db, 'cajaDiaria'),
        where('admin', '==', admin),
        where('operationalDate', '==', hoy)
      );

      const unsub = onSnapshotWithFallback(
        qCajaMain,
        qCajaFallback,
        (snap) => {
          let apertura = 0;
          let aperturaTs = -1;
          let cobrado = 0;
          let ingresos = 0;
          let retiros = 0;
          let gastos = 0;
          let prestamos = 0;
          let abonosCount = 0;

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
                prestamos += monto; // capital entregado hoy
                break;
              default:
                break;
            }
          });

          setKpiCaja({ apertura, cobrado, ingresos, retiros, gastos, prestamos, abonosCount });
          setLoadingCaja(false);
        },
        (err) => {
          console.warn('[CerrarDia] cajaDiaria snapshot:', err?.code || err?.message || err);
          setKpiCaja({ apertura: 0, cobrado: 0, ingresos: 0, retiros: 0, gastos: 0, prestamos: 0, abonosCount: 0 });
          setLoadingCaja(false);
          Alert.alert('Atención', 'Si ves un enlace de índice en la consola, créalo para continuar.');
        }
      );

      return () => { try { unsub(); } catch {} };
    } catch (e) {
      console.warn('[CerrarDia] suscripción cajaDiaria no disponible:', e);
      setLoadingCaja(false);
    }
  }, [admin, hoy]);

  // —— Cargar la CAJA INICIAL (cierre de AYER) una vez por día
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const base = await getCajaInicialUI(admin, hoy);
        if (!cancelled) setCajaInicial(Number.isFinite(base) ? base : 0);
      } catch (e) {
        console.warn('[CerrarDia] getCajaInicialUI error:', e);
        if (!cancelled) setCajaInicial(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [admin, hoy]);

  // ====== SANEADOR: Cierra días pendientes y asegura apertura de HOY ======
  const autoCloseGuard = useRef(false);
  useEffect(() => {
    if (autoCloseGuard.current) return;
    autoCloseGuard.current = true;

    (async () => {
      await closeMissingDays(admin, hoy, tz);
      await ensureAperturaDeHoy(admin, hoy, tz);
    })().catch((e) => {
      console.warn('[CerrarDia] auto-saneador error:', e?.message || e);
    });
  }, [admin, hoy, tz]);

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
  const visitadosHoy = kpiCaja.abonosCount; // ✅ ahora sale de cajaDiaria
  const pendientes = Math.max(0, programados - visitadosHoy);

  const loading = loadingCaja || loadingProg;

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
          {/* KPI Grid (todo desde cajaDiaria + cierre de ayer) */}
          <View style={styles.grid}>
            <KpiCard label="Caja inicial" value={baseInicial} money palette={palette} />
            <KpiCard label="Cobrado" value={kpiCaja.cobrado} money palette={palette} />
            <KpiCard label="Ingresos" value={kpiCaja.ingresos} money palette={palette} />
            <KpiCard label="Retiros" value={kpiCaja.retiros} money palette={palette} />
            <KpiCard label="Préstamos (día)" value={kpiCaja.prestamos} money palette={palette} />
            <KpiCard label="Gastos admin" value={kpiCaja.gastos} money palette={palette} />
          </View>

          {/* Separador */}
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
            {kpiCaja.apertura > 0 && <Row label="(Apertura del día)" value={money(kpiCaja.apertura)} palette={palette} />}
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
