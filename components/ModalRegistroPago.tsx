import React, { useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, Keyboard,
  Platform, KeyboardAvoidingView, Pressable, Linking, ActivityIndicator,
} from 'react-native';
import {
  doc, collection, addDoc, deleteDoc, runTransaction, serverTimestamp,
  updateDoc, getDoc, DocumentReference, getDocs, writeBatch,
} from 'firebase/firestore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { db } from '../firebase/firebaseConfig';
import { todayInTZ, pickTZ } from '../utils/timezone';
import { calcularDiasAtraso } from '../utils/atrasoHelper';
import { logAudit, pick } from '../utils/auditLogs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { addToOutbox } from '../utils/outbox';
// 🔐 contexto de auth (tenant/rol/ruta/admin)
import { getAuthCtx } from '../utils/authCtx';

type SuccessPayload = {
  clienteId: string;
  prestamoId: string;
  monto: number;
  restanteNuevo?: number;
  optimistic?: boolean;
};

type PrefetchedPago = { valorCuota?: number; saldoPendiente?: number };

type Props = {
  visible: boolean;
  onClose: () => void;
  clienteNombre: string;
  clienteId?: string;
  prestamoId?: string;
  admin: string; // <- compat
  onSuccess?: (p?: SuccessPayload) => void;
  clienteTelefono?: string;
  /** ⚡ datos precargados desde la lista para abrir instantáneo */
  prefetched?: PrefetchedPago;
};

const quotaCache: Record<string, { cuota: number; saldo: number }> = {};
const KEY_SEND_RECEIPT_CONFIRM = 'prefs:sendReceiptConfirm';

/** Abrir WhatsApp sin número: deep-link → fallback web. */
async function openWhats(text: string) {
  const encoded = encodeURIComponent(text || '');
  const deep = `whatsapp://send?text=${encoded}`;
  const web  = `https://wa.me/?text=${encoded}`;

  try { await Linking.openURL(deep); return; } catch {}
  try { await Linking.openURL(web);  return; } catch {}

  Alert.alert(
    'WhatsApp',
    Platform.OS === 'android'
      ? 'No se pudo abrir WhatsApp. Verifica que esté instalado.'
      : 'No se pudo abrir WhatsApp en este dispositivo.'
  );
}

function buildReceiptPT(opts: {
  nombre: string;
  montoPagado: number;
  fecha: string;
  saldoRestante: number;
  linhaParcela?: string;
}) {
  const nombre = opts.nombre || 'cliente';
  return [
    `Olá ${nombre} 👋`,
    `Recebemos seu pagamento de R$ ${opts.montoPagado.toFixed(2)}.`,
    ...(opts.linhaParcela ? [opts.linhaParcela] : []),
    `Data: ${opts.fecha}`,
    `Saldo restante: R$ ${opts.saldoRestante.toFixed(2)}.`,
    `Obrigado!`,
  ].join('\n');
}

// 🔸 helper: construye la “linhaParcela” correcta (completa o parcial)
function makeLinhaParcela(opts: {
  valorCuota: number;
  cuotasTotales: number;         // 0 si desconocido
  restanteNuevo: number;         // post-abono
  totalPrestamoAprox: number;    // si no hay total exacto, usar aproximación
}) {
  const v = Number(opts.valorCuota) || 0;
  if (v <= 0) return undefined;

  const n = Number(opts.cuotasTotales) || 0; // puede ser 0 (desconocido)
  const total = Number.isFinite(opts.totalPrestamoAprox) ? Math.max(0, opts.totalPrestamoAprox) : 0;
  if (total <= 0) return undefined;

  const paidAfter = Math.max(0, total - (Number(opts.restanteNuevo) || 0));
  const completas = Math.floor(paidAfter / v);
  const resto = +(paidAfter - completas * v).toFixed(2);

  if (resto < 0.01) {
    const k = n > 0 ? Math.min(completas, n) : completas;
    return n > 0
      ? `Parcela: R$ ${v.toFixed(2)} (#${k}/${n})`
      : `Parcela: R$ ${v.toFixed(2)} (#${k})`;
  }

  const faltam = +(v - resto).toFixed(2);
  const prox = completas + 1;
  return n > 0
    ? `Faltam R$ ${faltam.toFixed(2)} para completar a parcela #${prox}/${n}`
    : `Faltam R$ ${faltam.toFixed(2)} para completar a parcela #${prox}`;
}

