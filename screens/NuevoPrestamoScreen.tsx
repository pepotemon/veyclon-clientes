// screens/NuevoPrestamoScreen.tsx
import React, { useEffect, useState, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Modal,
  Pressable,
  Keyboard,
  BackHandler,
  ActivityIndicator,
  Platform,
  findNodeHandle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import NetInfo from '@react-native-community/netinfo';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { db } from '../firebase/firebaseConfig';
import { collection, doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { todayInTZ, pickTZ } from '../utils/timezone';
import { useAppTheme } from '../theme/ThemeProvider';
import { logAudit, pick } from '../utils/auditLogs';
import { addToOutbox } from '../utils/outbox';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
// 🔐 contexto de auth para scoping
import { getAuthCtx } from '../utils/authCtx';

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
  const { cliente, existingClienteId } = route.params as any; // 🚫 no usamos route.params.admin

  const [modalidadVisible, setModalidadVisible] = useState(false);
  const [interesVisible, setInteresVisible] = useState(false);
  const [guardando, setGuardando] = useState(false);

  const [prestamo, setPrestamo] = useState({
    modalidad: '',
    interes: '0',        // ✅ default 0%
    valorNeto: '',
    totalPrestamo: '',
    cuotas: '',
    valorCuota: '',
    fechaInicio: '',
    permitirAdelantar: true,
  });

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

  // 👇 refs para Enter → siguiente
  const refValorNeto = useRef<TextInput>(null);
  const refCuotas = useRef<TextInput>(null);

  // 👇 ref del scroll + helper para centrar el campo enfocado
  const scrollRef = useRef<any>(null);
  const focusAndScrollTo = (r: React.RefObject<TextInput | null>) => {
    setTimeout(() => {
      const node = r.current ? findNodeHandle(r.current) : null;
      r.current?.focus();
      if (node && scrollRef.current?.scrollToFocusedInput) {
        setTimeout(() => {
          scrollRef.current.scrollToFocusedInput(node, 90);
        }, 16);
      }
    }, 0);
  };

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
    if (prestamo.interes === '' || !Number.isFinite(interesPct) || interesPct < 0) {
      Alert.alert('Interés inválido', 'Selecciona un % de interés (puede ser 0%).');
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
      if (!authAdminId) {
        Alert.alert('Sesión', 'No se pudo identificar el usuario (admin). Intenta nuevamente.');
        return;
      }

      setGuardando(true);

      // --------- Detectar conectividad ----------
      let isOnline = true;
      try {
        const state = await NetInfo.fetch();
        isOnline = !!(state?.isInternetReachable ?? state?.isConnected);
      } catch {
        isOnline = true;
      }

      // --------- Datos comunes ----------
      const tzDoc = pickTZ((cliente as any)?.tz);
      const hoyIso = todayInTZ(tzDoc);
      const diasHabiles = [1, 2, 3, 4, 5, 6]; // Lun–Sáb
      const fechaInicioOperativa = nextOperativeDayStr(hoyIso, diasHabiles);
      const total = totalCalc;
      const vCuota = cuotaCalc;
      const concepto = String(cliente?.nombre ?? '').trim() || 'Sin nombre';

      // ========== OFFLINE: encolar venta ==========
// (si tu worker crea ambos: préstamo y caja)
      if (!isOnline) {
        if (!existingClienteId) {
          Alert.alert(
            'Sin conexión',
            'Para crear un cliente nuevo necesitas internet. Si ya existe el cliente, selecciónalo e intenta de nuevo.',
          );
          setGuardando(false);
          return;
        }

        try {
         await addToOutbox({
  kind: 'venta',
  payload: {
    admin: authAdminId,                // usa solo admin
    clienteId: existingClienteId,
    clienteNombre: concepto,
    valorCuota: vCuota,
    cuotas: cuotasNum,
    totalPrestamo: total,              // o montoTotal, como prefieras
    fechaInicio: fechaInicioOperativa, // 'YYYY-MM-DD'
    tz: tzDoc,
    operationalDate: hoyIso,
    retiroCaja: valor,
    meta: { modalidad: prestamo.modalidad, interesPct, valorNeto: valor },
    // 🔐 scoping
    tenantId: ctx?.tenantId ?? null,
    rutaId: ctx?.role === 'collector' ? ctx?.rutaId ?? null : null,

    alsoCajaDiaria: true,
    cajaPayload: {
      tipo: 'prestamo',
      admin: authAdminId,              // requerido por VentaCajaPayload
      clienteId: existingClienteId,
      clienteNombre: concepto,
      // el worker rellenará el id real:
      prestamoId: '__to_be_filled_by_worker__',
      monto: Number(valor),
      tz: tzDoc,
      operationalDate: hoyIso,
      meta: { modalidad: prestamo.modalidad, interesPct },
      tenantId: ctx?.tenantId ?? null,
      rutaId: ctx?.role === 'collector' ? ctx?.rutaId ?? null : null,
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

      // ========== ONLINE: batch ==========
// (cliente + préstamo + caja + índice)
      const batch = writeBatch(db);

      // 1) Cliente
      let clienteRef;
      if (existingClienteId) {
        clienteRef = doc(db, 'clientes', existingClienteId);
        const updatePayload = {
          ...(cliente?.nombre ? { nombre: cliente.nombre } : {}),
          ...(cliente?.alias ? { alias: cliente.alias } : {}),
          ...(cliente?.direccion1 ? { direccion1: cliente.direccion1 } : {}),
          ...(cliente?.telefono1 ? { telefono1: cliente.telefono1 } : {}),
          actualizadoEn: serverTimestamp(),
          // opcional: scoping para clientes si lo usas
          tenantId: ctx?.tenantId ?? null,
        };
        batch.set(clienteRef, updatePayload, { merge: true });
        void logAudit({
          userId: authAdminId,
          action: 'update',
          ref: clienteRef,
          after: pick(updatePayload, ['nombre', 'alias', 'direccion1', 'telefono1', 'tenantId']),
        });
      } else {
        clienteRef = doc(collection(db, 'clientes'));
        const clienteId = clienteRef.id;
        const createPayload = {
          ...cliente,
          creadoPor: authAdminId,            // 👈 unificado
          creadoEn: serverTimestamp(),
          id: clienteId,
          tenantId: ctx?.tenantId ?? null,
        };
        batch.set(clienteRef, createPayload);
        void logAudit({
          userId: authAdminId,
          action: 'create',
          ref: clienteRef,
          after: pick(createPayload, ['nombre', 'alias', 'direccion1', 'telefono1', 'creadoPor', 'id', 'tenantId']),
        });
      }

      // 2) Préstamo
      const prestamoRef = doc(collection(clienteRef, 'prestamos'));
      const prestamoPayload = {
        creadoPor: authAdminId,              // 👈 unificado
        creadoEn: serverTimestamp(),
        createdAtMs: Date.now(),
        createdDate: hoyIso,
        clienteId: existingClienteId ?? clienteRef.id,
        clienteNombre: concepto,
        clienteAlias: cliente?.alias ?? '',
        clienteDireccion1: cliente?.direccion1 ?? '',
        clienteTelefono1: cliente?.telefono1 ?? '',
        concepto,
        modalidad: prestamo.modalidad,
        interes: interesPct,                 // ✅ puede ser 0
        valorNeto: valor,
        totalPrestamo: total,
        montoTotal: total,
        valorCuota: vCuota,
        cuotas: cuotasNum,
        cuotasTotales: cuotasNum,
        cuotasPagadas: 0,
        restante: total,
        diasAtraso: 0,
        status: 'activo' as const,
        permitirAdelantar: true,
        fechaInicio: fechaInicioOperativa,
        tz: tzDoc,
        diasHabiles: [1, 2, 3, 4, 5, 6],
        feriados: [],
        pausas: [],
        proximoVencimiento: fechaInicioOperativa,
        dueToday: false,
        // 🔐 scoping
        tenantId: ctx?.tenantId ?? null,
        rutaId: ctx?.role === 'collector' ? ctx?.rutaId ?? null : null,
      };
      batch.set(prestamoRef, prestamoPayload);

      // 3) CajaDiaria (prestamo)
      const cajaDocId = `loan_${prestamoRef.id}`;
      const cajaRef = doc(collection(db, 'cajaDiaria'), cajaDocId);
      const cajaPayload = {
        tipo: 'prestamo' as const,
        admin: authAdminId,                  // 👈 unificado
        monto: Number(valor),
        operationalDate: hoyIso,
        tz: tzDoc,
        clienteId: existingClienteId ?? clienteRef.id,
        prestamoId: prestamoRef.id,
        clienteNombre: concepto,
        createdAt: serverTimestamp(),
        createdAtMs: Date.now(),
        meta: { modalidad: prestamo.modalidad, interesPct },
        // 🔐 scoping de caja
        tenantId: ctx?.tenantId ?? null,
        rutaId: ctx?.role === 'collector' ? ctx?.rutaId ?? null : null,
      };
      batch.set(cajaRef, cajaPayload);

      // 4) Índice clientesDisponibles
      const idxRef = doc(db, 'clientesDisponibles', existingClienteId ?? clienteRef.id);
      const idxPayload = {
        id: existingClienteId ?? clienteRef.id,
        disponible: false,
        actualizadoEn: serverTimestamp(),
        creadoPor: authAdminId,              // 👈 unificado
        alias: cliente?.alias ?? '',
        nombre: concepto,
        barrio: cliente?.barrio ?? '',
        telefono1: cliente?.telefono1 ?? '',
        // opcional: scoping si lo filtras por tenant
        tenantId: ctx?.tenantId ?? null,
      };
      batch.set(idxRef, idxPayload, { merge: true });

      await batch.commit();

      void logAudit({
        userId: authAdminId,
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
          'tenantId',
          'rutaId',
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

  // Loader hasta tener contexto (para asegurar authAdminId)
  if (!ctx || !authAdminId) {
    return (
      <SafeAreaView style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: palette.screenBg }}
      edges={['left','right','bottom']}
    >
      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder },
        ]}
      >
        <Text style={[styles.headerTitle, { color: palette.text }]}>Nuevo préstamo</Text>
      </View>

      {/* Scroll que acompaña al teclado y centra el input enfocado */}
      <KeyboardAwareScrollView
        ref={scrollRef}
        enableOnAndroid
        enableAutomaticScroll
        extraScrollHeight={100}
        keyboardOpeningTime={0}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.container}
      >
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
            onPress={() => {
              Keyboard.dismiss();
              setModalidadVisible(true);
            }}
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
            onPress={() => {
              Keyboard.dismiss();
              setInteresVisible(true);
            }}
            activeOpacity={0.85}
          >
            <Text
              style={[
                styles.selectorText,
                { color: prestamo.interes === '' ? palette.softText : palette.text },
              ]}
            >
              {prestamo.interes === '' ? 'Seleccionar' : `${toNum(prestamo.interes)}%`}
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
            onSubmitEditing={() => focusAndScrollTo(refCuotas)}
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
            blurOnSubmit
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
      </KeyboardAwareScrollView>

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
        <View style={styles.sheetOverlay}>
          <View style={[styles.sheet, { backgroundColor: palette.cardBg }]}>
            {[0, 10, 20, 25, 26].map((int) => (  // ✅ incluye 0%
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

/** ---------- Estilos ---------- */
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
    paddingVertical: Platform.select({ ios: 10, android: 9 }) as number,
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
