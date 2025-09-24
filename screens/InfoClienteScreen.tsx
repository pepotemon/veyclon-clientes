// screens/InfoClienteScreen.tsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  FlatList,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { db } from '../firebase/firebaseConfig';
import {
  doc,
  getDoc,
  getDocs,
  collection,
} from 'firebase/firestore';
import { MaterialCommunityIcons as MIcon, Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';
import { todayInTZ, normYYYYMMDD, pickTZ } from '../utils/timezone';
import { useAppTheme } from '../theme/ThemeProvider';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { calcularDiasAtraso } from '../utils/atrasoHelper';

type Props = NativeStackScreenProps<RootStackParamList, 'InfoCliente'>;

type Cliente = {
  id: string;
  alias?: string;
  direccion1?: string;
  direccion2?: string;
  telefono1?: string;
  telefono2?: string;
  genero?: 'M' | 'F' | 'O';
};

type Abono = {
  monto: number;
  fecha?: string;                 // ISO opcional
  operationalDate?: string;       // YYYY-MM-DD (preferido para “hoy”)
  tz?: string;
  registradoPor?: string;
  // 👇 extras útiles para dedupe
  createdAtMs?: number;
  fromOutboxId?: string;
  _idSubdoc?: string;             // id del doc en subcolección (si viene de ahí)
  source?: string;
};

type Prestamo = {
  id: string;
  clienteId?: string;
  concepto: string;
  cobradorId?: string;
  totalPrestamo: number;
  montoTotal?: number;
  restante: number;
  valorCuota: number;
  modalidad?: string;
  abonos: Abono[];
  tz?: string;
  fechaInicio?: string;

  // opcionales (como en Home)
  diasHabiles?: number[];
  feriados?: string[];
  pausas?: { desde: string; hasta: string; motivo?: string }[];
  modoAtraso?: 'porPresencia' | 'porCuota';
  permitirAdelantar?: boolean;
  cuotas?: number;
};

type HistorialItem = {
  id: string;
  concepto: string;
  fechaInicio?: any;
  fechaCierre?: any;
  totalPrestamo: number;
  valorNeto?: number;
  finalizadoPor?: string;
};

function fmtDate(value: any, pattern = 'dd/MM/yyyy') {
  if (!value) return '—';
  let d: Date | null = null;
  if (value?.toDate) d = value.toDate();
  else if (typeof value?.seconds === 'number') d = new Date(value.seconds * 1000);
  else if (typeof value === 'string') {
    const parsed = new Date(value);
    d = isNaN(+parsed) ? null : parsed;
  } else if (typeof value === 'number') d = new Date(value);
  if (!d || isNaN(+d)) return '—';
  return format(d, pattern);
}

const iconoPorGenero = (g?: 'F' | 'M' | 'O') => {
  if (g === 'F') return 'account-outline' as const;
  if (g === 'M') return 'account-tie' as const;
  return 'account-circle-outline' as const;
};

/** Huella estable para deduplicar un abono proveniente de distintas fuentes */
function fingerprintAbono(a: Abono) {
  const dia = a.operationalDate || (a.fecha ? normYYYYMMDD(a.fecha) : '');
  const monto2 = Number(a.monto || 0).toFixed(2);
  const ox = a.fromOutboxId || '';
  const ms = a.createdAtMs ? String(a.createdAtMs) : '';
  const iso = a.fecha || '';
  // Prefiere fromOutboxId; si no hay, usa createdAtMs; si no, ISO.
  const disambiguator = ox || ms || iso || '';
  return `d=${dia}|m=${monto2}|k=${disambiguator}`;
}

export default function InfoClienteScreen({ route, navigation }: Props) {
  const { clienteId, nombreCliente, admin } = route.params;
  const { palette } = useAppTheme();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [cliente, setCliente] = useState<Cliente | null>(null);
  const [prestamosActivos, setPrestamosActivos] = useState<Prestamo[]>([]);
  const [historial, setHistorial] = useState<HistorialItem[]>([]);

  const hoySession = useMemo(() => todayInTZ('America/Sao_Paulo'), []);

  useEffect(() => {
    const cargar = async () => {
      try {
        setLoading(true);

        // 1) Doc cliente
        const cSnap = await getDoc(doc(db, 'clientes', clienteId));
        const cData = cSnap.exists() ? ({ id: cSnap.id, ...(cSnap.data() as any) } as Cliente) : null;
        setCliente(cData);

        // 2) Préstamos activos (base)
        const pSnap = await getDocs(collection(db, 'clientes', clienteId, 'prestamos'));
        const activosBase: Prestamo[] = [];
        pSnap.forEach((d) => {
          const data = d.data() as any;
          const legacyArr = Array.isArray(data.abonos) ? data.abonos : [];
          // normalizar legacy con extras por si están
          const legacyNorm: Abono[] = legacyArr.map((a: any) => ({
            monto: Number(a?.monto || 0),
            operationalDate: a?.operationalDate,
            fecha: a?.fecha, // podría venir ISO en algunos históricos
            tz: a?.tz,
            registradoPor: a?.registradoPor || a?.creadoPor,
            createdAtMs: typeof a?.createdAtMs === 'number' ? a.createdAtMs : undefined,
            fromOutboxId: a?.fromOutboxId,
            source: a?.source,
          }));

          activosBase.push({
            id: d.id,
            clienteId,
            concepto: (data.concepto ?? '').trim() || 'Sin nombre',
            totalPrestamo: Number(data.totalPrestamo ?? data.montoTotal ?? 0),
            restante: Number(data.restante ?? 0),
            valorCuota: Number(data.valorCuota ?? 0),
            modalidad: data.modalidad ?? 'Diaria',
            abonos: legacyNorm, // legacy normalizado
            tz: data.tz || 'America/Sao_Paulo',
            fechaInicio: data.fechaInicio,

            diasHabiles: Array.isArray(data.diasHabiles) ? data.diasHabiles : undefined,
            feriados: Array.isArray(data.feriados) ? data.feriados : undefined,
            pausas: Array.isArray(data.pausas) ? data.pausas : undefined,
            modoAtraso: data.modoAtraso,
            permitirAdelantar: !!data.permitirAdelantar,
            cuotas: typeof data.cuotas === 'number' ? data.cuotas : undefined,
          });
        });

        // 2.b) Completar con subcolección 'abonos' y DEDUPLICAR
        const activos: Prestamo[] = await Promise.all(
          activosBase.map(async (p) => {
            try {
              const subSnap = await getDocs(
                collection(db, 'clientes', clienteId, 'prestamos', p.id, 'abonos')
              );
              const fromSub: Abono[] = subSnap.docs.map((dd) => {
                const a = dd.data() as any;
                const createdMs =
                  typeof a?.createdAt?.seconds === 'number'
                    ? a.createdAt.seconds * 1000
                    : (typeof a?.createdAtMs === 'number' ? a.createdAtMs : undefined);
                const fechaIso = createdMs ? new Date(createdMs).toISOString() : undefined;

                return {
                  monto: Number(a?.monto || 0),
                  operationalDate: a?.operationalDate, // YYYY-MM-DD
                  fecha: fechaIso,                     // ISO (para orden)
                  tz: a?.tz,
                  // ✅ leer el campo correcto:
                  registradoPor: a?.registradoPor || a?.creadoPor,
                  createdAtMs: typeof a?.createdAtMs === 'number' ? a.createdAtMs : createdMs,
                  fromOutboxId: a?.fromOutboxId,
                  source: a?.source,
                  _idSubdoc: dd.id,
                } as Abono;
              });

              // MERGE + DEDUPE: preferimos subcolección ante choque
              const byKey = new Map<string, Abono>();

              // Primero legacy
              for (const a of p.abonos || []) {
                const k = fingerprintAbono(a);
                byKey.set(k, a);
              }
              // Luego subcolección (pisan a legacy si coincide huella)
              for (const a of fromSub) {
                const k = fingerprintAbono(a);
                byKey.set(k, a);
              }

              const merged = Array.from(byKey.values());

              // Ordenar por fecha con preferencia a operationalDate, luego createdAtMs, luego ISO
              merged.sort((a, b) => {
                const aDia = a.operationalDate ? Date.parse(a.operationalDate + 'T12:00:00Z') : NaN;
                const bDia = b.operationalDate ? Date.parse(b.operationalDate + 'T12:00:00Z') : NaN;

                const aTime =
                  (isFinite(aDia) ? aDia : 0) ||
                  (typeof a.createdAtMs === 'number' ? a.createdAtMs : 0) ||
                  (a.fecha ? Date.parse(a.fecha) : 0);

                const bTime =
                  (isFinite(bDia) ? bDia : 0) ||
                  (typeof b.createdAtMs === 'number' ? b.createdAtMs : 0) ||
                  (b.fecha ? Date.parse(b.fecha) : 0);

                return bTime - aTime;
              });

              return { ...p, abonos: merged };
            } catch {
              // si falla subcolección, seguimos con legacy
              return p;
            }
          })
        );

        setPrestamosActivos(activos);

        // 3) Historial de préstamos
        const hSnap = await getDocs(collection(db, 'clientes', clienteId, 'historialPrestamos'));
        const hist: HistorialItem[] = [];
        hSnap.forEach((d) => {
          const data = d.data() as any;
          if (!admin || data?.finalizadoPor === admin) {
            hist.push({
              id: d.id,
              concepto: data.concepto ?? 'Sin nombre',
              fechaInicio: data.fechaInicio,
              fechaCierre: data.finalizadoEn,
              totalPrestamo: Number(data.totalPrestamo ?? data.montoTotal ?? 0),
              valorNeto: Number(data.valorNeto ?? 0),
              finalizadoPor: data.finalizadoPor,
            });
          }
        });
        hist.sort((a, b) => (b?.fechaCierre?.seconds || 0) - (a?.fechaCierre?.seconds || 0));
        setHistorial(hist);
      } catch (e) {
        console.error('❌ Error cargando InfoCliente:', e);
        Alert.alert('Error', 'No fue posible cargar la información del cliente.');
      } finally {
        setLoading(false);
      }
    };

    cargar();
  }, [clienteId, admin]);

  // abonos de hoy (por préstamo)
  const abonosHoyDe = (p: Prestamo) => {
    const tz = pickTZ(p.tz, 'America/Sao_Paulo');
    const hoy = todayInTZ(tz);
    return (p.abonos || []).filter((a) => {
      const dia = a.operationalDate ?? normYYYYMMDD(a.fecha);
      return dia === hoy;
    });
  };

  // KPIs por préstamo (mismos criterios que en Home)
  const kpisDePrestamo = (p: Prestamo) => {
    const tz = pickTZ(p.tz, 'America/Sao_Paulo');
    const hoy = todayInTZ(tz);

    const diasHabiles =
      Array.isArray(p?.diasHabiles) && p.diasHabiles.length
        ? p.diasHabiles
        : [1, 2, 3, 4, 5, 6];
    const feriados = Array.isArray(p?.feriados) ? p.feriados : [];
    const pausas = Array.isArray(p?.pausas) ? p.pausas : [];
    const cuotas =
      Number(p?.cuotas || 0) ||
      Math.ceil(
        Number(p.totalPrestamo || p.montoTotal || 0) / (Number(p.valorCuota) || 1)
      );

    const abonosNorm = (p.abonos || []).map((a) => ({
      monto: Number(a.monto) || 0,
      operationalDate: a.operationalDate,
      fecha: a.fecha,
    }));

    const pres = calcularDiasAtraso({
      fechaInicio: p.fechaInicio || hoy,
      hoy,
      cuotas,
      valorCuota: Number(p.valorCuota || 0),
      abonos: abonosNorm,
      diasHabiles,
      feriados,
      pausas,
      modo: (p?.modoAtraso as any) === 'porCuota' ? 'porCuota' : 'porPresencia',
      permitirAdelantar: !!p?.permitirAdelantar,
    });

    const cuota = calcularDiasAtraso({
      fechaInicio: p.fechaInicio || hoy,
      hoy,
      cuotas,
      valorCuota: Number(p.valorCuota || 0),
      abonos: abonosNorm,
      diasHabiles,
      feriados,
      pausas,
      modo: 'porCuota',
      permitirAdelantar: true,
    });

    return {
      diasAtraso: Number(pres?.atraso || 0),
      cuotasVencidas: Math.max(0, Array.isArray(cuota?.faltas) ? cuota.faltas.length : 0),
    };
  };

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: palette.screenBg,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
      }}
    >
      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder },
        ]}
      >
        <Ionicons name="information-circle-outline" size={22} color={palette.accent} />
        <Text style={[styles.headerTitle, { color: palette.text }]}>Info completa</Text>
        <View style={{ width: 22 }} />
      </View>

      {loading ? (
        <ActivityIndicator size="large" style={{ marginTop: 32 }} />
      ) : !cliente ? (
        <View style={{ alignItems: 'center', marginTop: 24 }}>
          <Text style={{ color: palette.softText }}>Cliente no encontrado.</Text>
        </View>
      ) : (
        <FlatList
          data={[{ key: 'info' }]}
          contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}
          renderItem={() => (
            <View style={{ padding: 12 }}>
              {/* Card: Cliente */}
              <View
                style={[
                  styles.card,
                  { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
                ]}
              >
                <View style={styles.cardHeader}>
                  <MIcon name={iconoPorGenero(cliente?.genero)} size={36} color={palette.accent} />
                  <View style={{ marginLeft: 10, flex: 1 }}>
                    <Text style={[styles.title, { color: palette.text }]}>
                      {nombreCliente || 'Cliente'}
                    </Text>
                    {!!cliente.alias && (
                      <Text style={[styles.sub, { color: palette.softText }]}>{cliente.alias}</Text>
                    )}
                  </View>
                </View>

                {!!cliente.telefono1 && (
                  <Text style={[styles.line, { color: palette.softText }]}>
                    <MIcon name="phone" size={14} color={palette.softText} />  {cliente.telefono1}
                  </Text>
                )}
                {!!cliente.telefono2 && (
                  <Text style={[styles.line, { color: palette.softText }]}>
                    <MIcon name="phone-outline" size={14} color={palette.softText} />  {cliente.telefono2}
                  </Text>
                )}
                {!!cliente.direccion1 && (
                  <Text style={[styles.line, { color: palette.softText }]}>
                    <MIcon name="map-marker" size={14} color={palette.softText} />  {cliente.direccion1}
                  </Text>
                )}
                {!!cliente.direccion2 && (
                  <Text style={[styles.line, { color: palette.softText }]}>
                    <MIcon name="map-marker-outline" size={14} color={palette.softText} />  {cliente.direccion2}
                  </Text>
                )}
              </View>

              {/* Card: Préstamos activos */}
              <View
                style={[
                  styles.card,
                  { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
                ]}
              >
                <View style={styles.cardHeaderRow}>
                  <MIcon name="cash-multiple" size={20} color={palette.accent} />
                  <Text style={[styles.cardTitle, { color: palette.text }]}>Préstamos activos</Text>
                  <Text
                    style={[
                      styles.pill,
                      { backgroundColor: palette.topBg, color: palette.accent, borderColor: palette.topBorder, borderWidth: 1 },
                    ]}
                  >
                    {prestamosActivos.length}
                  </Text>
                </View>

                {prestamosActivos.length === 0 ? (
                  <Text style={[styles.empty, { color: palette.softText }]}>No hay préstamos activos.</Text>
                ) : (
                  prestamosActivos.map((p) => {
                    const abHoy = abonosHoyDe(p);
                    const { cuotasVencidas, diasAtraso } = kpisDePrestamo(p);

                    return (
                      <View
                        key={p.id}
                        style={[
                          styles.loanBox,
                          { borderColor: palette.cardBorder, backgroundColor: palette.kpiBg },
                        ]}
                      >
                        <Text style={[styles.loanName, { color: palette.text }]}>{p.concepto}</Text>
                        <Text style={[styles.loanMeta, { color: palette.softText }]}>
                          Modalidad: {p.modalidad || 'Diaria'} • Cuota: R$ {Number(p.valorCuota || 0).toFixed(2)}
                        </Text>
                        <Text style={[styles.loanMeta, { color: palette.softText }]}>
                          Saldo{' '}
                          <Text style={[styles.kpiStrong, { color: palette.text }]}>
                            R$ {Number(p.restante || 0).toFixed(2)}
                          </Text>
                        </Text>
                        {!!p.fechaInicio && (
                          <Text style={[styles.loanMeta, { color: palette.softText }]}>
                            Inicio: {fmtDate(p.fechaInicio)}
                          </Text>
                        )}

                        <View style={styles.badgesRow}>
                          <Text
                            style={[
                              styles.badge,
                              { backgroundColor: palette.topBg, color: palette.text, borderColor: palette.topBorder, borderWidth: 1 },
                            ]}
                          >
                            {p.modalidad || 'Diaria'}
                          </Text>
                          <Text
                            style={[
                              styles.badge,
                              { backgroundColor: palette.topBg, color: palette.accent, borderColor: palette.topBorder, borderWidth: 1 },
                            ]}
                          >
                            Abonos hoy: {abHoy.length}
                          </Text>

                          <Text
                            style={[
                              styles.badge,
                              { backgroundColor: palette.topBg, color: '#C62828', borderColor: palette.topBorder, borderWidth: 1 },
                            ]}
                          >
                            Vencidas: {cuotasVencidas}
                          </Text>
                          <Text
                            style={[
                              styles.badge,
                              { backgroundColor: palette.topBg, color: '#1565C0', borderColor: palette.topBorder, borderWidth: 1 },
                            ]}
                          >
                            Atraso: {diasAtraso} d
                          </Text>
                        </View>

                        <View style={styles.rowActions}>
                          <TouchableOpacity
                            activeOpacity={0.9}
                            style={[styles.btn, { backgroundColor: palette.accent }]}
                            onPress={() => {
                              const abonosCompat = (p.abonos || []).map((a: any) => ({
                                monto: Number(a.monto) || 0,
                                // preferimos operationalDate para la UI diaria; si no, ISO → YYYY-MM-DD
                                fecha: a.operationalDate ?? normYYYYMMDD(a.fecha) ?? hoySession,
                              }));
                              navigation.navigate('HistorialPagos', {
                                abonos: abonosCompat,
                                nombreCliente: p.concepto ?? 'Cliente',
                                valorCuota: p.valorCuota,
                                totalPrestamo: p.totalPrestamo,
                              });
                            }}
                          >
                            <Text style={[styles.btnTxt, { color: '#fff' }]}>Historial de pagos</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>

              {/* Card: Historial de préstamos finalizados */}
              <View
                style={[
                  styles.card,
                  { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
                ]}
              >
                <View style={styles.cardHeaderRow}>
                  <MIcon name="file-document" size={20} color={palette.accent} />
                  <Text style={[styles.cardTitle, { color: palette.text }]}>Historial de préstamos</Text>
                </View>

                {historial.length === 0 ? (
                  <Text style={[styles.empty, { color: palette.softText }]}>No hay préstamos finalizados.</Text>
                ) : (
                  <>
                    {historial.slice(0, 3).map((h) => (
                      <TouchableOpacity
                        key={h.id}
                        activeOpacity={0.9}
                        onPress={() =>
                          navigation.navigate('DetalleHistorialPrestamo', {
                            clienteId,
                            historialId: h.id,
                            nombreCliente: h.concepto,
                          })
                        }
                        style={[
                          styles.histRow,
                          { borderColor: palette.cardBorder, backgroundColor: palette.kpiBg },
                        ]}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.histName, { color: palette.text }]}>{h.concepto}</Text>
                          <Text style={[styles.histMeta, { color: palette.softText }]}>
                            {fmtDate(h.fechaInicio)} → {fmtDate(h.fechaCierre)}
                          </Text>
                        </View>
                        <Text style={[styles.histTotal, { color: palette.text }]}>
                          R$ {Number(h.totalPrestamo || 0).toFixed(2)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity
                      activeOpacity={0.9}
                      onPress={() =>
                        navigation.navigate('HistorialPrestamos', {
                          clienteId,
                          nombreCliente: nombreCliente || cliente?.alias || 'Cliente',
                          admin,
                        })
                      }
                      style={{ marginTop: 8, alignSelf: 'flex-start' }}
                    >
                      <Text style={[styles.link, { color: palette.accent }]}>ver todo</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    gap: 8,
  },
  headerTitle: { fontSize: 18, fontWeight: '800' },

  card: {
    borderRadius: 12,
    padding: 14,
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    marginBottom: 12,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  title: { fontSize: 16, fontWeight: '800' },
  sub: { fontSize: 12, marginTop: 2 },

  line: { fontSize: 13, marginTop: 6 },

  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  cardTitle: { fontSize: 15, fontWeight: '800', flex: 1 },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: 'hidden',
  },

  loanBox: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginTop: 8,
  },
  loanName: { fontSize: 14, fontWeight: '800' },
  loanMeta: { fontSize: 12, marginTop: 4 },

  badgesRow: { flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  badge: {
    fontSize: 11,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    overflow: 'hidden',
  },

  rowActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  btn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  btnTxt: { fontWeight: '800' },
  kpiStrong: { fontWeight: '900' },

  empty: { fontStyle: 'italic', paddingVertical: 4 },

  histRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginTop: 8,
    gap: 10,
  },
  histName: { fontSize: 14, fontWeight: '800' },
  histMeta: { fontSize: 12, marginTop: 2 },
  histTotal: { fontSize: 12, fontWeight: '800' },

  link: {
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
});