export default function ModalRegistroPago({
  visible, onClose, clienteNombre, clienteId, prestamoId, admin, onSuccess, prefetched,
}: Props) {
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);

  const [monto, setMonto] = useState('');
  const [loading, setLoading] = useState(false);

  const [valorCuota, setValorCuota] = useState<number>(0);
  const [saldoPendiente, setSaldoPendiente] = useState<number>(0);
  const [loadingCuota, setLoadingCuota] = useState(false); // ← oculta controles hasta estar listo

  const [prefConfirmReceipt, setPrefConfirmReceipt] = useState(false);
  const hasOpenedWhatsRef = useRef(false);

  // Anti-race / Anti-double-submit
  const requestTokenRef = useRef<string>('');
  const submittingRef = useRef(false);

  // Refs blindadas vs flicker
  const lastKnownRef = useRef<{ cuota: number; saldo: number }>({ cuota: 0, saldo: 0 });
  const montoRef = useRef<string>('');
  useEffect(() => { montoRef.current = monto; }, [monto]);

  // 🔐 contexto auth (tenant/rol/ruta/admin)
  const [ctx, setCtx] = useState<{
    admin: string | null;
    tenantId: string | null;
    role: 'collector' | 'admin' | 'superadmin' | null;
    rutaId: string | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    (async () => {
      const c = await getAuthCtx();
      if (!active) return;
      setCtx({
        admin: c?.admin ?? null,
        tenantId: c?.tenantId ?? null,
        role: (c?.role as any) ?? null,
        rutaId: c?.rutaId ?? null,
      });
    })();
    return () => { active = false; };
  }, []);
  const authAdminId = ctx?.admin ?? null;

  const [contentReady, setContentReady] = useState(false);
  useEffect(() => {
    if (visible) {
      setContentReady(false);
      hasOpenedWhatsRef.current = false;
      submittingRef.current = false;
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [visible]);

  useEffect(() => {
    const cargarInfo = async () => {
      if (!visible) return;

      setMonto('');
      setLoading(false);
      setLoadingCuota(true);

      const token = `${clienteId ?? ''}:${prestamoId ?? ''}:${Date.now()}`;
      requestTokenRef.current = token;

      try {
        const v = await AsyncStorage.getItem(KEY_SEND_RECEIPT_CONFIRM);
        if (requestTokenRef.current === token) setPrefConfirmReceipt(v === '1');
      } catch {
        if (requestTokenRef.current === token) setPrefConfirmReceipt(false);
      }

      if (!clienteId || !prestamoId) {
        if (requestTokenRef.current === token) setLoadingCuota(false);
        return;
      }

      // Prefetched
      let usedPrefetch = false;
      if (
        prefetched &&
        (prefetched.valorCuota !== undefined || prefetched.saldoPendiente !== undefined)
      ) {
        const cuota = Number(prefetched.valorCuota ?? lastKnownRef.current.cuota) || 0;
        const saldo = Number(prefetched.saldoPendiente ?? lastKnownRef.current.saldo) || 0;

        if (requestTokenRef.current === token) {
          setValorCuota(cuota);
          setSaldoPendiente(saldo);
          setLoadingCuota(false);
        }
        quotaCache[prestamoId] = { cuota, saldo };
        lastKnownRef.current = { cuota, saldo };
        usedPrefetch = true;
      }

      // Cache local
      if (!usedPrefetch) {
        const cacheHit = quotaCache[prestamoId];
        if (cacheHit) {
          if (requestTokenRef.current === token) {
            setValorCuota(cacheHit.cuota);
            setSaldoPendiente(cacheHit.saldo);
          }
          lastKnownRef.current = { cuota: cacheHit.cuota, saldo: cacheHit.saldo };
        }
      }

      // Lectura fresca
      try {
        const ref = doc(db, 'clientes', clienteId, 'prestamos', prestamoId);
        const snap = await getDoc(ref);
        if (requestTokenRef.current !== token) return;

        if (snap.exists()) {
          const d = snap.data() as any;
          const cuota = Number(d?.valorCuota ?? 0) || 0;
          const saldo =
            typeof d?.restante === 'number'
              ? Number(d.restante)
              : Number(d?.montoTotal ?? d?.totalPrestamo ?? 0) || 0;

          const changed = cuota !== lastKnownRef.current.cuota || saldo !== lastKnownRef.current.saldo;
          quotaCache[prestamoId] = { cuota, saldo };
          if (changed && requestTokenRef.current === token) {
            setValorCuota(cuota);
            setSaldoPendiente(saldo);
          }
          lastKnownRef.current = { cuota, saldo };
        } else {
          if (!usedPrefetch && requestTokenRef.current === token) {
            setValorCuota(0);
            setSaldoPendiente(0);
            lastKnownRef.current = { cuota: 0, saldo: 0 };
          }
        }
      } catch {
        // silencioso
      } finally {
        if (requestTokenRef.current === token) {
          setLoadingCuota(false);
        }
      }
    };

    void cargarInfo();
    if (!visible) setMonto('');
  }, [visible, clienteId, prestamoId, prefetched]);

  const parseMonto = (txt: string) => {
    const norm = (txt ?? '').replace(',', '.').trim();
    if (!norm) return NaN;
    if (!/^\d+(\.\d{0,2})?$/.test(norm)) return NaN;
    return parseFloat(norm);
  };

  const solicitarConfirmacion = () => {
    if (loadingCuota) {
      Alert.alert('Espera', 'Estamos preparando los datos del pago.');
      return;
    }

    // Usa ref del input; si está vacío y hay cuota, autocompleta
    let txt = montoRef.current;
    if ((!txt || txt.trim() === '') && lastKnownRef.current.cuota > 0) {
      txt = String(lastKnownRef.current.cuota);
      setMonto(txt);
      montoRef.current = txt;
    }

    const montoNum = parseMonto(txt);
    if (!isFinite(montoNum) || montoNum <= 0) {
      Alert.alert('Monto inválido', 'Ingresa un monto mayor a 0.');
      return;
    }

    const saldoOk = lastKnownRef.current.saldo; // blindado vs flicker
    if (montoNum > saldoOk) {
      Alert.alert(
        'Monto demasiado alto',
        `El saldo pendiente es R$ ${saldoOk.toFixed(2)}. Ingresa un monto menor o igual.`
      );
      return;
    }

    Alert.alert('Confirmar pago', `¿Confirmar pago por R$ ${montoNum.toFixed(2)}?`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Confirmar', onPress: () => registrarAbono(montoNum) },
    ]);
  };

  const registrarAbono = async (montoNum: number) => {
    if (!clienteId || !prestamoId) return;
    if (loading || loadingCuota) return;
    if (submittingRef.current) return;
    submittingRef.current = true;

    if (!authAdminId) {
      Alert.alert('Sesión', 'No se pudo identificar el usuario (admin). Intenta nuevamente.');
      submittingRef.current = false;
      return;
    }

    // Clamp defensivo a 2 decimales
    montoNum = Number(montoNum.toFixed(2));

    // Optimista inmediato
    onSuccess?.({ clienteId, prestamoId, monto: montoNum, optimistic: true });

    onClose();
    setLoading(true);
    Keyboard.dismiss();

    const prestamoRef = doc(db, 'clientes', clienteId, 'prestamos', prestamoId);
    const abonoRef: DocumentReference = doc(collection(prestamoRef, 'abonos'));

    try {
      // ====================== HOT PATH: TRANSACCIÓN ======================
      const txResult = await runTransaction(db, async (tx) => {
        const snap = await tx.get(prestamoRef);
        if (!snap.exists()) throw new Error('El préstamo no existe.');

        const data = snap.data() as any;
        const tz = pickTZ(data?.tz);
        const operativoHoy = todayInTZ(tz);

        const restanteActual =
          typeof data.restante === 'number'
            ? Number(data.restante)
            : Number(data.montoTotal || data.totalPrestamo || 0);

        const valorCuotaTx = Number(data?.valorCuota || 0);
        const cuotasTotalesTx =
          Number(data?.cuotasTotales || data?.cuotas || 0) ||
          Math.ceil(
            Number(data.totalPrestamo || data.montoTotal || 0) /
              (valorCuotaTx || 1)
          ) ||
          0;

        const prevCuotasPagadas =
          typeof data?.cuotasPagadas === 'number'
            ? Number(data.cuotasPagadas)
            : valorCuotaTx > 0
              ? Math.floor(
                  (Number(data.totalPrestamo || data.montoTotal || 0) -
                    restanteActual) /
                    valorCuotaTx
                )
              : 0;

        const nowMs = Date.now();
        const nuevoAbono = {
          monto: Number(montoNum.toFixed(2)),
          registradoPor: authAdminId, // 👈 unificado
          tz,
          operationalDate: operativoHoy,
          createdAtMs: nowMs,
          createdAt: serverTimestamp(),
          source: 'app',
          // 🔐 scoping
          tenantId: ctx?.tenantId ?? null,
          rutaId: ctx?.role === 'collector' ? ctx?.rutaId ?? null : null,
        };

        // 1) Abono (subcolección)
        tx.set(abonoRef, nuevoAbono);

        // 2) Agregados del préstamo (clamp a 0)
        const nuevoRestante = Math.max(restanteActual - montoNum, 0);
        const deltaCuotas = valorCuotaTx > 0 ? Math.floor(montoNum / valorCuotaTx) : 0;

        const maxCuotas = cuotasTotalesTx > 0 ? cuotasTotalesTx : Number.MAX_SAFE_INTEGER;
        const nuevasCuotasPagadas = Math.max(
          0,
          Math.min(prevCuotasPagadas + deltaCuotas, maxCuotas)
        );

        tx.update(prestamoRef, {
          restante: nuevoRestante,
          cuotasPagadas: nuevasCuotasPagadas,
          lastAbonoAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        return {
          prestamoBefore: pick(data, [
            'restante',
            'valorCuota',
            'totalPrestamo',
            'clienteId',
            'concepto',
            'cuotasPagadas',
            'cuotas',
            'cuotasTotales',
          ]),
          nuevoRestante,
          valorCuotaTx,
          cuotasTotalesTx,
          nuevasCuotasPagadas,
          abonoNuevo: nuevoAbono,
          tz,
          operativoHoy,
        };
      });

      // UI libre + notificación final
      setMonto('');
      setLoading(false);
      submittingRef.current = false;
      onSuccess?.({
        clienteId: clienteId!,
        prestamoId: prestamoId!,
        monto: montoNum,
        restanteNuevo: txResult.nuevoRestante,
        optimistic: false,
      });

      // ====================== RECIBO (no bloquea la UI) ======================
      if (prefConfirmReceipt && !hasOpenedWhatsRef.current) {
        const totalAprox =
          Number((txResult as any).prestamoBefore?.totalPrestamo) ||
          (txResult.cuotasTotalesTx > 0 && txResult.valorCuotaTx > 0
            ? txResult.cuotasTotalesTx * txResult.valorCuotaTx
            : 0);

        const linhaParcela = makeLinhaParcela({
          valorCuota: txResult.valorCuotaTx,
          cuotasTotales: txResult.cuotasTotalesTx,
          restanteNuevo: txResult.nuevoRestante,
          totalPrestamoAprox: totalAprox,
        });

        const texto = buildReceiptPT({
          nombre: clienteNombre || 'Cliente',
          montoPagado: montoNum,
          fecha: txResult.operativoHoy,
          saldoRestante: txResult.nuevoRestante || 0,
          linhaParcela,
        });
        hasOpenedWhatsRef.current = true;
        setTimeout(() => void openWhats(texto), 0);
      }

      // ====================== PESADO → BACKGROUND ======================
      setTimeout(async () => {
        try {
          // Caja (idempotente)
          const batch = writeBatch(db);
          const cajaId = `pay_${(abonoRef as any).id}`;
          const cajaRef = doc(collection(db, 'cajaDiaria'), cajaId);
          batch.set(cajaRef, {
            tipo: 'abono' as const,
            admin: authAdminId,                 // 👈 unificado
            clienteId: clienteId!,
            prestamoId: prestamoId!,
            clienteNombre: clienteNombre || 'Cliente',
            monto: Number(montoNum.toFixed(2)),
            tz: txResult.tz,
            operationalDate: txResult.operativoHoy,
            createdAtMs: Date.now(),
            createdAt: serverTimestamp(),
            source: 'app',
            meta: { abonoRefId: (abonoRef as any).id },
            // 🔐 scoping para que aparezca en CajaDiaria
            tenantId: ctx?.tenantId ?? null,
            rutaId: ctx?.role === 'collector' ? ctx?.rutaId ?? null : null,
          });
          await batch.commit();

          void logAudit({
            userId: authAdminId, // 👈 unificado
            action: 'create',
            docPath: cajaRef.path,
            after: {
              tipo: 'abono',
              admin: authAdminId,
              clienteId,
              prestamoId,
              monto: Number(montoNum.toFixed(2)),
              operationalDate: txResult.operativoHoy,
              tenantId: ctx?.tenantId ?? null,
              rutaId: ctx?.role === 'collector' ? ctx?.rutaId ?? null : null,
            },
          });
        } catch (e) {
          console.warn('[BG] cajaDiaria fallo:', e);
        }

        try {
          // Audit abono
          void logAudit({
            userId: authAdminId, // 👈 unificado
            action: 'create',
            docPath: (abonoRef as any).path,
            after: pick(txResult.abonoNuevo, ['monto', 'operationalDate', 'tz', 'tenantId', 'rutaId']),
          });
        } catch {}

        try {
          // Recalc atraso (pesado)
          const prestamoRef = doc(db, 'clientes', clienteId!, 'prestamos', prestamoId!);
          const pSnap = await getDoc(prestamoRef);
          if (pSnap.exists()) {
            const p = pSnap.data() as any;

            const abonosSnap = await getDocs(collection(prestamoRef, 'abonos'));
            const abonos = abonosSnap.docs.map((d) => {
              const a = d.data() as any;
              return {
                monto: Number(a?.monto) || 0,
                operationalDate: a?.operationalDate,
                fecha: a?.fecha,
              };
            });

            const tzDoc = pickTZ(p?.tz);
            const hoy = p?.operationalDate || todayInTZ(tzDoc);
            const diasHabiles =
              Array.isArray(p?.diasHabiles) && p.diasHabiles.length
                ? p.diasHabiles
                : [1, 2, 3, 4, 5, 6];
            const feriados = Array.isArray(p?.feriados) ? p.feriados : [];
            const pausas = Array.isArray(p?.pausas) ? p.pausas : [];
            const modo =
              (p?.modoAtraso as 'porPresencia' | 'porCuota') ?? 'porPresencia';
            const permitirAdelantar = !!p?.permitirAdelantar;
            const cuotas =
              Number(p?.cuotasTotales || p?.cuotas || 0) ||
              Math.ceil(
                Number(p.totalPrestamo || p.montoTotal || 0) /
                  (Number(p.valorCuota) || 1)
              );

            const res = calcularDiasAtraso({
              fechaInicio: p?.fechaInicio || hoy,
              hoy,
              cuotas,
              valorCuota: Number(p?.valorCuota || 0),
              abonos,
              diasHabiles,
              feriados,
              pausas,
              modo,
              permitirAdelantar,
            });

            await updateDoc(prestamoRef, {
              diasAtraso: res.atraso,
              faltas: res.faltas || [],
              ultimaReconciliacion: serverTimestamp(),
            });

            void logAudit({
              userId: authAdminId, // 👈 unificado
              action: 'update',
              ref: prestamoRef,
              before: txResult.prestamoBefore,
              after: {
                restante: txResult.nuevoRestante,
                cuotasPagadas: txResult.nuevasCuotasPagadas,
                diasAtraso: res.atraso,
              },
            });
          }
        } catch (e) {
          console.warn('[BG] recalc atraso fallo:', e);
        }

        try {
          // Cierre si saldo 0
          if (txResult.nuevoRestante === 0) {
            const prestamoRef = doc(db, 'clientes', clienteId!, 'prestamos', prestamoId!);
            const snap = await getDoc(prestamoRef);
            const p = snap.exists() ? (snap.data() as any) : {};
            const historialRef = collection(
              db,
              'clientes',
              clienteId!,
              'historialPrestamos'
            );
            const histRef = await addDoc(historialRef, {
              ...p,
              restante: 0,
              diasAtraso: 0,
              faltas: [],
              finalizadoEn: serverTimestamp(),
              finalizadoPor: authAdminId, // 👈 unificado
            });
            void logAudit({
              userId: authAdminId,
              action: 'create',
              ref: histRef,
              after: { clienteId, prestamoId, restante: 0, finalizadoPor: authAdminId },
            });
            await deleteDoc(prestamoRef);
            void logAudit({
              userId: authAdminId,
              action: 'delete',
              ref: prestamoRef,
              before: txResult.prestamoBefore,
              after: null,
            });
          }
        } catch (e) {
          console.warn('[BG] cierre a historial fallo:', e);
        }

        try {
          // Refrescar cache local
          if (prestamoId) {
            quotaCache[prestamoId] = {
              cuota: Number(lastKnownRef.current.cuota || txResult.valorCuotaTx || 0) || 0,
              saldo: txResult.nuevoRestante || 0,
            };
            lastKnownRef.current = {
              cuota: quotaCache[prestamoId].cuota,
              saldo: quotaCache[prestamoId].saldo,
            };
          }
        } catch {}
      }, 0);

    } catch (error: any) {
      // 🔌 Offline u otro fallo → OUTBOX
      try {
        const tz = pickTZ();
        const operationalDate = todayInTZ(tz);
        await addToOutbox({
          kind: 'abono',
          payload: {
            clienteId: clienteId!,
            prestamoId: prestamoId!,
            admin: authAdminId!,                 // 👈 unificado
            monto: Number(montoNum.toFixed(2)),
            tz,
            operationalDate,
            clienteNombre: clienteNombre || 'Cliente',
            source: 'app',
            // 🔐 scoping
            tenantId: ctx?.tenantId ?? null,
            rutaId: ctx?.role === 'collector' ? ctx?.rutaId ?? null : null,
            alsoCajaDiaria: true,
            cajaPayload: {
              tipo: 'abono',
              // ❌ NO poner admin aquí: AbonoPayload.cajaPayload no lo define
              clienteNombre,
              tenantId: ctx?.tenantId ?? null,
              rutaId: ctx?.role === 'collector' ? ctx?.rutaId ?? null : null,
            },
          },
        });
        Alert.alert(
          'Sin conexión',
          'El pago se guardó en "Pendientes" y podrás reenviarlo cuando tengas internet.'
        );
      } catch (enqueueErr: any) {
        const msg = (enqueueErr?.message || '').toString();
        if (msg.includes('ya tiene un pago pendiente')) {
          Alert.alert('Pago ya pendiente', 'Este cliente ya tiene un pago pendiente sin enviar.');
        } else {
          Alert.alert(
            'Error',
            'No se pudo registrar el pago ni guardarlo en pendientes. Inténtalo nuevamente.'
          );
        }
      } finally {
        setLoading(false);
        submittingRef.current = false;
      }
    }
  };

  const hasCuota = !loadingCuota && (valorCuota > 0 || lastKnownRef.current.cuota > 0);
  const cuotaNum = lastKnownRef.current.cuota || valorCuota;

  return (
    <Modal
      visible={visible}
      animationType="none"
      transparent
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      hardwareAccelerated
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 40 : 0}
      >
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View
          style={[
            styles.overlayCenter,
            { paddingTop: Math.max(insets.top + 6, 8), paddingBottom: Math.max(insets.bottom, 6) },
          ]}
        >
          <View
            style={[styles.cardWrapper, !contentReady && { opacity: 0 }]}
            onLayout={() => setContentReady(true)}
            collapsable={false}
          >
            <View style={styles.card}>
              <Text style={styles.titulo}>Registrar pago</Text>
              <Text style={styles.cliente}>{clienteNombre || 'Cliente'}</Text>

              <View style={styles.infoBox}>
                <Text style={styles.infoText}>
                  Saldo <Text style={styles.bold}>{`R$ ${Number((loadingCuota ? lastKnownRef.current.saldo : saldoPendiente) || 0).toFixed(2)}`}</Text>
                </Text>
              </View>

              {loadingCuota ? (
                <View style={styles.prepContainer}>
                  <ActivityIndicator size="small" />
                  <Text style={styles.prepTxt}>Preparando…</Text>
                </View>
              ) : (
                <>
                  <Text style={styles.label}>Monto</Text>

                  <TextInput
                    ref={inputRef}
                    style={styles.input}
                    placeholder="0.00"
                    keyboardType="decimal-pad"
                    returnKeyType="done"
                    blurOnSubmit
                    value={monto}
                    onChangeText={(t) => { setMonto(t); montoRef.current = t; }}
                    onSubmitEditing={solicitarConfirmacion}
                    editable={!loading && !loadingCuota}
                    autoFocus
                  />

                  <View style={styles.actionsRow}>
                    {hasCuota ? (
                      <TouchableOpacity
                        onPress={() => {
                          const v = String(cuotaNum);
                          setMonto(v);
                          montoRef.current = v; // blindado
                        }}
                        style={styles.btnSec}
                        disabled={loading || loadingCuota}
                        activeOpacity={0.9}
                      >
                        <Text style={styles.btnSecTxt}>Usar cuota</Text>
                      </TouchableOpacity>
                    ) : (
                      <View style={{ flex: 1 }} />
                    )}

                    <TouchableOpacity
                      onPress={solicitarConfirmacion}
                      style={[styles.btnGuardar, (loading || loadingCuota) && { opacity: 0.7 }]}
                      disabled={loading || loadingCuota}
                      activeOpacity={0.9}
                    >
                      <Text style={styles.btnGuardarTexto}>
                        {loading ? 'Guardando…' : 'Guardar'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const GREEN = '#2e7d32';
const LIGHT = '#E8F5E9';

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.22)' },
  overlayCenter: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 0 },
  cardWrapper: {
    width: '76%', maxWidth: 320, padding: 0,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
      android: {},
    }),
  },
  card: { backgroundColor: '#fff', borderRadius: 10, overflow: 'hidden', paddingVertical: 8, paddingHorizontal: 8, alignItems: 'center' },
  titulo: { fontSize: 14, fontWeight: '800', textAlign: 'center', color: '#263238' },
  cliente: { fontSize: 12, color: '#455A64', textAlign: 'center', marginTop: 2 },
  infoBox: { backgroundColor: '#F6F8F7', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 8, marginTop: 6, alignItems: 'center', alignSelf: 'center' },
  infoText: { fontSize: 12, color: '#263238' },
  bold: { fontWeight: '900', color: '#263238' },
  prepContainer: { alignItems: 'center', justifyContent: 'center', marginTop: 12, marginBottom: 6 },
  prepTxt: { fontSize: 12, color: '#607d8b', fontWeight: '700', marginTop: 6 },
  label: { fontSize: 11, color: '#607d8b', marginTop: 8, marginBottom: 4, fontWeight: '700' },
  input: {
    width: '60%', borderWidth: 1, borderColor: '#dfe5e1', borderRadius: 8, paddingHorizontal: 10,
    paddingVertical: Platform.select({ ios: 7, android: 6 }) as number, fontSize: 15, color: '#263238', textAlign: 'center',
  },
  actionsRow: { width: '60%', flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 6, alignSelf: 'center' },
  btnSec: { flex: 1, backgroundColor: LIGHT, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  btnSecTxt: { color: GREEN, fontWeight: '800', fontSize: 12 },
  btnGuardar: { flex: 1, backgroundColor: GREEN, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  btnGuardarTexto: { color: '#fff', fontWeight: '800', fontSize: 12.5 },
});
