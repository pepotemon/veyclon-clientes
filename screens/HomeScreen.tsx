// screens/HomeScreen.tsx
import React, { useEffect, useMemo, useState, useCallback, useRef, useTransition } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  FlatList,
  Alert,
  ScrollView,
  InteractionManager,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { db } from '../firebase/firebaseConfig';
import {
  collection,
  collectionGroup,
  onSnapshot,
  doc,
  updateDoc,
  serverTimestamp,
  addDoc,
  query,
  where,
} from 'firebase/firestore';
import { todayInTZ, normYYYYMMDD, pickTZ } from '../utils/timezone';
import { calcularDiasAtraso } from '../utils/atrasoHelper';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ModalRegistroPago from '../components/ModalRegistroPago';
import ModalNoPago from '../components/ModalNoPago';
import { MaterialCommunityIcons as MIcon } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from '../theme/ThemeProvider';
import { logAudit, pick } from '../utils/auditLogs';
// Outbox (icono de reenviar si hay pendientes)
import { subscribeCount, subscribeOutbox } from '../utils/outbox';
import { addToOutbox } from '../utils/outbox';

// Badges: cuotas y presencia
import { computeQuotaBadge, computePresenceBadge } from '../utils/alerts';

// 👇 NUEVO: Modal de WhatsApp
import WhatsModal from '../components/WhatsModal';

// 👇 NUEVO: Cache de catálogos (lo mantenemos best-effort)
import { saveCatalogSnapshot, loadCatalogSnapshot } from '../utils/catalogCache';

// 🆕 Ruta (asegurar/usar orden)
import { ensureRouteOrder, loadRutaOrder } from '../utils/ruta';
import { useFocusEffect } from '@react-navigation/native';

// ✅ NUEVO: saneador de caja (cierra días faltantes y asegura apertura de hoy)
import { closeMissingDays, ensureAperturaDeHoy } from '../utils/cajaEstado';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

type Abono = {
  monto: number;
  fecha?: string;
  operationalDate?: string;
  tz?: string;
  registradoPor?: string;
};

type Prestamo = {
  id: string;
  clienteId?: string;
  concepto: string;
  cobradorId: string;
  montoTotal: number;
  restante: number;
  abonos: Abono[];
  totalPrestamo: number;
  creadoPor: string;
  valorCuota: number;
  modalidad?: string;

  // denormalizados (del propio préstamo)
  clienteAlias?: string;
  clienteDireccion1?: string;
  clienteDireccion2?: string;
  clienteTelefono1?: string;

  tz?: string;
  fechaInicio?: string;
  creadoEn?: any;
  createdAtMs?: number;
  diasHabiles?: number[];
  feriados?: string[];
  pausas?: { desde: string; hasta: string; motivo?: string }[];
  modoAtraso?: 'porPresencia' | 'porCuota';
  permitirAdelantar?: boolean;
  cuotas?: number;
  diasAtraso?: number;
  faltas?: string[];
  status?: 'activo' | 'cerrado' | 'pausado';
};

