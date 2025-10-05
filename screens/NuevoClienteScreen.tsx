// screens/NuevoClienteScreen.tsx
import React, { useState, useMemo, useRef } from 'react';
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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { useAppTheme } from '../theme/ThemeProvider';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  });

  const [errores, setErrores] = useState<Record<string, string>>({});

  const camposObligatorios = useMemo(
    () => ['nombre', 'nit', 'direccion1', 'barrio', 'telefono1', 'genero'],
    []
  );

  // Refs para Enter → siguiente
  const refNombre = useRef<TextInput>(null);
  const refAlias = useRef<TextInput>(null);
  const refNit = useRef<TextInput>(null);
  const refDir1 = useRef<TextInput>(null);
  const refDir2 = useRef<TextInput>(null);
  const refBarrio = useRef<TextInput>(null);
  const refTel1 = useRef<TextInput>(null);
  const refTel2 = useRef<TextInput>(null);

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

  const cleanPhone = (s: string) => s.replace(/[^\d+]/g, '').replace(/^\+?/, '');
  const cleanNit = (s: string) => (s || '').trim().toUpperCase();

  const continuar = () => {
    const nuevos: Record<string, string> = {};
    for (const campo of camposObligatorios) {
      const v = (cliente as any)[campo];
      const ok = typeof v === 'string' ? v.trim() !== '' : !!v;
      if (!ok) nuevos[campo] = 'Campo obligatorio';
    }
    if (Object.keys(nuevos).length) {
      setErrores(nuevos);
      // Foco en el primer campo con error
      if (nuevos.nombre) refNombre.current?.focus();
      else if (nuevos.nit) refNit.current?.focus();
      else if (nuevos.direccion1) refDir1.current?.focus();
      else if (nuevos.barrio) refBarrio.current?.focus();
      else if (nuevos.telefono1) refTel1.current?.focus();
      return;
    }

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
    };

    navigation.navigate('NuevoPrestamo', { cliente: payload, admin });
  };

  return (
      <SafeAreaView
    style={{ flex: 1, backgroundColor: palette.screenBg }}
    edges={['left','right','bottom']}   // 👈 evita el hueco
  >
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
        keyboardVerticalOffset={68}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <ScrollView
            contentContainerStyle={[
              styles.container,
              { paddingBottom: 92 + insets.bottom },
            ]}
            keyboardShouldPersistTaps="handled"
          >
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
                inputRef={refNombre}
                returnKeyType="next"
                blurOnSubmit={false}
                onSubmitEditing={() => refAlias.current?.focus()}
              />

              <View style={styles.row2}>
                <Field
                  label="Alias"
                  value={cliente.alias}
                  onChangeText={(t) => handleChange('alias', t)}
                  autoCapitalize="words"
                  palette={palette}
                  compact
                  inputRef={refAlias}
                  returnKeyType="next"
                  blurOnSubmit={false}
                  onSubmitEditing={() => refNit.current?.focus()}
                />
                <Field
                  label="NIT"
                  value={cliente.nit}
                  onChangeText={(t) => handleChange('nit', t)}
                  error={errores.nit}
                  autoCapitalize="characters"
                  palette={palette}
                  compact
                  inputRef={refNit}
                  returnKeyType="next"
                  blurOnSubmit={false}
                  onSubmitEditing={() => refDir1.current?.focus()}
                />
              </View>

              <Field
                label="Dirección 1"
                value={cliente.direccion1}
                onChangeText={(t) => handleChange('direccion1', t)}
                error={errores.direccion1}
                autoCapitalize="words"
                palette={palette}
                inputRef={refDir1}
                returnKeyType="next"
                blurOnSubmit={false}
                onSubmitEditing={() => refDir2.current?.focus()}
              />

              <View style={styles.row2}>
                <Field
                  label="Dirección 2"
                  value={cliente.direccion2}
                  onChangeText={(t) => handleChange('direccion2', t)}
                  autoCapitalize="words"
                  palette={palette}
                  compact
                  inputRef={refDir2}
                  returnKeyType="next"
                  blurOnSubmit={false}
                  onSubmitEditing={() => refBarrio.current?.focus()}
                />
                <Field
                  label="Barrio"
                  value={cliente.barrio}
                  onChangeText={(t) => handleChange('barrio', t)}
                  error={errores.barrio}
                  autoCapitalize="words"
                  palette={palette}
                  compact
                  inputRef={refBarrio}
                  returnKeyType="next"
                  blurOnSubmit={false}
                  onSubmitEditing={() => refTel1.current?.focus()}
                />
              </View>

              <View style={styles.row2}>
                <Field
                  label="Teléfono"
                  value={cliente.telefono1}
                  onChangeText={(t) => handleChange('telefono1', t)}
                  error={errores.telefono1}
                  keyboardType="phone-pad"
                  palette={palette}
                  compact
                  inputRef={refTel1}
                  returnKeyType="next"
                  blurOnSubmit={false}
                  onSubmitEditing={() => refTel2.current?.focus()}
                />
                <Field
                  label="Teléfono 2"
                  value={cliente.telefono2}
                  onChangeText={(t) => handleChange('telefono2', t)}
                  keyboardType="phone-pad"
                  palette={palette}
                  compact
                  inputRef={refTel2}
                  returnKeyType="done"
                  blurOnSubmit
                  onSubmitEditing={continuar}
                />
              </View>

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
          </ScrollView>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>

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

function Field({
  label,
  value,
  onChangeText,
  error,
  keyboardType = 'default',
  autoCapitalize = 'none',
  compact = false,
  palette,
  inputRef,
  returnKeyType,
  blurOnSubmit,
  onSubmitEditing,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  error?: string;
  keyboardType?: 'default' | 'phone-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  compact?: boolean;
  palette: ReturnType<typeof useAppTheme>['palette'];
  /** 👇 Acepta refs que pueden ser null */
  inputRef?: React.RefObject<TextInput | null>;
  returnKeyType?: 'done' | 'next' | 'go' | 'send' | 'search';
  blurOnSubmit?: boolean;
  onSubmitEditing?: () => void;
}) {
  return (
    <View style={{ marginBottom: compact ? 12 : 16, flex: compact ? 1 : undefined }}>
      <Text style={[styles.label, { color: palette.softText }]}>{label}</Text>
      <TextInput
        ref={inputRef as any}
        style={[
          styles.input,
          {
            paddingVertical: compact ? 10 : 12,
            fontSize: compact ? 15 : 16,
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
        returnKeyType={returnKeyType}
        blurOnSubmit={blurOnSubmit}
        onSubmitEditing={onSubmitEditing}
      />
      {error ? <Text style={[styles.error, { color: '#d32f2f' }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    borderBottomWidth: 1,
    paddingVertical: 10,
    alignItems: 'center',
  },
  headerTitle: { fontSize: 18, fontWeight: '800' },

  container: {
    padding: 16,
  },

  card: {
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '900',
    marginBottom: 12,
    textAlign: 'center',
    letterSpacing: 0.2,
  },

  row2: {
    flexDirection: 'row',
    gap: 16,
  },

  label: {
    fontSize: 13,
    marginBottom: 6,
    fontWeight: '700',
  },

  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
  },

  error: {
    fontSize: 11,
    marginTop: 6,
  },

  genderRow: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 6,
  },
  genderPill: {
    flex: 1,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    paddingHorizontal: 10,
  },
  genderTxt: { fontSize: 14, fontWeight: '800' },

  ctaBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderTopWidth: 1,
    padding: 12,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: -3 },
  },
  btn: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnTxt: { color: '#fff', fontWeight: '900', fontSize: 16, letterSpacing: 0.2 },
});
