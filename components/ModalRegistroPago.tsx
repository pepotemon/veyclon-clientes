// components/ModalRegistroPago.tsx
import React, { useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, Keyboard,
  Platform, KeyboardAvoidingView, Pressable, Linking,
} from 'react-native';
import {
  doc, collection, addDoc, deleteDoc, runTransaction, serverTimestamp,
  updateDoc, getDoc, DocumentReference,
} from 'firebase/firestore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { db } from '../firebase/firebaseConfig';
import { todayInTZ, pickTZ } from '../utils/timezone';
import { calcularDiasAtraso } from '../utils/atrasoHelper';
import { logAudit, pick } from '../utils/auditLogs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { addToOutbox } from '../utils/outbox';

type Props = {
  visible: boolean;
  onClose: () => void;
  clienteNombre: string;
  clienteId?: string;
  prestamoId?: string;
  admin: string;
  onSuccess?: () => void;
  clienteTelefono?: string;
};

const quotaCache: Record<string, { cuota: number; saldo: number }> = {};
const KEY_SEND_RECEIPT_CONFIRM = 'prefs:sendReceiptConfirm';

/** ✅ Abrir WhatsApp sin número: deep-link → fallback web.
 *  Evitamos canOpenURL por restricciones de Android 11+ (package visibility). */
async function openWhats(text: string) {
  const encoded = encodeURIComponent(text || '');
  const deep = `whatsapp://send?text=${encoded}`;
  const web  = `https://wa.me/?text=${encoded}`;

  // 1) Intento directo a la app
  try {
    await Linking.openURL(deep);
    return;
  } catch {}

  // 2) Fallback web (navegador → WhatsApp / Play Store)
  try {
    await Linking.openURL(web);
    return;
  } catch {}

  Alert.alert(
    'WhatsApp',
    Platform.OS === 'android'
      ? 'No se pudo abrir WhatsApp. Verifica que esté instalado.'
      : 'No se pudo abrir WhatsApp en este dispositivo.'
  );
}