export default function HomeScreen({ route, navigation }: Props) {
  // 🔐 admin en estado (puede venir por params o por AsyncStorage)
  const [admin, setAdmin] = useState<string | undefined>(route.params?.admin);

  const tzSession = 'America/Sao_Paulo';
  const { palette, isDark, toggleTheme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const COMM_H = 56;

  // ======== Estado ========
  const [prestamosRaw, setPrestamosRaw] = useState<Prestamo[]>([]);
  const [cargando, setCargando] = useState(true);
  const [cargaPrestamosOk, setCargaPrestamosOk] = useState<boolean | null>(null);

  // 👇 NUEVO: flags de carga para snapshot + cache
  const [prestamosLoaded, setPrestamosLoaded] = useState(false);
  const [ultimaActualizacion, setUltimaActualizacion] = useState<number | null>(null);

  const [idx, setIdx] = useState(0);
  const [visitadosHoy, setVisitadosHoy] = useState<string[]>([]);
  const [omitidosHoy, setOmitidosHoy] = useState<string[]>([]);
  const [hoyApp, setHoyApp] = useState(todayInTZ(tzSession));

  const [faltasOpen, setFaltasOpen] = useState(false);
  const [faltasData, setFaltasData] = useState<string[]>([]);
  const [modalPagoVisible, setModalPagoVisible] = useState(false);

  const [noPagoOpen, setNoPagoOpen] = useState(false);
  const [noPagoSaving, setNoPagoSaving] = useState(false);

  // Outbox
  const [outboxCount, setOutboxCount] = useState(0);
  const showResendIcon = outboxCount > 0;

  // 💰 Caja diaria KPI
  const [cobradoHoy, setCobradoHoy] = useState(0);
  const [tieneCajaSnapshot, setTieneCajaSnapshot] = useState(false);
  const [cajaVisitados, setCajaVisitados] = useState<Set<string>>(new Set());

  // 🔄 Refresh manual
  const [refreshKey, setRefreshKey] = useState(0);
  const handleManualRefresh = () => {
    setCargando(true);
    startTransition(() => setRefreshKey((k) => k + 1));
  };

  // ⬇️ NUEVO: ids de clientes ordenados guardados por EnrutarClientes
  const [routeOrderIds, setRouteOrderIds] = useState<string[]>([]);

  // ⬇️ NUEVO: transiciones no bloqueantes
  const [isPending, startTransition] = useTransition();

  // ✅ Asegura sesión/admin si no vino por params; si no hay sesión → Login
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        try {
          if (route.params?.admin) {
            setAdmin(route.params.admin);
            return;
          }

          const u = await AsyncStorage.getItem('usuarioSesion');
          if (!alive) return;

          if (!u) {
            navigation.reset({ index: 0, routes: [{ name: 'Login' as any }] });
            return;
          }

          setAdmin(u);
          navigation.setParams({ admin: u } as any);
        } catch {
          navigation.reset({ index: 0, routes: [{ name: 'Login' as any }] });
        }
      })();

      return () => { alive = false; };
    }, [navigation, route.params?.admin])
  );

  useEffect(() => {
    let unsubEvt: (() => void) | null = null;
    try {
      unsubEvt = subscribeOutbox(() => {
        setRefreshKey((k) => k + 1);
      });
    } catch {
      unsubEvt = null;
    }

    const unsubCount = subscribeCount((n) => {
      setOutboxCount((prev) => {
        if (n !== prev) setRefreshKey((k) => k + 1);
        return n;
      });
    });

    return () => {
      if (unsubEvt) unsubEvt();
      unsubCount && unsubCount();
    };
  }, []);

  const { storageKeyV, storageKeyO } = useMemo(() => {
    const d = hoyApp;
    return {
      storageKeyV: `home:${admin}:${d}:visitados`,
      storageKeyO: `home:${admin}:${d}:omitidos`,
    };
  }, [admin, hoyApp]);

  useEffect(() => {
    if (!admin) return;

    const loadLists = async () => {
      const oldV = await AsyncStorage.getItem('visitadosHoy');
      const oldO = await AsyncStorage.getItem('omitidosHoy');
      if (oldV) { await AsyncStorage.setItem(storageKeyV, oldV); await AsyncStorage.removeItem('visitadosHoy'); }
      if (oldO) { await AsyncStorage.setItem(storageKeyO, oldO); await AsyncStorage.removeItem('omitidosHoy'); }

      const [v, o] = await Promise.all([
        AsyncStorage.getItem(storageKeyV),
        AsyncStorage.getItem(storageKeyO),
      ]);
      setVisitadosHoy(v ? JSON.parse(v) : []);
      setOmitidosHoy(o ? JSON.parse(o) : []);
    };
    loadLists();
  }, [admin, storageKeyV, storageKeyO]);

  useEffect(() => {
    const id = setInterval(() => {
      const t = todayInTZ(tzSession);
      if (t !== hoyApp) setHoyApp(t);
    }, 60_000);
    return () => clearInterval(id);
  }, [hoyApp]);

  useEffect(() => {
    // @ts-ignore — tu tipo Home ya lo ampliamos con refreshToken?: number
    const token = route.params?.refreshToken;
    if (token) {
      handleManualRefresh();
      navigation.setParams({ refreshToken: undefined } as any);
    }
  }, [route.params?.refreshToken]);

  // 🆕 asegurar que exista routeOrder persistido (best-effort)
  useEffect(() => {
    if (!admin) return;
    (async () => {
      try { await ensureRouteOrder(admin); } catch (e) { console.warn('[ensureRouteOrder]', e); }
    })();
  }, [admin, refreshKey]);

  // 🆕 cargar orden de ruta al enfocar la pantalla
  useFocusEffect(
    React.useCallback(() => {
      let alive = true;
      (async () => {
        if (!admin) return;
        try {
          const ids = await loadRutaOrder(admin);
          if (alive) setRouteOrderIds(ids);
        } catch (e) {
          console.warn('[loadRutaOrder]', e);
        }
      })();
      return () => { alive = false; };
    }, [admin])
  );

  // 👇 NUEVO: Hidratar desde cache al iniciar (prestamos solamente)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!admin) return;
        const snap = await loadCatalogSnapshot(admin);
        if (alive && snap) {
          startTransition(() => {
            setPrestamosRaw(Array.isArray(snap.prestamos) ? (snap.prestamos as any) : []);
            setUltimaActualizacion(snap.ts || Date.now());
          });
        }
      } catch {
        // ignore cache errors
      }
    })();
    return () => { alive = false; };
  }, [admin]);

  // 🧾 Suscripción a cajaDiaria para KPI
  useEffect(() => {
    if (!admin) return;

    setTieneCajaSnapshot(false);
    setCobradoHoy(0);
    setCajaVisitados(new Set());

    try {
      const qCaja = query(
        collection(db, 'cajaDiaria'),
        where('admin', '==', admin),
        where('operationalDate', '==', hoyApp)
      );
      const unsub = onSnapshot(
        qCaja,
        (snap) => {
          let total = 0;
          const ids = new Set<string>();

          snap.forEach((d) => {
            const data = d.data() as any;
            const m = Number(data?.monto || 0);
            const tipo = String(data?.tipo || '');
            if (tipo === 'abono' && Number.isFinite(m)) {
              total += m;
              const pid = typeof data?.prestamoId === 'string' ? data.prestamoId : undefined;
              if (pid) ids.add(pid);
            }
          });

          setCobradoHoy(total);
          setCajaVisitados(ids);
          setTieneCajaSnapshot(true);
        },
        (err) => {
          console.warn('[cajaDiaria] snapshot error:', err?.code || err?.message || err);
        }
      );
      return () => unsub();
    } catch (e) {
      console.warn('[cajaDiaria] suscripción no disponible:', e);
      return () => {};
    }
  }, [admin, hoyApp, refreshKey]);

  // 🔐 Suscripción a préstamos del admin
  useEffect(() => {
    if (!admin) return;

    let unsub: (() => void) | undefined;
    let cancelled = false;

    const suscribir = () => {
      setCargando(true);
      setCargaPrestamosOk(null);
      setPrestamosLoaded(false);

      try {
        const qPrestamos = query(
          collectionGroup(db, 'prestamos'),
          where('creadoPor', '==', admin),
          where('restante', '>', 0)
        );

        unsub = onSnapshot(
          qPrestamos,
          (sg) => {
            const lista: Prestamo[] = [];
            sg.forEach((docSnap) => {
              const data = docSnap.data() as any;
              const st: any = data?.status;
              if (st && st !== 'activo') return;

              lista.push({
                id: docSnap.id,
                concepto: (data.concepto ?? '').trim() || 'Sin nombre',
                cobradorId: data.cobradorId ?? '',
                montoTotal: data.montoTotal ?? data.totalPrestamo ?? 0,
                totalPrestamo: data.totalPrestamo ?? data.montoTotal ?? 0,
                restante: data.restante ?? 0,
                abonos: Array.isArray(data.abonos) ? data.abonos : [],
                creadoPor: data.creadoPor ?? '',
                valorCuota: data.valorCuota ?? 0,
                modalidad: data.modalidad ?? 'Diaria',
                clienteId: data.clienteId,
                clienteAlias: data.clienteAlias ?? data.clienteNombre ?? '',
                clienteDireccion1: data.clienteDireccion1 ?? '',
                clienteDireccion2: data.clienteDireccion2 ?? '',
                clienteTelefono1: data.clienteTelefono1 ?? '',
                tz: data.tz || 'America/Sao_Paulo',
                fechaInicio: data.fechaInicio,
                creadoEn: data.creadoEn,
                createdAtMs: data.createdAtMs,
                diasHabiles: data.diasHabiles,
                feriados: data.feriados,
                pausas: data.pausas,
                modoAtraso: data.modoAtraso,
                permitirAdelantar: data.permitirAdelantar,
                cuotas: data.cuotas,
                diasAtraso: data.diasAtraso,
                faltas: data.faltas,
                status: data.status,
              });
            });

            startTransition(() => {
              setPrestamosRaw(lista);
              setPrestamosLoaded(true);
              setCargando(false);
              setCargaPrestamosOk(true);
            });

            InteractionManager.runAfterInteractions(() => {
              if (cancelled) return;

              (async () => {
                const candidatos = [...lista]
                  .sort((a, b) => Number(b.restante || 0) - Number(a.restante || 0))
                  .slice(0, 10);

                for (const p of candidatos) {
                  if (cancelled) break;
                  try {
                    const hoyLocal = todayInTZ(pickTZ(p?.tz, tzSession));
                    const diasHabiles =
                      Array.isArray(p?.diasHabiles) && p.diasHabiles.length
                        ? p.diasHabiles
                        : [1, 2, 3, 4, 5, 6];
                    const feriados = Array.isArray(p?.feriados) ? p.feriados : [];
                    const pausas = Array.isArray(p?.pausas) ? p?.pausas : [];
                    const modo = (p?.modoAtraso as 'porPresencia' | 'porCuota') ?? 'porPresencia';
                    const permitirAdelantar = !!p?.permitirAdelantar;
                    const cuotas =
                      Number(p?.cuotas || 0) ||
                      Math.ceil(
                        Number(p.totalPrestamo || p.montoTotal || 0) / (Number(p.valorCuota) || 1)
                      );

                    const calc = calcularDiasAtraso({
                      fechaInicio: p?.fechaInicio || hoyLocal,
                      hoy: hoyLocal,
                      cuotas,
                      valorCuota: Number(p?.valorCuota || 0),
                      abonos: (p?.abonos || []).map((a: any) => ({
                        monto: Number(a.monto) || 0,
                        operationalDate: a.operationalDate,
                        fecha: a.fecha,
                      })),
                      diasHabiles,
                      feriados,
                      pausas,
                      modo,
                      permitirAdelantar,
                    });

                    if (calc.atraso !== Number(p.diasAtraso ?? -1)) {
                      const ref = doc(db, 'clientes', p.clienteId!, 'prestamos', p.id);
                      await updateDoc(ref, {
                        diasAtraso: calc.atraso,
                        faltas: calc.faltas || [],
                        ultimaReconciliacion: serverTimestamp(),
                      });
                    }
                  } catch {
                    // best-effort
                  }
                }
              })();
            });
          },
          (err) => {
            console.warn('[prestamos] snapshot error:', err?.code || err?.message || err);
            setCargando(false);
            setCargaPrestamosOk(false);
            setPrestamosRaw([]);
            setPrestamosLoaded(false);
            Alert.alert(
              'Lectura de préstamos',
              'No se pudieron cargar los préstamos (revisa reglas o índices de Firestore).'
            );
          }
        );
      } catch (e) {
        console.warn('[prestamos] suscripción no disponible:', e);
        setCargando(false);
        setCargaPrestamosOk(false);
        setPrestamosLoaded(false);
      }
    };

    suscribir();
    return () => {
      cancelled = true;
      try { unsub && unsub(); } catch {}
    };
  }, [admin, tzSession]);

  // ✅ Guardar snapshot en cache cuando prestamos estén listos
  useEffect(() => {
    if (!admin) return;
    if (!prestamosLoaded) return;
    void (async () => {
      try {
        await saveCatalogSnapshot(admin, { clientes: [], prestamos: prestamosRaw as any });
        setUltimaActualizacion(Date.now());
      } catch {
        // ignore
      }
    })();
  }, [admin, prestamosLoaded, prestamosRaw]);

  // ✅ saneador de caja (una vez)
  const saneadorOnce = useRef(false);
  useEffect(() => {
    if (!admin || saneadorOnce.current) return;
    saneadorOnce.current = true;

    (async () => {
      try {
        const tz = pickTZ(undefined, tzSession);
        const hoy = todayInTZ(tz);
        await closeMissingDays(admin, hoy, tz, 7);
        await ensureAperturaDeHoy(admin, hoy, tz);
      } catch (e: any) {
        console.warn('[Home] saneador error:', e?.message || e);
      }
    })();
  }, [admin, tzSession]);

  // 🔄 No mergeamos con /clientes — usamos los campos denormalizados del propio préstamo
  const prestamos = useMemo(() => prestamosRaw, [prestamosRaw]);

  const prestamosAdmin = useMemo(() => prestamos, [prestamos]);

  // 🆕 Orden con ruta
  const orderedPrestamosAdmin = useMemo(() => {
    const BIG = 1e9;
    const pos = new Map<string, number>(routeOrderIds.map((id, i) => [id, i]));
    return [...prestamosAdmin].sort((a, b) => {
      const pa = a.clienteId ? (pos.has(a.clienteId) ? (pos.get(a.clienteId) as number) : BIG) : BIG;
      const pb = b.clienteId ? (pos.has(b.clienteId) ? (pos.get(b.clienteId) as number) : BIG) : BIG;
      if (pa !== pb) return pa - pb;

      return (a.concepto || '').localeCompare(b.concepto || '');
    });
  }, [prestamosAdmin, routeOrderIds]);

  function esVisitadoHoy(p: Prestamo, tzFallback = tzSession, hoyStr?: string) {
    if (cajaVisitados.has(p.id)) return true;
    const tzPrestamo = pickTZ(p.tz, tzFallback);
    const hoyPrestamo = hoyStr ?? todayInTZ(tzPrestamo);
    return (
      Array.isArray(p.abonos) &&
      p.abonos.some((a) => {
        const dia = a.operationalDate ?? normYYYYMMDD(a.fecha);
        return dia === hoyPrestamo;
      })
    );
  }

  function getHoyTZ(p: Prestamo) {
    const tzPrestamo = pickTZ(p.tz, tzSession);
    return todayInTZ(tzPrestamo);
  }

  function diasAtrasoRobusto(p: Prestamo) {
    const hoy = getHoyTZ(p);
    const diasHabiles =
      Array.isArray(p?.diasHabiles) && p.diasHabiles.length ? p.diasHabiles : [1, 2, 3, 4, 5, 6];
    const feriados = Array.isArray(p?.feriados) ? p?.feriados : [];
    const pausas = Array.isArray(p?.pausas) ? p?.pausas : [];
    const modo = (p?.modoAtraso as 'porPresencia' | 'porCuota') ?? 'porPresencia';
    const permitirAdelantar = !!p?.permitirAdelantar;
    const cuotas =
      Number(p?.cuotas || 0) ||
      Math.ceil(Number(p.totalPrestamo || p.montoTotal || 0) / (Number(p.valorCuota) || 1));

    const res = calcularDiasAtraso({
      fechaInicio: p.fechaInicio || hoy,
      hoy,
      cuotas,
      valorCuota: Number(p.valorCuota || 0),
      abonos: (p.abonos || []).map((a) => ({
        monto: Number(a.monto) || 0,
        operationalDate: a.operationalDate,
        fecha: a.fecha,
      })),
      diasHabiles,
      feriados,
      pausas,
      modo,
      permitirAdelantar,
    });

    return res;
  }

  async function guardarReporteNoPago(
    p: Prestamo,
    payload: {
      reason:
        | 'no_contesto'
        | 'no_en_casa'
        | 'promesa'
        | 'dinero'
        | 'enfermedad'
        | 'viaje'
        | 'se_mudo'
        | 'otro';
      nota?: string;
      promesaFecha?: string;
      promesaMonto?: number;
    }
  ) {
    if (!p?.clienteId || !p?.id) return;

    const tz = pickTZ(p.tz, tzSession);
    const fechaOperacion = todayInTZ(tz);

    const base: any = {
      tipo: 'no_pago',
      reason: payload.reason,
      fechaOperacion,
      creadoPor: admin!, // 👈 asegurado
      tz,
      clienteId: p.clienteId,
      prestamoId: p.id,
      clienteNombre: p.concepto ?? '',
      valorCuota: Number(p.valorCuota || 0),
      saldo: Number(p.restante || 0),
      createdAt: serverTimestamp(),
    };

    if (payload.nota && payload.nota.trim()) base.nota = payload.nota.trim();
    if (payload.promesaFecha && payload.promesaFecha.trim()) base.promesaFecha = payload.promesaFecha.trim();
    if (typeof payload.promesaMonto === 'number' && isFinite(payload.promesaMonto)) base.promesaMonto = payload.promesaMonto;

    const docRef = await addDoc(
      collection(db, 'clientes', p.clienteId, 'prestamos', p.id, 'reportesNoPago'),
      base
    );

    await logAudit({
      userId: admin!,
      action: 'no_pago',
      docPath: `clientes/${p.clienteId}/prestamos/${p.id}/reportesNoPago/${docRef.id}`,
      after: pick(
        { ...base, createdAt: undefined },
        ['tipo','reason','fechaOperacion','clienteId','prestamoId','valorCuota','saldo','promesaFecha','promesaMonto','nota']
      ),
    });
  }

  function estimarFechaFin(p: Prestamo): string {
    const tz = pickTZ(p.tz, tzSession);
    const start = (p.fechaInicio && normYYYYMMDD(p.fechaInicio)) || getHoyTZ(p);
    const [y, m, d] = start.split('-').map(Number);
    let curr = new Date(Date.UTC(y, m - 1, d));

    const diasHabiles =
      Array.isArray(p?.diasHabiles) && p.diasHabiles.length ? p.diasHabiles : [1, 2, 3, 4, 5, 6];

    const cuotas =
      Number(p?.cuotas || 0) ||
      Math.ceil(Number(p.totalPrestamo || p.montoTotal || 0) / (Number(p.valorCuota) || 1));

    let restantes = Math.max(1, cuotas);
    while (restantes > 0) {
      const dow = curr.getUTCDay() === 0 ? 7 : curr.getUTCDay();
      if (diasHabiles.includes(dow)) {
        restantes--;
        if (restantes === 0) break;
      }
      curr = new Date(curr.getTime() + 24 * 3600 * 1000);
    }

    const fin = new Intl.DateTimeFormat('es-ES', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(curr);

    return fin;
  }

  // ===== KPIs =====
  const totalClientes = orderedPrestamosAdmin.length;
  const visitados = useMemo(
    () => orderedPrestamosAdmin.filter((p) => esVisitadoHoy(p)).length,
    [orderedPrestamosAdmin]
  );

  const cobradoLegacy = useMemo(() => {
    let total = 0;
    for (const p of orderedPrestamosAdmin) {
      const tzPrestamo = pickTZ(p.tz, tzSession);
      const hoyPrestamo = todayInTZ(tzPrestamo);
      for (const a of p.abonos || []) {
        const dia = a.operationalDate ?? normYYYYMMDD(a.fecha);
        if (dia === hoyPrestamo) total += Number(a.monto) || 0;
      }
    }
    return total;
  }, [orderedPrestamosAdmin]);

  const cobrado = tieneCajaSnapshot ? cobradoHoy : cobradoLegacy;

  const meta = useMemo(
    () => orderedPrestamosAdmin.reduce((acc, p) => acc + (Number(p.valorCuota) || 0), 0),
    [orderedPrestamosAdmin]
  );

  const porcentajeCobro = meta > 0 ? (cobrado / meta) * 100 : 0;
  const progresoCobro = Math.min(100, Math.max(0, Math.round(porcentajeCobro)));

  // Lógica de visibilidad/navegación
  const hiddenIds = useMemo(
    () => new Set([...visitadosHoy, ...omitidosHoy]),
    [visitadosHoy, omitidosHoy]
  );

  const prestamosVisibles = useMemo(
    () => orderedPrestamosAdmin.filter((p) => !hiddenIds.has(p.id) && !esVisitadoHoy(p)),
    [orderedPrestamosAdmin, hiddenIds]
  );

  useEffect(() => {
    setIdx((i) => Math.min(i, Math.max(0, prestamosVisibles.length - 1)));
  }, [prestamosVisibles.length]);

  const current = prestamosVisibles.length > 0 ? prestamosVisibles[idx] : null;

  const goPrev = () => {
    if (prestamosVisibles.length === 0) return;
    setIdx((i) => (i - 1 + prestamosVisibles.length) % prestamosVisibles.length);
  };
  const goNext = () => {
    if (prestamosVisibles.length === 0) return;
    setIdx((i) => (i + 1) % prestamosVisibles.length);
  };

  const marcarComoPagado = async (id: string) => {
    const nuevos = Array.from(new Set([...visitadosHoy, id]));
    setVisitadosHoy(nuevos);
    await AsyncStorage.setItem(storageKeyV, JSON.stringify(nuevos));
  };

  const marcarComoOmitido = async (id: string) => {
    const nuevos = Array.from(new Set([...omitidosHoy, id]));
    setOmitidosHoy(nuevos);
    await AsyncStorage.setItem(storageKeyO, JSON.stringify(nuevos));
  };

  // Helpers TZ
  function toYYYYMMDDInTZ(date: Date, tz: string) {
    const parts = new Intl.DateTimeFormat('es-ES', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const y = parts.find(p => p.type === 'year')?.value ?? '0000';
    const m = parts.find(p => p.type === 'month')?.value ?? '01';
    const d = parts.find(p => p.type === 'day')?.value ?? '01';
    return `${y}-${m}-${d}`;
  }
  function anyDateToYYYYMMDD(d: any, tz: string): string | null {
    try {
      if (!d) return null;
      if (typeof d === 'string') {
        const n = normYYYYMMDD(d);
        return n || null;
      }
      if (typeof d === 'number') return toYYYYMMDDInTZ(new Date(d), tz);
      if (typeof (d as any)?.toDate === 'function') return toYYYYMMDDInTZ((d as any).toDate(), tz);
      if (typeof (d as any)?.seconds === 'number') return toYYYYMMDDInTZ(new Date((d as any).seconds * 1000), tz);
      if (d instanceof Date) return toYYYYMMDDInTZ(d, tz);
      return null;
    } catch {
      return null;
    }
  }
  function getCreatedMs(p: any): number {
    if (typeof p?.createdAtMs === 'number') return p.createdAtMs;
    if (p?.creadoEn?.toMillis) return p.creadoEn.toMillis();
    if (typeof p?.creadoEn?.seconds === 'number') return p.creadoEn.seconds * 1000;
    if (typeof p?.fechaInicio === 'string') {
      const t = Date.parse(p.fechaInicio + 'T00:00:00');
      if (!Number.isNaN(t)) return t;
    }
    return NaN;
  }

  const fechaHeader = useMemo(() => {
    try {
      return new Intl.DateTimeFormat('es-ES', {
        timeZone: tzSession,
        weekday: 'long',
        day: '2-digit',
        month: 'long',
      })
        .format(new Date())
        .replace(/^\w/, (m) => m.toUpperCase());
    } catch {
      return hoyApp;
    }
  }, [hoyApp, tzSession]);

  // "Nuevo"
  const isPrestamoCreadoHoy = useMemo(() => {
    if (!current) return false;
    const tz = pickTZ(current.tz, tzSession);

    const createdDay =
      anyDateToYYYYMMDD(current.creadoEn, tz) ??
      anyDateToYYYYMMDD(current.createdAtMs, tz) ??
      anyDateToYYYYMMDD(current.fechaInicio, tz);
    const todayDay = todayInTZ(tz);
    if (createdDay && createdDay === todayDay) return true;

    const ms = getCreatedMs(current);
    if (Number.isFinite(ms)) {
      return Date.now() - ms < 48 * 3600 * 1000;
    }
    return false;
  }, [current, tzSession]);

  // ===== NUEVO: Estado y helper para WhatsModal =====
  const [whatsVisible, setWhatsVisible] = useState(false);
  const [whatsPayload, setWhatsPayload] = useState<{
    phone?: string;
    nombre?: string;
    valor?: number;
    data?: string;
    saldo?: number;
    parcelaAtual?: number;
    parcelasTotais?: number;
    faltam?: number;
    defaultText?: string;
  }>({});

  const openWhatsForCurrent = () => {
    if (!current) return;

    const phone = current.clienteTelefono1 || '';
    const valorCuota = Number(current.valorCuota || 0);
    const restante = Number(current.restante || 0);

    const abonosSuma = (current.abonos || []).reduce((s, a) => s + (Number(a.monto || 0)), 0);
    const parcelasTotais =
      current.cuotas && current.cuotas > 0
        ? current.cuotas
        : (valorCuota > 0 ? Math.ceil((restante + abonosSuma) / valorCuota) : 0);

    const parcelaAtual =
      valorCuota > 0 ? Math.min(parcelasTotais || 0, Math.floor((abonosSuma + 1e-9) / valorCuota) + 1) : 0;

    let faltam: number | undefined = undefined;
    if (valorCuota > 0) {
      const restoUltima = abonosSuma % valorCuota;
      if (restoUltima > 0) {
        faltam = Math.max(0, valorCuota - restoUltima);
      }
    }

    setWhatsPayload({
      phone,
      nombre: current.concepto,
      valor: valorCuota,
      saldo: restante,
      parcelaAtual: parcelasTotais ? parcelaAtual : undefined,
      parcelasTotais: parcelasTotais || undefined,
      faltam,
    });
    setWhatsVisible(true);
  };

  // 🔒 Mostrar loader si no hay admin aún (evita TS: string | undefined)
  if (!admin) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
        <Text style={{ marginTop: 10, color: palette.softText }}>Cargando sesión...</Text>
      </SafeAreaView>
    );
  }

  // ===== Render =====
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: palette.screenBg }}
      edges={['left','right',]}   // 👈 evita el hueco
    >
      {/* TopBar */}
      <View
        style={[
          styles.topBar,
          { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder },
        ]}
      >
        <QuickBtn
          label="Menú"
          icon="menu"
          tintColor={palette.text}
          accent={palette.accent}
          onPress={() => navigation.navigate('MenuPrincipal')}
        />
        <QuickBtn
          label="Dispon."
          icon="check-decagram"
          tintColor={palette.text}
          accent={palette.accent}
          onPress={() => navigation.navigate('ClientesDisponibles', { admin: admin! })}
        />
        <QuickBtn
          label="Nuevo"
          icon="account-plus"
          tintColor={palette.text}
          accent={palette.accent}
          onPress={() => navigation.navigate('NuevoCliente', { admin: admin! })}
        />
        <QuickBtn
          label="Lista"
          icon="clipboard-list"
          tintColor={palette.text}
          accent={palette.accent}
          onPress={() => navigation.navigate('PagosDiarios', { admin: admin! })}
        />
        <QuickBtn
          label="Más"
          icon="dots-horizontal"
          tintColor={palette.text}
          accent={palette.accent}
          onPress={() => navigation.navigate('Acciones', { admin: admin! })}
        />
      </View>

      {/* Encabezado: fecha */}
      <View style={styles.headerDate}>
        <Text style={[styles.headerDateTxt, { color: palette.text }]}>{fechaHeader}</Text>
        {ultimaActualizacion ? (
          <Text style={{ marginTop: 2, fontSize: 11, color: palette.softText }}>
            Últ. act.: {new Date(ultimaActualizacion).toLocaleString()}
          </Text>
        ) : null}
      </View>

      {/* KPIs + Ficha */}
      <View
        style={[
          styles.body,
          { paddingBottom: COMM_H + Math.max(0, insets.bottom) },
        ]}
      >
        {/* KPIs */}
        <View style={[styles.progressCard, { backgroundColor: palette.kpiBg }]}>
          <View style={[styles.progressBarBg, { backgroundColor: palette.kpiTrack }]}>
            <View
              style={[
                styles.progressBarFill,
                { width: `${progresoCobro}%`, backgroundColor: palette.accent },
              ]}
            />
          </View>
          <View style={styles.progressRow}>
            <Text style={[styles.progressText, { color: palette.text }]}>
              {visitados}/{totalClientes}
            </Text>
            <Text style={[styles.progressText, { color: palette.text }]}>
              {porcentajeCobro.toFixed(1)}%
            </Text>
            <Text style={[styles.progressText, { color: palette.text }]}>
              R$ {cobrado.toFixed(2)}/{meta.toFixed(2)}
            </Text>
          </View>
        </View>

        {/* Ficha */}
        {cargando ? (
          <ActivityIndicator size="large" style={{ marginTop: 16 }} />
        ) : !current ? (
          <View
            style={[
              styles.cardCliente,
              { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
            ]}
          >
            <View style={styles.cardContent}>
              <Text style={{ textAlign: 'center', color: palette.softText }}>
                {cargaPrestamosOk === false
                  ? 'No se pudieron leer los préstamos.'
                  : 'No tienes préstamos pendientes por hoy.'}
              </Text>
            </View>
            <View style={[styles.cardFooter, { borderTopColor: palette.divider }]}>
              <View
                style={[
                  styles.navPill,
                  { backgroundColor: palette.topBg, borderColor: palette.topBorder },
                ]}
              />
              <Text style={[styles.navIndex, { color: palette.softText }]}>0/0</Text>
              <View
                style={[
                  styles.navPill,
                  { backgroundColor: palette.topBg, borderColor: palette.topBorder },
                ]}
              />
            </View>
          </View>
        ) : (
          <View
            style={[
              styles.cardCliente,
              { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
            ]}
          >
            <ScrollView
              style={styles.cardContent}
              contentContainerStyle={{ paddingBottom: 8 }}
              showsVerticalScrollIndicator={false}
            >
              {/* Nombre grande */}
              <Text style={[styles.nombreGrande, { color: palette.text }]}>
                {current.concepto}
              </Text>

              <Text style={[styles.linea, { color: palette.text }]}>
                <Text style={[styles.etiqueta, { color: palette.text }]}>Alias: </Text>
                {current.clienteAlias || '—'}
              </Text>
              <Text style={[styles.linea, { color: palette.text }]}>
                <Text style={[styles.etiqueta, { color: palette.text }]}>Dirección: </Text>
                {current.clienteDireccion1 || '—'}
              </Text>
              {!!current.clienteDireccion2 && (
                <Text style={[styles.linea, { color: palette.text }]}>
                  <Text style={[styles.etiqueta, { color: palette.text }]}>Dirección 2: </Text>
                  {current.clienteDireccion2}
                </Text>
              )}
              <Text style={[styles.linea, { color: palette.text }]}>
                <Text style={[styles.etiqueta, { color: palette.text }]}>Teléfono: </Text>
                {current.clienteTelefono1 || '—'}
              </Text>

              <TouchableOpacity
                style={{ marginBottom: 8 }}
                onPress={() => {
                  const info = diasAtrasoRobusto(current);
                  setFaltasData(info.faltas || []);
                  setFaltasOpen(true);
                }}
                activeOpacity={0.7}
              >
                <Text style={[styles.linea, { textAlign: 'center', color: palette.text }]}>
                  <Text style={[styles.etiqueta, { color: palette.text }]}>Periodo: </Text>
                  {current.fechaInicio || '—'} <Text style={{ color: palette.softText }}>→</Text>{' '}
                  {estimarFechaFin(current)}
                </Text>
                <Text style={[styles.hintTouch, { color: palette.softText }]}>
                  (toca para ver fechas sin pago)
                </Text>
              </TouchableOpacity>

              <View style={[styles.divider, { backgroundColor: palette.divider }]} />

              {/* Totales + Cuota */}
              <Text style={[styles.linea, { color: palette.text }]}>
                <Text style={[styles.etiqueta, { color: palette.text }]}>Préstamo total: </Text>
                R$ {Number(current.totalPrestamo || current.montoTotal || 0).toFixed(2)}
              </Text>
              <Text style={[styles.linea, { color: palette.text }]}>
                <Text style={[styles.etiqueta, { color: palette.text }]}>Saldo: </Text>
                R$ {Number(current.restante || 0).toFixed(2)}
              </Text>
              <Text style={[styles.linea, { color: palette.text }]}>
                <Text style={[styles.etiqueta, { color: palette.text }]}>Valor cuota: </Text>
                R$ {Number(current.valorCuota || 0).toFixed(2)}
              </Text>

              {/* Badges */}
              {(() => {
                const quota = computeQuotaBadge(current);
                const presence = computePresenceBadge(current);
                return (
                  <View style={{ alignItems: 'center', marginTop: 6 }}>
                    <Text
                      style={[
                        styles.pill,
                        {
                          backgroundColor: quota.bg,
                          color: quota.text,
                          borderColor: quota.border,
                          marginBottom: 6,
                        },
                      ]}
                    >
                      {quota.label}
                    </Text>

                    <Text
                      style={[
                        styles.pill,
                        { backgroundColor: presence.bg, color: presence.text, borderColor: presence.border },
                      ]}
                    >
                      {presence.label}
                    </Text>

                    {isPrestamoCreadoHoy && (
                      <Text style={styles.inlineNewTagTextOnly}>Nuevo</Text>
                    )}
                  </View>
                );
              })()}
            </ScrollView>

            {/* Flechas "< 3/8 >" */}
            <View style={[styles.cardFooter, { borderTopColor: palette.divider }]}>
              <TouchableOpacity
                onPress={goPrev}
                style={[
                  styles.navPill,
                  { backgroundColor: palette.topBg, borderColor: palette.topBorder },
                ]}
                activeOpacity={0.85}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <MIcon name="chevron-left" size={20} color={palette.accent} />
              </TouchableOpacity>

              <Text style={[styles.navIndex, { color: palette.softText }]}>
                {prestamosVisibles.length ? idx + 1 : 0}/{prestamosVisibles.length}
              </Text>

              <TouchableOpacity
                onPress={goNext}
                style={[
                  styles.navPill,
                  { backgroundColor: palette.topBg, borderColor: palette.topBorder },
                ]}
                activeOpacity={0.85}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <MIcon name="chevron-right" size={20} color={palette.accent} />
              </TouchableOpacity>
            </View>

            {/* Acciones verde/rojo */}
            <View style={styles.actionRowBottom}>
              <TouchableOpacity
                onPress={() => setModalPagoVisible(true)}
                style={[
                  styles.actionBtnCorner,
                  { backgroundColor: '#4CAF50', alignSelf: 'flex-start' },
                ]}
                activeOpacity={0.9}
              >
                <View style={styles.circle} />
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() =>
                  Alert.alert(
                    'Marcar como no pagó',
                    '¿Deseas marcar este cliente como que no pagó hoy?',
                    [
                      { text: 'Cancelar', style: 'cancel' },
                      { text: 'Confirmar', onPress: () => setNoPagoOpen(true) },
                    ]
                  )
                }
                style={[
                  styles.actionBtnCorner,
                  { backgroundColor: '#F44336', alignSelf: 'flex-end' },
                ]}
                activeOpacity={0.9}
              >
                <View style={styles.circle} />
              </TouchableOpacity>
            </View>
          </View>
        )}
        {/* --- Barra de comunicación fija al fondo --- */}
        <View
          style={[
            styles.commBar,
            {
              position: 'absolute',
              left: 16,
              right: 16,
              bottom: insets.bottom,
              height: COMM_H,
              backgroundColor: palette.commBg,
              borderColor: palette.commBorder,
            },
          ]}
        >
          {/* WhatsApp */}
          <TouchableOpacity
            style={[
              styles.commIconBtn,
              { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
            ]}
            activeOpacity={0.9}
            onPress={openWhatsForCurrent}
          >
            <MIcon name="whatsapp" size={22} color={palette.text} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.commIconBtn,
              { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
            ]}
            activeOpacity={0.9}
            onPress={() => Alert.alert('Llamar', 'Próximamente: iniciar llamada')}
          >
            <MIcon name="phone" size={20} color={palette.text} />
          </TouchableOpacity>

          {/* Calculadora */}
          <TouchableOpacity
            style={[
              styles.commIconBtn,
              { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
            ]}
            activeOpacity={0.9}
            onPress={() => navigation.navigate('Calculadora')}
          >
            <MIcon name="calculator-variant" size={20} color={palette.text} />
          </TouchableOpacity>

          {/* Reenviar pendientes */}
          {showResendIcon && (
            <TouchableOpacity
              style={[
                styles.commIconBtn,
                { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
              ]}
              activeOpacity={0.9}
              onPress={() => navigation.navigate('Pendientes')}
            >
              <MIcon name="cloud-upload" size={20} color={palette.text} />
            </TouchableOpacity>
          )}

          {/* Campana (in-app) */}
          <TouchableOpacity
            style={[
              styles.commIconBtn,
              { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
            ]}
            activeOpacity={0.9}
            onPress={() => Alert.alert('Notificaciones', 'Próximamente: alertas dentro de la app.')}
          >
            <MIcon name="bell-outline" size={20} color={palette.text} />
          </TouchableOpacity>

          {/* Tema */}
          <TouchableOpacity
            style={[
              styles.commIconBtn,
              { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
            ]}
            activeOpacity={0.9}
            onPress={toggleTheme}
          >
            {isDark ? (
              <MIcon name="white-balance-sunny" size={22} color={palette.text} />
            ) : (
              <MIcon name="weather-night" size={22} color={palette.text} />
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Modal Faltas */}
      <Modal
        visible={faltasOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setFaltasOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <View
            style={[
              styles.modalBox,
              { backgroundColor: palette.cardBg, borderColor: palette.cardBorder, borderWidth: 1 },
            ]}
          >
            <Text style={[styles.modalTitle, { color: palette.text }]}>Fechas sin pago</Text>
            {faltasData.length === 0 ? (
              <Text style={[styles.modalEmpty, { color: palette.softText }]}>
                No hay faltas registradas.
              </Text>
            ) : (
              <FlatList
                data={faltasData}
                keyExtractor={(d, i) => d + i}
                renderItem={({ item }) => (
                  <View style={[styles.faltaRow, { borderBottomColor: palette.divider }]}>
                    <Text style={[styles.faltaText, { color: palette.text }]}>{item}</Text>
                  </View>
                )}
                style={{ maxHeight: 260 }}
              />
            )}
            <TouchableOpacity
              style={[styles.modalBtn, { backgroundColor: palette.accent }]}
              onPress={() => setFaltasOpen(false)}
            >
              <Text style={styles.modalBtnTxt}>Cerrar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Modal No-Pago */}
      {current && (
        <ModalNoPago
          visible={noPagoOpen}
          onCancel={() => setNoPagoOpen(false)}
          saving={noPagoSaving}
          onSave={async (form) => {
            if (!current) return;
            try {
              setNoPagoSaving(true);
              await guardarReporteNoPago(current, form);
              await marcarComoOmitido(current.id);
              setNoPagoOpen(false);
            } catch (e) {
              console.warn('Sin conexión / error guardando no-pago, encolando:', e);
              try {
                await addToOutbox({
                  kind: 'no_pago',
                  payload: {
                    admin: admin!, // 👈 asegurado aquí
                    clienteId: current.clienteId!,
                    prestamoId: current.id!,
                    ...form,
                  },
                });
                Alert.alert('Pendientes', 'Guardado en "Pendientes" para reenviar cuando tengas internet.');
              } catch (e2) {
                Alert.alert('Error', 'No se pudo guardar el no-pago en Pendientes.');
              } finally {
                setNoPagoOpen(false);
              }
            } finally {
              setNoPagoSaving(false);
            }
          }}
        />
      )}

      {/* Modal Registro Pago */}
      {current && (
        <ModalRegistroPago
          visible={modalPagoVisible}
          onClose={() => setModalPagoVisible(false)}
          onSuccess={() => current?.id && marcarComoPagado(current.id)}
          clienteNombre={current.concepto}
          clienteId={current.clienteId}
          prestamoId={current.id}
          admin={admin!}
          clienteTelefono={current.clienteTelefono1}
          /* ⚡ prefetched para abrir instantáneo */
          prefetched={{
            valorCuota: Number(current.valorCuota ?? 0),
            saldoPendiente: Number(current.restante ?? 0),
          }}
        />
      )}

      {/* WhatsModal */}
      {current && (
        <WhatsModal
          visible={whatsVisible}
          onClose={() => setWhatsVisible(false)}
          phone={whatsPayload.phone}
          nombre={whatsPayload.nombre}
          onSent={() => {}}
        />
      )}
    </SafeAreaView>
  );
}

/** --- util interno pequeño para throttle sin re-render --- */
function useRefLike<T>(initial: T) {
  const r = useRef<T>(initial);
  return r.current;
}

/** --- Componentes pequeños --- */
function QuickBtn({
  icon,
  label,
  onPress,
  tintColor,
  accent,
}: {
  icon: React.ComponentProps<typeof MIcon>['name'];
  label: string;
  onPress: () => void;
  tintColor?: string;
  accent?: string;
}) {
  return (
    <TouchableOpacity style={styles.quickBtn} onPress={onPress} activeOpacity={0.8}>
      <MIcon name={icon} size={18} color={accent || '#2e7d32'} style={{ marginBottom: 2 }} />
      <Text style={[styles.quickLabel, { color: tintColor }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
    borderBottomWidth: 1,
  },
  quickBtn: { alignItems: 'center', paddingVertical: 6, width: '19%' },
  quickLabel: { fontSize: 12 },

  headerDate: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
  },
  headerDateTxt: { fontSize: 16, fontWeight: '800' },

  body: {
    flex: 1,
    paddingHorizontal: 16,
    gap: 10,
    position: 'relative',
  },

  progressCard: {
    borderRadius: 14,
    padding: 12,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  progressBarBg: {
    height: 16,
    borderRadius: 10,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    borderRadius: 10,
  },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  progressText: { fontSize: 12, fontWeight: '600' },

  // Ficha full-height
  cardCliente: {
    flex: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 64,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    alignItems: 'center',
    borderWidth: 1,
    position: 'relative',
  },
  cardContent: {
    alignSelf: 'stretch',
    flex: 1,
    minHeight: 0,
  },

  // Flechas
  cardFooter: {
    alignSelf: 'stretch',
    paddingTop: 6,
    borderTopWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  navPill: {
    width: 44,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 8,
  },
  navIndex: {
    fontSize: 13,
    fontWeight: '700',
    marginHorizontal: 4,
  },

  etiqueta: { fontWeight: '700' },
  linea: { fontSize: 14, marginBottom: 6, textAlign: 'center' },
  divider: {
    height: 1,
    marginVertical: 10,
    alignSelf: 'stretch',
  },
  hintTouch: { fontSize: 11, marginTop: 2, textAlign: 'center' },

  // Nombre grande
  nombreGrande: {
    fontSize: 20,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 6,
  },

  // Píldoras pequeñas
  pill: {
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    fontWeight: '900',
    fontSize: 11,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },

  // Botones verde/rojo anclados
  actionRowBottom: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  actionBtnCorner: {
    width: 42,
    height: 42,
    borderRadius: 21,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 3,
  },
  circle: { width: 20, height: 20, borderRadius: 10, backgroundColor: 'white' },

  // Barra fija al fondo
  commBar: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
  },
  commIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 6,
  },

  // Modales
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  modalBox: {
    width: '95%',
    maxWidth: 420,
    borderRadius: 12,
    padding: 16,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 10,
  },
  faltaRow: {
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  faltaText: { fontSize: 14, textAlign: 'center' },
  modalEmpty: { textAlign: 'center', paddingVertical: 16 },
  modalBtn: {
    marginTop: 12,
    paddingVertical: 10,
    borderRadius: 8,
  },
  modalBtnTxt: { color: '#fff', fontWeight: '700', textAlign: 'center' },

  // Letrero "Nuevo"
  inlineNewTagTextOnly: {
    marginTop: 6,
    textAlign: 'center',
    color: '#1565C0',
    fontWeight: '900',
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
});
