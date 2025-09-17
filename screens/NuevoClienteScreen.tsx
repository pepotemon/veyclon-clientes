// screens/NuevoClienteScreen.tsx
import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
  Keyboard,
  SafeAreaView,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { useAppTheme } from '../theme/ThemeProvider';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons as MIcon } from '@expo/vector-icons';

type Props = NativeStackScreenProps<RootStackParamList, 'NuevoCliente'>;

export default function NuevoClienteScreen({ navigation, route }: Props) {
  const { admin } = route.params;
  const { palette } = useAppTheme();
  const insets = useSafeAreaInsets();

  const [cliente, setCliente] = useState({
    nombre: '',
    alias: '',
    nit: '',
    direccion1: '',
    direccion2: '',
    barrio: '',
    telefono1: '',
    telefono2: '',
    genero: '',
    // ✅ LGPD / privacidad
    consentimientoContacto: false,
  });

  const [errores, setErrores] = useState<Record<string, string>>({});

  const camposObligatorios = useMemo(
    () => ['nombre', 'nit', 'direccion1', 'barrio', 'telefono1', 'genero', 'consentimientoContacto'],
    []
  );

  const handleChange = (key: keyof typeof cliente, value: any) => {
    setCliente((c) => ({ ...c, [key]: value }));
    if ((typeof value === 'string' ? value.trim() !== '' : !!value) && errores[key]) {
      setErrores((e) => {
        const cp = { ...e };
        delete cp[key];
        return cp;
      });
    }
  };

  // Normalizadores suaves
  const cleanPhone = (s: string) => s.replace(/[^\d+]/g, '').replace(/^\+?/, '');
  const cleanNit = (s: string) => (s || '').trim().toUpperCase();

  const continuar = () => {
    const nuevos: Record<string, string> = {};
    for (const campo of camposObligatorios) {
      const v = (cliente as any)[campo];
      const ok =
        campo === 'consentimientoContacto'
          ? !!v
          : typeof v === 'string'
          ? v.trim() !== ''
          : !!v;
      if (!ok) nuevos[campo] = campo === 'consentimientoContacto'
        ? 'Debes aceptar el consentimiento para contacto'
        : 'Campo obligatorio';
    }
    if (Object.keys(nuevos).length) {
      setErrores(nuevos);
      return;
    }

    // Ensamblar payload “limpio” para el siguiente paso
    const payload = {
      ...cliente,
      nit: cleanNit(cliente.nit),
      telefono1: cleanPhone(cliente.telefono1),
      telefono2: cliente.telefono2 ? cleanPhone(cliente.telefono2) : '',
      nombre: cliente.nombre.trim(),
      alias: cliente.alias.trim(),
      direccion1: cliente.direccion1.trim(),
      direccion2: cliente.direccion2.trim(),
      barrio: cliente.barrio.trim(),
      // consentimientoContacto ya está boolean
    };

    navigation.navigate('NuevoPrestamo', { cliente: payload, admin });
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg }}>
      {/* Header compacto */}
      <View
        style={[
          styles.header,
          { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder },
        ]}
      >
        <Text style={[styles.headerTitle, { color: palette.text }]}>Nuevo cliente</Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={72}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <ScrollView
            contentContainerStyle={styles.container}
            keyboardShouldPersistTaps="handled"
          >
            {/* Datos personales */}
            <View
              style={[
                styles.card,
                { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
              ]}
            >
              <Text style={[styles.sectionTitle, { color: palette.text }]}>
                Datos del cliente
              </Text>

              <Field
                label="Nombre"
                value={cliente.nombre}
                onChangeText={(t) => handleChange('nombre', t)}
                error={errores.nombre}
                autoCapitalize="words"
                palette={palette}
              />

              <Field
                label="Alias"
                value={cliente.alias}
                onChangeText={(t) => handleChange('alias', t)}
                autoCapitalize="words"
                palette={palette}
              />

              <Field
                label="NIT"
                value={cliente.nit}
                onChangeText={(t) => handleChange('nit', t)}
                error={errores.nit}
                keyboardType="default"
                autoCapitalize="characters"
                palette={palette}
              />

              <Text style={[styles.label, { color: palette.softText }]}>Género</Text>
              <View style={styles.genderRow}>
                {['Femenino', 'Masculino'].map((g) => {
                  const active = cliente.genero === g;
                  return (
                    <TouchableOpacity
                      key={g}
                      style={[
                        styles.genderPill,
                        {
                          backgroundColor: active ? palette.topBg : palette.kpiBg,
                          borderColor: active ? palette.accent : palette.cardBorder,
                        },
                      ]}
                      onPress={() => handleChange('genero', g)}
                      activeOpacity={0.9}
                    >
                      <Text
                        style={[
                          styles.genderTxt,
                          { color: active ? palette.accent : palette.softText },
                        ]}
                      >
                        {g}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {errores.genero ? (
                <Text style={[styles.error, { color: '#d32f2f' }]}>{errores.genero}</Text>
              ) : null}
            </View>

            {/* Ubicación y contacto */}
            <View
              style={[
                styles.card,
                { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
              ]}
            >
              <Text style={[styles.sectionTitle, { color: palette.text }]}>
                Ubicación y contacto
              </Text>

              <Field
                label="Dirección 1"
                value={cliente.direccion1}
                onChangeText={(t) => handleChange('direccion1', t)}
                error={errores.direccion1}
                autoCapitalize="words"
                palette={palette}
              />

              <Field
                label="Dirección 2"
                value={cliente.direccion2}
                onChangeText={(t) => handleChange('direccion2', t)}
                autoCapitalize="words"
                palette={palette}
              />

              <Field
                label="Barrio"
                value={cliente.barrio}
                onChangeText={(t) => handleChange('barrio', t)}
                error={errores.barrio}
                autoCapitalize="words"
                palette={palette}
              />

              <Field
                label="Teléfono"
                value={cliente.telefono1}
                onChangeText={(t) => handleChange('telefono1', t)}
                error={errores.telefono1}
                keyboardType="phone-pad"
                palette={palette}
              />

              <Field
                label="Teléfono 2"
                value={cliente.telefono2}
                onChangeText={(t) => handleChange('telefono2', t)}
                keyboardType="phone-pad"
                palette={palette}
              />
            </View>

            {/* Privacidad / consentimiento (LGPD) */}
            <View
              style={[
                styles.card,
                { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
              ]}
            >
              <Text style={[styles.sectionTitle, { color: palette.text }]}>
                Privacidad y consentimiento
              </Text>

              <TouchableOpacity
                style={[
                  styles.consentRow,
                  { borderColor: errores.consentimientoContacto ? '#d32f2f' : palette.cardBorder },
                ]}
                onPress={() =>
                  handleChange('consentimientoContacto', !cliente.consentimientoContacto)
                }
                activeOpacity={0.85}
              >
                <View
                  style={[
                    styles.checkbox,
                    {
                      borderColor: errores.consentimientoContacto ? '#d32f2f' : palette.cardBorder,
                      backgroundColor: cliente.consentimientoContacto ? palette.accent : 'transparent',
                    },
                  ]}
                >
                  {cliente.consentimientoContacto ? (
                    <MIcon name="check-bold" size={14} color="#fff" />
                  ) : null}
                </View>
                <Text style={{ color: palette.text, flex: 1, fontSize: 12 }}>
                  Acepto ser contactado por WhatsApp y/o llamadas sobre mi préstamo.
                </Text>
              </TouchableOpacity>
              {errores.consentimientoContacto ? (
                <Text style={[styles.error, { color: '#d32f2f' }]}>
                  {errores.consentimientoContacto}
                </Text>
              ) : null}

              <Text style={{ color: palette.softText, fontSize: 11, marginTop: 6 }}>
                Guardamos solo los datos necesarios para gestionar el préstamo. Puedes solicitar
                correcciones o eliminación cuando quieras.
              </Text>
            </View>

            {/* Espaciador para que el botón no tape el contenido */}
            <View style={{ height: 72 + insets.bottom }} />
          </ScrollView>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>

      {/* Botón fijo compacto */}
      <View
        style={[
          styles.ctaBar,
          {
            backgroundColor: palette.topBg,
            borderTopColor: palette.topBorder,
            bottom: insets.bottom,
          },
        ]}
      >
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: palette.accent }]}
          onPress={continuar}
          activeOpacity={0.92}
        >
          <Text style={styles.btnTxt}>Continuar</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

/** ---------- Pequeños ---------- */
function Field({
  label,
  value,
  onChangeText,
  error,
  keyboardType = 'default',
  autoCapitalize = 'none',
  palette,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  error?: string;
  keyboardType?: 'default' | 'phone-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  palette: ReturnType<typeof useAppTheme>['palette'];
}) {
  return (
    <View style={{ marginBottom: 8 }}>
      <Text style={[styles.label, { color: palette.softText }]}>{label}</Text>
      <TextInput
        style={[
          styles.input,
          {
            color: palette.text,
            borderColor: error ? '#d32f2f' : palette.cardBorder,
            backgroundColor: palette.cardBg,
          },
        ]}
        value={value}
        onChangeText={onChangeText}
        placeholder=""
        placeholderTextColor={palette.softText}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
      />
      {error ? <Text style={[styles.error, { color: '#d32f2f' }]}>{error}</Text> : null}
    </View>
  );
}

/** ---------- Estilos compactos ---------- */
const styles = StyleSheet.create({
  header: {
    borderBottomWidth: 1,
    paddingVertical: 8,
    alignItems: 'center',
  },
  headerTitle: { fontSize: 16, fontWeight: '700' },

  container: {
    padding: 10,
    paddingBottom: 32,
  },

  card: {
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    marginBottom: 10,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
    opacity: 0.9,
  },

  label: {
    fontSize: 11,
    marginBottom: 4,
    fontWeight: '500',
  },

  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    fontSize: 13,
  },

  error: {
    fontSize: 10,
    marginTop: 3,
  },

  genderRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
    marginBottom: 4,
  },
  genderPill: {
    flex: 1,
    height: 32,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    paddingHorizontal: 8,
  },
  genderTxt: { fontSize: 12, fontWeight: '600' },

  consentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 10,
    marginTop: 4,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  ctaBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderTopWidth: 1,
    padding: 8,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: -2 },
  },
  btn: {
    paddingVertical: 10,
    borderRadius: 9,
    alignItems: 'center',
  },
  btnTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
