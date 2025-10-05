// screens/NuevoPrestamoScreen.tsx
import React, { useEffect, useState, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Modal,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
  Keyboard,
  BackHandler,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import NetInfo from '@react-native-community/netinfo';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { db } from '../firebase/firebaseConfig';
import {
  collection,
  doc,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { todayInTZ, pickTZ } from '../utils/timezone';
import { useAppTheme } from '../theme/ThemeProvider';
import { logAudit, pick } from '../utils/auditLogs';
import { addToOutbox } from '../utils/outbox';

type Props = NativeStackScreenProps<RootStackParamList, 'NuevoPrestamo'>;

// 👉 util: dado un YYYY-MM-DD, devuelve el siguiente día operativo (Lun–Sáb por defecto)
function nextOperativeDayStr(startIso: string, diasHabiles: number[] = [1, 2, 3, 4, 5, 6]) {
  const [y, m, d] = startIso.split('-').map(Number);
  let cur = new Date(y, (m || 1) - 1, d || 1);
  cur.setDate(cur.getDate() + 1);
  for (let i = 0; i < 14; i++) {
    const dow = cur.getDay(); // 0=Dom,..,6=Sab
    if (diasHabiles.includes(dow)) break;
    cur.setDate(cur.getDate() + 1);
  }
  const yy = cur.getFullYear();
  const mm = String(cur.getMonth() + 1).padStart(2, '0');
  const dd = String(cur.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export default function NuevoPrestamoScreen({ route, navigation }: Props) {
  const { palette } = useAppTheme();
  const { cliente, admin, existingClienteId } = route.params as any;

  const [modalidadVisible, setModalidadVisible] = useState(false);
  const [interesVisible, setInteresVisible] = useState(false);
  const [guardando, setGuardando] = useState(false);

  const [prestamo, setPrestamo] = useState({
    modalidad: '',
    interes: '0',
    valorNeto: '',
    totalPrestamo: '',
    cuotas: '',
    valorCuota: '',
    fechaInicio: '',
    permitirAdelantar: true,
  });

  // 👇 refs para Enter → siguiente
  const refValorNeto = useRef<TextInput>(null);
  const refCuotas = useRef<TextInput>(null);

  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (modalidadVisible) {
        setModalidadVisible(false);
        return true;
      }
      if (interesVisible) {
        setInteresVisible(false);
        return true;
      }
      return false;
    });
    return () => backHandler.remove();
  }, [modalidadVisible, interesVisible]);

  const toNum = (s: string) => {
    const x = parseFloat((s ?? '').replace(',', '.'));
    return Number.isFinite(x) ? x : 0;
  };

  const valor = toNum(prestamo.valorNeto);
  const interesPct = toNum(prestamo.interes);
  const cuotasNum = Math.max(0, Math.trunc(toNum(prestamo.cuotas)));

  const totalCalc = useMemo(() => {
    if (valor <= 0) return 0;
    return +(valor + (valor * interesPct) / 100).toFixed(2);
  }, [valor, interesPct]);

  const cuotaCalc = useMemo(() => {
    if (totalCalc <= 0 || cuotasNum <= 0) return 0;
    return +(totalCalc / cuotasNum).toFixed(2);
  }, [totalCalc, cuotasNum]);

  useEffect(() => {
    setPrestamo((p) => ({
      ...p,
      totalPrestamo: totalCalc ? totalCalc.toFixed(2) : '',
      valorCuota: cuotaCalc ? cuotaCalc.toFixed(2) : '',
    }));
  }, [totalCalc, cuotaCalc]);

  const handleChange = (key: keyof typeof prestamo, value: any) => {
    setPrestamo((p) => ({ ...p, [key]: value }));
  };

  const confirmarGuardado = () => {
    if (!prestamo.modalidad) {
      Alert.alert('Falta modalidad', 'Selecciona la modalidad del préstamo.');
      return;
    }
    if (interesPct <= 0) {
      Alert.alert('Falta interés', 'Selecciona el % de interés.');
      return;
    }
    if (valor <= 0) {
      Alert.alert('Valor inválido', 'Ingresa el valor neto del préstamo.');
      return;
    }
    if (cuotasNum <= 0) {
      Alert.alert('Cuotas inválidas', 'Ingresa la cantidad de cuotas.');
      return;
    }

    Alert.alert(
      'Confirmar',
      existingClienteId
        ? '¿Guardar este préstamo para el cliente seleccionado?'
        : '¿Guardar cliente y préstamo?',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Guardar', onPress: guardarTodo },
      ],
    );
  };

  const guardarTodo = async () => {
    if (guardando) return;
    try {
      setGuardando(true);

      // --------- Detectar conectividad ----------
      let isOnline = true;
      try {
        const state = await NetInfo.fetch();
        isOnline = !!(state?.isInternetReachable ?? state?.isConnected);
      } catch {
        isOnline = true; // si NetInfo falla, intentamos online
      }

      // --------- Datos comunes ----------
      const tz = pickTZ((cliente as any)?.tz);
      const hoyIso = todayInTZ(tz);
      const diasHabiles = [1, 2, 3, 4, 5, 6]; // Lun–Sáb
      const fechaInicioOperativa = nextOperativeDayStr(hoyIso, diasHabiles);
      const total = totalCalc;
      const vCuota = cuotaCalc;
      const concepto = String(cliente?.nombre ?? '').trim() || 'Sin nombre';

      // ========== OFFLINE: encolar venta ==========
      if (!isOnline) {
        if (!existingClienteId) {
          Alert.alert(
            'Sin conexión',
            'Para crear un cliente nuevo necesitas internet. Si ya existe el cliente, selecciónalo e intenta de nuevo.',
          );
          return;
        }

        try {
          await addToOutbox({
            kind: 'venta',
            payload: {
              admin,
              clienteId: existingClienteId,
              clienteNombre: concepto,
              valorCuota: vCuota,
              cuotas: cuotasNum,
              totalPrestamo: total,
              fechaInicio: fechaInicioOperativa,
              tz,
              operationalDate: hoyIso,
              // Dinero que sale de caja al entregar el préstamo (retiro)
              retiroCaja: valor,
              meta: {
                modalidad: prestamo.modalidad,
                interesPct,
                valorNeto: valor,
              },
            },
          });

          Alert.alert(
            'Sin conexión',
            'El nuevo préstamo se guardó en "Pendientes" y se enviará cuando vuelvas a tener internet.',
          );
          navigation.popToTop();
          return;
        } catch (err) {
          console.error('❌ No se pudo encolar venta:', err);
          Alert.alert('Error', 'No se pudo guardar en pendientes. Inténtalo nuevamente.');
          return;
        } finally {
          setGuardando(false);
        }
      }

      // ========== ONLINE: batch (2–4 writes efectivos) ==========
      const batch = writeBatch(db);

      // 1) Crear/actualizar cliente en /clientes
      let clienteRef;
      if (existingClienteId) {
        clienteRef = doc(db, 'clientes', existingClienteId);
        const updatePayload = {
          ...(cliente?.nombre ? { nombre: cliente.nombre } : {}),
          ...(cliente?.alias ? { alias: cliente.alias } : {}),
          ...(cliente?.direccion1 ? { direccion1: cliente.direccion1 } : {}),
          ...(cliente?.telefono1 ? { telefono1: cliente.telefono1 } : {}),
          actualizadoEn: serverTimestamp(),
        };
        batch.set(clienteRef, updatePayload, { merge: true });

        // 🔍 AUDIT (best-effort)
        void logAudit({
          userId: admin,
          action: 'update',
          ref: clienteRef,
          after: pick(updatePayload, ['nombre', 'alias', 'direccion1', 'telefono1']),
        });
      } else {
        clienteRef = doc(collection(db, 'clientes'));
        const clienteId = clienteRef.id;
        const createPayload = {
          ...cliente,
          creadoPor: admin,
          creadoEn: serverTimestamp(),
          id: clienteId,
        };
        batch.set(clienteRef, createPayload);

        // 🔍 AUDIT
        void logAudit({
          userId: admin,
          action: 'create',
          ref: clienteRef,
          after: pick(createPayload, ['nombre', 'alias', 'direccion1', 'telefono1', 'creadoPor', 'id']),
        });
      }

      // 2) Crear préstamo con campos **denormalizados** y **agregados** iniciales
      const prestamoRef = doc(collection(clienteRef, 'prestamos')); // ID anticipado (para caja)
      const prestamoPayload = {
        // Identidad / tracking
        creadoPor: admin,
        creadoEn: serverTimestamp(),
        createdAtMs: Date.now(),
        createdDate: hoyIso, // ✅ YYYY-MM-DD en TZ del préstamo
        clienteId: existingClienteId ?? clienteRef.id,

        // Denormalizados del cliente (para evitar joins)
        clienteNombre: concepto,
        clienteAlias: cliente?.alias ?? '',
        clienteDireccion1: cliente?.direccion1 ?? '',
        clienteTelefono1: cliente?.telefono1 ?? '',

        // Esquema de negocio
        concepto, // visible en UI
        modalidad: prestamo.modalidad,
        interes: interesPct,
        valorNeto: valor,
        totalPrestamo: total, // alias
        montoTotal: total, // compat
        valorCuota: vCuota,
        cuotas: cuotasNum, // compat
        cuotasTotales: cuotasNum, // ✅ agregado explícito
        cuotasPagadas: 0, // ✅ agregado
        restante: total, // ✅ agregado
        diasAtraso: 0, // ✅ agregado
        status: 'activo' as const, // ✅ filtro principal
        permitirAdelantar: true,

        // Calendario / control
        fechaInicio: fechaInicioOperativa,
        tz,
        diasHabiles,
        feriados: [],
        pausas: [],
        proximoVencimiento: fechaInicioOperativa, // ✅ agregado
        dueToday: false, // ✅ agregado
      };
      batch.set(prestamoRef, prestamoPayload);

      // 3) CajaDiaria: asiento del **capital entregado** (tipo 'prestamo')
      //    ID determinístico para evitar duplicados si el usuario toca dos veces
      const cajaDocId = `loan_${prestamoRef.id}`;
      const cajaRef = doc(collection(db, 'cajaDiaria'), cajaDocId);
      const cajaPayload = {
        tipo: 'prestamo' as const,
        admin,
        monto: Number(valor),
        operationalDate: hoyIso,
        tz,
        clienteId: existingClienteId ?? clienteRef.id,
        prestamoId: prestamoRef.id,
        clienteNombre: concepto,
        createdAt: serverTimestamp(),
        createdAtMs: Date.now(),
        meta: { modalidad: prestamo.modalidad, interesPct },
      };
      batch.set(cajaRef, cajaPayload);

      // 4) (Opcional pero recomendado) Índice clientesDisponibles
      const idxRef = doc(db, 'clientesDisponibles', existingClienteId ?? clienteRef.id);
      const idxPayload = {
        id: existingClienteId ?? clienteRef.id,
        disponible: false,
        actualizadoEn: serverTimestamp(),
        creadoPor: admin,
        alias: cliente?.alias ?? '',
        nombre: concepto,
        barrio: cliente?.barrio ?? '',
        telefono1: cliente?.telefono1 ?? '',
      };
      batch.set(idxRef, idxPayload, { merge: true });

      // Commit único
      await batch.commit();

      // 🔍 AUDIT: préstamo creado (best-effort)
      void logAudit({
        userId: admin,
        action: 'create',
        ref: prestamoRef,
        after: pick(prestamoPayload, [
          'concepto',
          'montoTotal',
          'restante',
          'valorCuota',
          'cuotasTotales',
          'cuotasPagadas',
          'status',
          'clienteId',
          'modalidad',
          'interes',
          'valorNeto',
          'fechaInicio',
          'tz',
          'permitirAdelantar',
          'createdDate',
        ]),
      });

      Alert.alert('Guardado', 'Préstamo registrado correctamente.');
      navigation.popToTop();
    } catch (e) {
      console.error('❌ Error al guardar:', e);
      Alert.alert('Error', 'No se pudo guardar el préstamo.');
    } finally {
      setGuardando(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg }}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder },
        ]}
      >
        <Text style={[styles.headerTitle, { color: palette.text }]}>Nuevo préstamo</Text>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
            {/* Card 1: Parámetros */}
            <View
              style={[
                styles.card,
                { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
              ]}
            >
              <Text style={[styles.sectionTitle, { color: palette.text }]}>Parámetros</Text>

              <Label palette={palette}>Modalidad *</Label>
              <TouchableOpacity
                style={[
                  styles.selector,
                  { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
                ]}
                onPress={() => setModalidadVisible(true)}
                activeOpacity={0.85}
              >
                <Text
                  style={[
                    styles.selectorText,
                    { color: prestamo.modalidad ? palette.text : palette.softText },
                  ]}
                >
                  {prestamo.modalidad || 'Seleccionar'}
                </Text>
              </TouchableOpacity>

              <Label palette={palette}>Interés (%) *</Label>
              <TouchableOpacity
                style={[
                  styles.selector,
                  { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
                ]}
                onPress={() => setInteresVisible(true)}
                activeOpacity={0.85}
              >
                <Text
                  style={[
                    styles.selectorText,
                    { color: toNum(prestamo.interes) > 0 ? palette.text : palette.softText },
                  ]}
                >
                  {toNum(prestamo.interes) > 0 ? `${prestamo.interes}%` : 'Seleccionar'}
                </Text>
              </TouchableOpacity>

              <Text style={{ color: palette.softText, fontSize: 10, marginTop: 4 }}>
                * Adelantar cuotas está activo por defecto para este préstamo.
              </Text>
            </View>

            {/* Card 2: Montos */}
            <View
              style={[
                styles.card,
                { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
              ]}
            >
              <Text style={[styles.sectionTitle, { color: palette.text }]}>Montos</Text>

              <Field
                label="Valor neto (R$)"
                value={prestamo.valorNeto}
                onChangeText={(v) => handleChange('valorNeto', v)}
                keyboardType="numeric"
                palette={palette}
                inputRef={refValorNeto}
                returnKeyType="next"
                blurOnSubmit={false}
                onSubmitEditing={() => refCuotas.current?.focus()}
              />

              <Field
                label="Total préstamo (calculado)"
                value={prestamo.totalPrestamo}
                editable={false}
                palette={palette}
              />

              <Field
                label="Número de cuotas"
                value={prestamo.cuotas}
                onChangeText={(v) => handleChange('cuotas', v)}
                keyboardType="numeric"
                palette={palette}
                inputRef={refCuotas}
                returnKeyType="done"
                blurOnSubmit={true}
                onSubmitEditing={confirmarGuardado}
              />

              <Field
                label="Valor por cuota (calculado)"
                value={prestamo.valorCuota}
                editable={false}
                palette={palette}
              />
            </View>

            {/* Botón guardar */}
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: palette.accent }, guardando && { opacity: 0.7 }]}
              onPress={confirmarGuardado}
              disabled={guardando}
              activeOpacity={0.9}
            >
              {guardando ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnTxt}>Guardar</Text>}
            </TouchableOpacity>
          </ScrollView>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>

      {/* Picker Modalidad */}
      <Modal
        visible={modalidadVisible}
        transparent
        animationType="none"
        onRequestClose={() => setModalidadVisible(false)}
        presentationStyle="overFullScreen"
        statusBarTranslucent
        hardwareAccelerated
      >
        <TouchableWithoutFeedback onPress={() => setModalidadVisible(false)}>
          <View style={styles.sheetOverlay}>
            <View style={[styles.sheet, { backgroundColor: palette.cardBg }]}>
              {['Diaria', 'Semanal', 'Quincenal', 'Mensual'].map((modo) => (
                <Pressable
                  key={modo}
                  onPress={() => {
                    setModalidadVisible(false);
                    handleChange('modalidad', modo);
                  }}
                  style={({ pressed }) => [
                    styles.optionRow,
                    { borderBottomColor: palette.cardBorder },
                    pressed && { opacity: 0.9 },
                  ]}
                >
                  <Text style={[styles.optionTxt, { color: palette.text }]}>{modo}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* Picker Interés */}
      <Modal
        visible={interesVisible}
        transparent
        animationType="none"
        onRequestClose={() => setInteresVisible(false)}
        presentationStyle="overFullScreen"
        statusBarTranslucent
        hardwareAccelerated
      >
        <TouchableWithoutFeedback onPress={() => setInteresVisible(false)}>
          <View style={styles.sheetOverlay}>
            <View style={[styles.sheet, { backgroundColor: palette.cardBg }]}>
              {[10, 20, 25, 26].map((int) => (
                <Pressable
                  key={int}
                  onPress={() => {
                    setInteresVisible(false);
                    handleChange('interes', String(int));
                  }}
                  style={({ pressed }) => [
                    styles.optionRow,
                    { borderBottomColor: palette.cardBorder },
                    pressed && { opacity: 0.9 },
                  ]}
                >
                  <Text style={[styles.optionTxt, { color: palette.text }]}>{int}%</Text>
                </Pressable>
              ))}
            </View>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </SafeAreaView>
  );
}

