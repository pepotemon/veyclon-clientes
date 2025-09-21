// screens/NuevoPrestamoScreen.tsx
import React, { useEffect, useState, useMemo } from 'react';
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
  SafeAreaView,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { db } from '../firebase/firebaseConfig';
import { addDoc, collection, doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { todayInTZ, pickTZ } from '../utils/timezone';
import { useAppTheme } from '../theme/ThemeProvider';
import { logAudit, pick } from '../utils/auditLogs';
import { addToOutbox } from '../utils/outbox';

type Props = NativeStackScreenProps<RootStackParamList, 'NuevoPrestamo'>;

// 👉 util: dado un YYYY-MM-DD, devuelve el siguiente día operativo (Lun–Sáb por defecto)
function nextOperativeDayStr(startIso: string, diasHabiles: number[] = [1,2,3,4,5,6]) {
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

  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (modalidadVisible) { setModalidadVisible(false); return true; }
      if (interesVisible) { setInteresVisible(false); return true; }
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
      ]
    );
  };

  const guardarTodo = async () => {
    if (guardando) return;
    try {
      setGuardando(true);

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
        await setDoc(clienteRef, updatePayload, { merge: true });

        await logAudit({
          userId: admin,
          action: 'update',
          ref: clienteRef,
          after: pick(updatePayload, ['nombre','alias','direccion1','telefono1']),
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
        await setDoc(clienteRef, createPayload);

        await logAudit({
          userId: admin,
          action: 'create',
          ref: clienteRef,
          after: pick(createPayload, ['nombre','alias','direccion1','telefono1','creadoPor','id']),
        });
      }

      // 2) Datos del préstamo
      const tz = pickTZ((cliente as any)?.tz);
      const hoyIso = todayInTZ(tz);

      const diasHabiles = [1, 2, 3, 4, 5, 6]; // Lun–Sáb
      const fechaInicioOperativa = nextOperativeDayStr(hoyIso, diasHabiles);

      const total = totalCalc;
      const vCuota = cuotaCalc;

      const concepto = String(cliente?.nombre ?? '').trim() || 'Sin nombre';

      // 3) Crear /clientes/{id}/prestamos
      const prestamoPayload = {
        concepto,
        cobradorId: admin,
        montoTotal: total,
        restante: total,
        // abonos: [],  // (no guardamos arrays en el doc)

        creadoPor: admin,
        creadoEn: serverTimestamp(),
        createdAtMs: Date.now(),
        createdDate: hoyIso,

        // denormalizados
        clienteNombre: concepto,
        clienteAlias: cliente?.alias ?? '',
        clienteDireccion1: cliente?.direccion1 ?? '',
        clienteTelefono1: cliente?.telefono1 ?? '',

        modalidad: prestamo.modalidad,
        interes: interesPct,
        valorNeto: valor,
        totalPrestamo: total,
        cuotas: cuotasNum,
        valorCuota: vCuota,

        // calendario
        fechaInicio: fechaInicioOperativa,
        clienteId: existingClienteId ?? clienteRef.id,
        tz,
        diasHabiles,
        feriados: [],
        pausas: [],

        modoAtraso: 'porPresencia',
        permitirAdelantar: true,
      };

      const prestamoRef = await addDoc(collection(clienteRef, 'prestamos'), prestamoPayload);

      await logAudit({
        userId: admin,
        action: 'create',
        ref: prestamoRef,
        after: pick(prestamoPayload, [
          'concepto','cobradorId','montoTotal','restante','valorCuota','cuotas',
          'clienteId','modalidad','interes','valorNeto','fechaInicio','tz','permitirAdelantar',
          'createdDate'
        ]),
      });

      // 4) Índice /clientesDisponibles (opcional)
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
      await setDoc(idxRef, idxPayload, { merge: true });

      await logAudit({
        userId: admin,
        action: 'update',
        ref: idxRef,
        after: pick(idxPayload, ['id','disponible','alias','nombre','barrio','telefono1']),
      });

      Alert.alert('Guardado', 'Préstamo registrado correctamente.');
      navigation.popToTop();
    } catch (e) {
      console.error('❌ Error al guardar (online). Encolando para offline…', e);

      try {
        // —— OFFLINE FALLBACK: Encolar “venta” —— //
        const tz = pickTZ((cliente as any)?.tz);
        const hoyIso = todayInTZ(tz);
        const diasHabiles = [1, 2, 3, 4, 5, 6];
        const fechaInicioOperativa = nextOperativeDayStr(hoyIso, diasHabiles);

        // Si no teníamos cliente existente, pre-generamos un id local seguro para futura escritura
        const targetClienteId: string = existingClienteId ?? doc(collection(db, 'clientes')).id;

        const concepto = String(cliente?.nombre ?? '').trim() || 'Sin nombre';
        const total = totalCalc;
        const vCuota = cuotaCalc;

        await addToOutbox({
          kind: 'otro',
          payload: {
            _subkind: 'venta',
            admin,
            targetClienteId,
            clienteData: {
              nombre: cliente?.nombre ?? '',
              alias: cliente?.alias ?? '',
              direccion1: cliente?.direccion1 ?? '',
              telefono1: cliente?.telefono1 ?? '',
              barrio: cliente?.barrio ?? '',
            },
            prestamoData: {
              concepto,
              cobradorId: admin,
              montoTotal: total,
              restante: total,
              clienteNombre: concepto,
              clienteId: targetClienteId,
              modalidad: prestamo.modalidad,
              interes: interesPct,
              valorNeto: valor,
              totalPrestamo: total,
              cuotas: cuotasNum,
              valorCuota: vCuota,
              fechaInicio: fechaInicioOperativa,
              diasHabiles,
              feriados: [],
              pausas: [],
              modoAtraso: 'porPresencia',
              permitirAdelantar: true,
            },
            // Para asiento de caja (venta = valor neto desembolsado)
            caja: {
              monto: valor,
              clienteNombre: concepto,
            },
            tz,
            operationalDate: hoyIso,
            createdAtMs: Date.now(),
          },
        });

        Alert.alert('Sin conexión', 'Se guardó en "Pendientes". Cuando haya internet, se enviará automáticamente.');
        // Volvemos a Home (opcional) o nos quedamos; aquí no forzamos navegación
      } catch (ex) {
        console.error('❌ Error encolando venta offline:', ex);
        Alert.alert('Error', 'No se pudo guardar el préstamo ni en pendientes.');
      }
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

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <ScrollView contentContainerStyle={styles.container}>
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
                <Text style={[styles.selectorText, { color: prestamo.modalidad ? palette.text : palette.softText }]}>
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
                <Text style={[styles.selectorText, { color: (toNum(prestamo.interes) > 0) ? palette.text : palette.softText }]}>
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
              {guardando ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.btnTxt}>Guardar</Text>
              )}
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
                    pressed && { backgroundColor: palette.kpiTrack },
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
                    pressed && { backgroundColor: palette.kpiTrack },
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
function Label({ children, palette }: { children: React.ReactNode; palette: ReturnType<typeof useAppTheme>['palette'] }) {
  return <Text style={[styles.label, { color: palette.softText }]}>{children}</Text>;
}

function Field({
  label,
  value,
  onChangeText,
  keyboardType = 'default',
  editable = true,
  palette,
}: {
  label: string;
  value: string;
  onChangeText?: (t: string) => void;
  keyboardType?: 'default' | 'numeric';
  editable?: boolean;
  palette: ReturnType<typeof useAppTheme>['palette'];
}) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={[styles.label, { color: palette.softText }]}>{label}</Text>
      <TextInput
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
      />
    </View>
  );
}

/** ---------- Estilos (compactados) ---------- */
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
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 10,
  },
  selectorText: { fontSize: 13.5 },

  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: Platform.select({ ios: 7, android: 6 }),
    paddingHorizontal: 10,
    fontSize: 14,
  },

  btn: {
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 2,
  },
  btnTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },

  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 8,
    paddingTop: 4,
  },
  optionRow: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  optionTxt: { fontSize: 13.5, fontWeight: '600' },
});