async function logToCajaDiaria(params: {
  admin: string;
  clienteId: string;
  prestamoId: string;
  clienteNombre: string;
  monto: number;
  tz: string;
  operationalDate: string;
}) {
  const { admin, clienteId, prestamoId, clienteNombre, monto, tz, operationalDate } = params;
  const now = Date.now();
  try {
    const ref = await addDoc(collection(db, 'cajaDiaria'), {
      tipo: 'abono',
      admin,
      clienteId,
      prestamoId,
      clienteNombre,
      monto: Number(monto.toFixed(2)),
      tz,
      operationalDate,
      createdAtMs: now,
      createdAt: serverTimestamp(),
      source: 'app',
    });
    await logAudit({
      userId: admin,
      action: 'create',
      ref,
      after: {
        admin,
        clienteId,
        prestamoId,
        monto: Number(monto.toFixed(2)),
        operationalDate,
        tipo: 'abono',
      },
    });
  } catch (e) {
    console.warn('[cajaDiaria] no se pudo registrar:', e);
  }
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

export default function ModalRegistroPago({
  visible, onClose, clienteNombre, clienteId, prestamoId, admin, onSuccess,
}: Props) {
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);

  const [monto, setMonto] = useState('');
  const [loading, setLoading] = useState(false);

  const [valorCuota, setValorCuota] = useState<number>(0);
  const [saldoPendiente, setSaldoPendiente] = useState<number>(0);

  const [prefConfirmReceipt, setPrefConfirmReceipt] = useState(false);
  const hasOpenedWhatsRef = useRef(false);

  const [contentReady, setContentReady] = useState(false);
  useEffect(() => {
    if (visible) {
      setContentReady(false);
      hasOpenedWhatsRef.current = false;
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

      try {
        const v = await AsyncStorage.getItem(KEY_SEND_RECEIPT_CONFIRM);
        setPrefConfirmReceipt(v === '1');
      } catch { setPrefConfirmReceipt(false); }

      if (!clienteId || !prestamoId) return;

      const cacheHit = quotaCache[prestamoId];
      if (cacheHit) {
        setValorCuota(cacheHit.cuota);
        setSaldoPendiente(cacheHit.saldo);
      }

      try {
        const ref = doc(db, 'clientes', clienteId, 'prestamos', prestamoId);
        const snap = await getDoc(ref);
        if (snap.exists()) {
          const d = snap.data() as any;
          const cuota = Number(d?.valorCuota ?? 0) || 0;
          const saldo = typeof d?.restante === 'number'
            ? Number(d.restante)
            : Number(d?.montoTotal ?? d?.totalPrestamo ?? 0) || 0;

          setValorCuota(cuota);
          setSaldoPendiente(saldo);
          quotaCache[prestamoId] = { cuota, saldo };
        } else {
          setValorCuota(0);
          setSaldoPendiente(0);
        }
      } catch {}
    };
    cargarInfo();
    if (!visible) setMonto('');
  }, [visible, clienteId, prestamoId]);

  const parseMonto = (txt: string) => {
    const norm = txt.replace(',', '.').trim();
    if (!/^\d+(\.\d{0,2})?$/.test(norm)) return NaN;
    return parseFloat(norm);
  };

  const solicitarConfirmacion = () => {
    const montoNum = parseMonto(monto);
    if (!isFinite(montoNum) || montoNum <= 0) {
      Alert.alert('Monto inválido', 'Ingresa un monto mayor a 0.');
      return;
    }
    // ✅ BLOQUEO: no permitir monto mayor al saldo pendiente
    if (montoNum > saldoPendiente) {
      Alert.alert(
        'Monto demasiado alto',
        `El saldo pendiente es R$ ${saldoPendiente.toFixed(2)}. Ingresa un monto menor o igual.`
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
    if (loading) return;

    onClose();
    setLoading(true);
    Keyboard.dismiss();

    const prestamoRef = doc(db, 'clientes', clienteId, 'prestamos', prestamoId);
    const abonoRef: DocumentReference = doc(collection(prestamoRef, 'abonos'));

    try {
      const txResult = await runTransaction(db, async (tx) => {
        const snap = await tx.get(prestamoRef);
        if (!snap.exists()) throw new Error('El préstamo no existe.');

        const data = snap.data() as any;
        const tz = pickTZ(data?.tz);
        const operativoHoy = todayInTZ(tz);

        const abonosPrevios: any[] = Array.isArray(data.abonos) ? data.abonos : [];
        const restanteActual = typeof data.restante === 'number' ? data.restante : data.montoTotal || 0;

        const nowMs = Date.now();
        const nuevoAbono = {
          monto: parseFloat(montoNum.toFixed(2)),
          registradoPor: admin,
          tz,
          operationalDate: operativoHoy,
          createdAtMs: nowMs,
          createdAtIso: new Date(nowMs).toISOString(),
        };

        // 1) Guardar el abono en SUBCOLECCIÓN
        tx.set(abonoRef, nuevoAbono);

        // 2) Actualizar agregados y ARRAY abonos en el préstamo (SIN serverTimestamp en el array)
        const nuevoRestante = Math.max(restanteActual - montoNum, 0);
        const nuevosAbonos = [...abonosPrevios, nuevoAbono];
        tx.update(prestamoRef, { abonos: nuevosAbonos, restante: nuevoRestante });

        // 3) Cálculos para recibo/UX
        const valorCuotaTx = Number(data?.valorCuota || 0);
        const totalCuotasTx =
          Number(data?.cuotas || 0) ||
          Math.ceil(Number(data.totalPrestamo || data.montoTotal || 0) / (valorCuotaTx || 1)) || 0;

        const totalAbonadoAcum = nuevosAbonos.reduce(
          (acc, a) => acc + (Number(a?.monto) || 0),
          0
        );

        const round2 = (n: number) => Math.round(n * 100) / 100;
        const cuota = round2(valorCuotaTx);
        const totalAbonado = round2(totalAbonadoAcum);
        const pagoActual = round2(montoNum);

        let linhaParcela = '';
        if (cuota > 0 && totalCuotasTx > 0) {
          const cuotaCents = Math.max(1, Math.round(cuota * 100));
          const totalCents = Math.max(0, Math.round(totalAbonado * 100));
          const pagoCents  = Math.max(0, Math.round(pagoActual * 100));

          const pagosCompletos = Math.floor(totalCents / cuotaCents);
          const restoCents = totalCents % cuotaCents;

          const parcelaIndex = Math.min(
            restoCents > 0 ? pagosCompletos + 1 : pagosCompletos,
            totalCuotasTx
          );

          const multiploPago = Math.floor(pagoCents / cuotaCents);

          if (restoCents > 0) {
            const faltanCents = cuotaCents - restoCents;
            const faltan = (faltanCents / 100).toFixed(2);
            linhaParcela = `Faltam R$ ${faltan} para completar a parcela #${parcelaIndex}/${totalCuotasTx}.`;
          } else if (multiploPago > 1) {
            linhaParcela = `Parcela: R$ ${cuota.toFixed(2)} (#${parcelaIndex}/${totalCuotasTx}) (x${multiploPago} parcelas)`;
          } else if (multiploPago === 1) {
            linhaParcela = `Parcela: R$ ${cuota.toFixed(2)} (#${parcelaIndex}/${totalCuotasTx})`;
          }
        }

        return {
          nuevoRestante,
          valorCuotaTx,
          totalCuotasTx,
          linhaParcela,
          prestamoBefore: pick(data, ['restante','valorCuota','totalPrestamo','clienteId','concepto']),
          abonoNuevo: nuevoAbono,
          tz,
          operativoHoy,
          prestamoData: { ...data, abonos: nuevosAbonos, restante: nuevoRestante, tz, operationalDate: operativoHoy },
        };
      });

      // Recibo por WhatsApp (opcional)
      if (prefConfirmReceipt && !hasOpenedWhatsRef.current) {
        const texto = buildReceiptPT({
          nombre: clienteNombre || 'Cliente',
          montoPagado: montoNum,
          fecha: txResult.operativoHoy,
          saldoRestante: txResult.nuevoRestante || 0,
          linhaParcela: txResult.linhaParcela,
        });
        hasOpenedWhatsRef.current = true;
        setLoading(false);
        // 👉 abre WhatsApp SIN número, con el mensaje prellenado
        void openWhats(texto);
      }

      // Marca de tiempo del último abono
      await updateDoc(doc(db, 'clientes', clienteId!, 'prestamos', prestamoId!), { lastAbonoAt: serverTimestamp() });

      // AUDIT
      await logAudit({
        userId: admin,
        action: 'create',
        ref: doc(collection(doc(db, 'clientes', clienteId!, 'prestamos', prestamoId!), 'abonos'), abonoRef.id),
        after: pick(txResult.abonoNuevo, ['monto','operationalDate','tz']),
      });

      // Caja diaria
      await logToCajaDiaria({
        admin, clienteId: clienteId!, prestamoId: prestamoId!,
        clienteNombre: clienteNombre || txResult.prestamoData?.concepto || 'Cliente',
        monto: montoNum, tz: txResult.tz, operationalDate: txResult.operativoHoy,
      });

      // Recalcular atraso (con el array abonos actualizado)
      const p = txResult.prestamoData;
      const tzDoc = pickTZ(p?.tz);
      const hoy = p.operationalDate || todayInTZ(tzDoc);

      const diasHabiles = Array.isArray(p?.diasHabiles) && p.diasHabiles.length ? p.diasHabiles : [1,2,3,4,5,6];
      const feriados = Array.isArray(p?.feriados) ? p.feriados : [];
      const pausas = Array.isArray(p?.pausas) ? p.pausas : [];
      const modo = (p?.modoAtraso as 'porPresencia' | 'porCuota') ?? 'porPresencia';
      const permitirAdelantar = !!p?.permitirAdelantar;
      const cuotas = Number(p?.cuotas || 0) ||
        Math.ceil(Number(p.totalPrestamo || p.montoTotal || 0) / (Number(p.valorCuota) || 1));

      const res = calcularDiasAtraso({
        fechaInicio: p?.fechaInicio || hoy,
        hoy,
        cuotas,
        valorCuota: Number(p?.valorCuota || 0),
        abonos: (p?.abonos || []).map((a: any) => ({
          monto: Number(a.monto) || 0,
          operationalDate: a.operationalDate,
          fecha: a.fecha,
        })),
        diasHabiles, feriados, pausas, modo, permitirAdelantar,
      });

      if (txResult.nuevoRestante > 0) {
        await updateDoc(doc(db, 'clientes', clienteId!, 'prestamos', prestamoId!), {
          diasAtraso: res.atraso, faltas: res.faltas || [], ultimaReconciliacion: serverTimestamp(),
        });
        await logAudit({
          userId: admin, action: 'update', ref: doc(db, 'clientes', clienteId!, 'prestamos', prestamoId!),
          before: txResult.prestamoBefore, after: { restante: txResult.nuevoRestante },
        });
      }

      // Mover a historial si terminó
      if (txResult.nuevoRestante === 0) {
        const historialRef = collection(db, 'clientes', clienteId!, 'historialPrestamos');
        const histRef = await addDoc(historialRef, {
          ...p,
          restante: 0, diasAtraso: 0, faltas: [],
          finalizadoEn: serverTimestamp(), finalizadoPor: admin,
        });

        await logAudit({
          userId: admin, action: 'create', ref: histRef,
          after: { clienteId, prestamoId, restante: 0, finalizadoPor: admin },
        });

        await deleteDoc(doc(db, 'clientes', clienteId!, 'prestamos', prestamoId!));

        await logAudit({
          userId: admin, action: 'delete', ref: doc(db, 'clientes', clienteId!, 'prestamos', prestamoId!),
          before: txResult.prestamoBefore, after: null,
        });
      }

      // Cache local
      if (prestamoId) {
        quotaCache[prestamoId] = {
          cuota: Number(p?.valorCuota ?? 0) || 0,
          saldo: txResult.nuevoRestante || 0,
        };
      }

      setMonto('');
      onSuccess?.(); // 👉 refresca PagosDelDia y quita del Home el cliente que ya pagó
    } catch (error: any) {
      // 🔌 Offline o fallo en la escritura remota → encolar en OUTBOX
      try {
        const tz = pickTZ();
        const operationalDate = todayInTZ(tz);

        await addToOutbox({
          kind: 'abono',
          payload: {
            clienteId: clienteId!,
            prestamoId: prestamoId!,
            admin,
            monto: parseFloat(montoNum.toFixed(2)),
            tz,
            operationalDate,
            // ✅ clienteNombre top-level (además del que va en cajaPayload)
            clienteNombre: clienteNombre || 'Cliente',
            alsoCajaDiaria: true,
            cajaPayload: { tipo: 'abono' as const, clienteNombre },
          },
        });

        Alert.alert('Sin conexión', 'El pago se guardó en "Pendientes" y podrás reenviarlo cuando tengas internet.');
      } catch (enqueueErr: any) {
        const msg = (enqueueErr?.message || '').toString();
        if (msg.includes('ya tiene un pago pendiente')) {
          // ✅ Mensaje amigable cuando la validación del outbox bloquea el 2º abono
          Alert.alert('Pago ya pendiente', 'Este cliente ya tiene un pago pendiente sin enviar.');
        } else {
          Alert.alert('Error', 'No se pudo registrar el pago ni guardarlo en pendientes. Inténtalo nuevamente.');
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const hasCuota = valorCuota > 0;
  const cuotaNum = valorCuota;

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
            styles.overlayTop,
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
                  Saldo <Text style={styles.bold}>{`R$ ${Number(saldoPendiente).toFixed(2)}`}</Text>
                </Text>
              </View>

              <Text style={styles.label}>Monto</Text>

              <TextInput
                ref={inputRef}
                style={styles.input}
                placeholder="0.00"
                keyboardType="decimal-pad"
                returnKeyType="done"
                blurOnSubmit
                value={monto}
                onChangeText={setMonto}
                onSubmitEditing={solicitarConfirmacion}
                editable={!loading}
                autoFocus
              />

              <View style={styles.actionsRow}>
                {hasCuota ? (
                  <TouchableOpacity
                    onPress={() => setMonto(String(cuotaNum))}
                    style={styles.btnSec}
                    disabled={loading}
                    activeOpacity={0.9}
                  >
                    <Text style={styles.btnSecTxt}>Usar cuota</Text>
                  </TouchableOpacity>
                ) : (
                  <View style={{ flex: 1 }} />
                )}

                <TouchableOpacity
                  onPress={solicitarConfirmacion}
                  style={[styles.btnGuardar, loading && { opacity: 0.7 }]}
                  disabled={loading}
                  activeOpacity={0.9}
                >
                  <Text style={styles.btnGuardarTexto}>{loading ? 'Guardando…' : 'Guardar'}</Text>
                </TouchableOpacity>
              </View>
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
  overlayTop: { flex: 1, justifyContent: 'flex-start', alignItems: 'center', paddingHorizontal: 0 },
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
  label: { fontSize: 11, color: '#607d8b', marginTop: 8, marginBottom: 4, fontWeight: '700' },
  input: {
    width: '60%', borderWidth: 1, borderColor: '#dfe5e1', borderRadius: 8, paddingHorizontal: 10,
    paddingVertical: Platform.select({ ios: 7, android: 6 }), fontSize: 15, color: '#263238', textAlign: 'center',
  },
  actionsRow: { width: '60%', flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 6, alignSelf: 'center' },
  btnSec: { flex: 1, backgroundColor: LIGHT, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  btnSecTxt: { color: GREEN, fontWeight: '800', fontSize: 12 },
  btnGuardar: { flex: 1, backgroundColor: GREEN, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  btnGuardarTexto: { color: '#fff', fontWeight: '800', fontSize: 12.5 },
});