/** ---------- Componentes pequeños ---------- */
function Label({
  children,
  palette,
}: {
  children: React.ReactNode;
  palette: ReturnType<typeof useAppTheme>['palette'];
}) {
  return <Text style={[styles.label, { color: palette.softText }]}>{children}</Text>;
}

function Field({
  label,
  value,
  onChangeText,
  keyboardType = 'default',
  editable = true,
  palette,
  inputRef,
  returnKeyType,
  blurOnSubmit,
  onSubmitEditing,
}: {
  label: string;
  value: string;
  onChangeText?: (t: string) => void;
  keyboardType?: 'default' | 'numeric';
  editable?: boolean;
  palette: ReturnType<typeof useAppTheme>['palette'];
  inputRef?: React.RefObject<TextInput | null>;
  returnKeyType?: 'done' | 'next' | 'go' | 'send' | 'search';
  blurOnSubmit?: boolean;
  onSubmitEditing?: () => void;
}) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={[styles.label, { color: palette.softText }]}>{label}</Text>
      <TextInput
        ref={inputRef as any}
        style={[
          styles.input,
          {
            color: palette.text,
            borderColor: palette.cardBorder,
            backgroundColor: editable ? palette.cardBg : palette.kpiTrack,
          },
        ]}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        editable={editable}
        returnKeyType={returnKeyType}
        blurOnSubmit={blurOnSubmit}
        onSubmitEditing={onSubmitEditing}
      />
    </View>
  );
}

/** ---------- Estilos (con opciones más grandes) ---------- */
const styles = StyleSheet.create({
  header: {
    borderBottomWidth: 1,
    paddingVertical: 8,
    alignItems: 'center',
  },
  headerTitle: { fontSize: 16, fontWeight: '800' },

  container: {
    padding: 12,
    paddingBottom: 80,
  },

  card: {
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    marginBottom: 10,
  },
  sectionTitle: { fontSize: 13, fontWeight: '800', marginBottom: 8 },

  label: { fontSize: 11, marginBottom: 5, fontWeight: '700' },

  selector: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  selectorText: { fontSize: 15 },

  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: Platform.select({ ios: 10, android: 9 }),
    paddingHorizontal: 12,
    fontSize: 16,
  },

  btn: {
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  btnTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },

  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingBottom: 8,
    paddingTop: 4,
  },
  optionRow: {
    paddingVertical: 18,
    paddingHorizontal: 18,
    borderBottomWidth: 1,
  },
  optionTxt: { fontSize: 17, fontWeight: '700' },
});
