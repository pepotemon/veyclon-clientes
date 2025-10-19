// screens/LoginScreen.tsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Alert,
  ActivityIndicator, KeyboardAvoidingView, Platform
} from 'react-native';
import Checkbox from 'expo-checkbox';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { useAppTheme } from '../theme/ThemeProvider';

import { signInWithEmailAndPassword, getIdTokenResult } from 'firebase/auth';
import { auth, db } from '../firebase/firebaseConfig';
import { doc, getDoc } from 'firebase/firestore';

import { setSessionUser, getFullSession, DECOY_FLAG } from '../utils/session';

type Props = NativeStackScreenProps<RootStackParamList, 'Login'>;

const TENANT = 'cobrox'; // <-- cambia si tu tenant es otro

const STORAGE_KEYS = {
  remember: '@login/remember',
  username: '@login/username',
  legacyPassword: '@login/password', // si existía de versiones previas, la borramos
};

export default function LoginScreen({ navigation }: Props) {
  const { palette } = useAppTheme();

  const [ident, setIdent] = useState('');     // usuario o email
  const [secret, setSecret] = useState('');   // PIN/Password (NO se guarda)
  const [remember, setRemember] = useState<boolean>(false);

  const [autofilling, setAutofilling] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(false);

  // 🧠 Arranque: 1) si hay flag → DecoyRetro y listo; 2) si no hay flag y hay sesión → Home
  useEffect(() => {
    (async () => {
      try {
        const flag = await AsyncStorage.getItem(DECOY_FLAG);
        if (flag === '1') {
          await AsyncStorage.removeItem(DECOY_FLAG);
          navigation.navigate('DecoyRetro' as never);
          return; // ⛔️ no sigas: evita loop con sesión previa
        }

        const session = await getFullSession();
        if (session?.admin) {
          navigation.reset({
            index: 0,
            routes: [{ name: 'Home' as never, params: { admin: session.admin } as never }],
          });
          return;
        }
      } catch {
        // ignora errores de storage
      }
    })();
  }, [navigation]);

  // Autorrelleno SOLO del usuario; limpieza de password legacy
  useEffect(() => {
    (async () => {
      try {
        const [rememberStr, savedUser, legacyPass] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.remember),
          AsyncStorage.getItem(STORAGE_KEYS.username),
          AsyncStorage.getItem(STORAGE_KEYS.legacyPassword),
        ]);
        const remembered = rememberStr === 'true';
        setRemember(remembered);
        if (remembered) setIdent(savedUser ?? '');
        if (legacyPass) await AsyncStorage.removeItem(STORAGE_KEYS.legacyPassword);
      } catch (e) {
        console.warn('No se pudieron cargar credenciales guardadas', e);
      } finally {
        setAutofilling(false);
      }
    })();
  }, []);

  // Si el input trae @, es email real; si no, generamos email sintético
  const resolvedEmail = useMemo(() => {
    const raw = (ident || '').trim().toLowerCase();
    if (!raw) return '';
    return raw.includes('@') ? raw : `${raw}@${TENANT}.veyclon.local`;
  }, [ident]);

  const manejarLogin = async () => {
    if (!resolvedEmail || !secret) {
      Alert.alert('Completa los campos', 'Ingresa usuario/email y PIN/Password.');
      return;
    }

    setLoading(true);
    try {
      // 1️⃣ Login Firebase
      const cred = await signInWithEmailAndPassword(auth, resolvedEmail, secret);

      // 2️⃣ Claims y perfil Firestore
      const tokenRes = await getIdTokenResult(cred.user, true);
      const claims = tokenRes.claims as any;
      const perfilRef = doc(db, 'usuarios', cred.user.uid);
      const perfilSnap = await getDoc(perfilRef);
      const perfil = perfilSnap.exists() ? (perfilSnap.data() as any) : null;

      // 3️⃣ Derivar admin string
      const localPart = resolvedEmail.split('@')[0];
      const admin = localPart || cred.user.uid;

      // 4️⃣ Guardar sesión
      await setSessionUser(admin, {
        uid: cred.user.uid,
        email: resolvedEmail,
        tenantId: claims.tenantId ?? perfil?.tenantId ?? null,
        role: (claims.role as any) ?? (perfil?.role as any) ?? null,
        rutaId: (claims.rutaId as any) ?? (perfil?.rutaId as any) ?? null,
        nombre: perfil?.nombre ?? null,
        ciudad: perfil?.ciudad ?? null,
      });

      // 5️⃣ Guardar usuario si “recordar” está activo (tipado correcto)
      if (remember) {
        await AsyncStorage.multiSet([
          [STORAGE_KEYS.remember, 'true'],
          [STORAGE_KEYS.username, ident || ''],
        ] as [string, string][]);
      } else {
        await AsyncStorage.multiRemove([STORAGE_KEYS.remember, STORAGE_KEYS.username] as string[]);
      }

      // 6️⃣ Ir a Home
      navigation.reset({
        index: 0,
        routes: [{ name: 'Home' as never, params: { admin } as never }],
      });
    } catch (e) {
      console.warn('Login error:', e);
      Alert.alert('Error', 'No se pudo iniciar sesión. Revisa tus credenciales.');
    } finally {
      setLoading(false);
    }
  };

  if (autofilling) {
    return (
      <View style={[styles.centered, { backgroundColor: palette.screenBg }]}>
        <ActivityIndicator size="large" color={palette.accent} />
        <Text style={{ marginTop: 10, color: palette.text }}>Preparando formulario...</Text>
      </View>
    );
  }

  const isEmail = ident.includes('@');

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: palette.screenBg }}
      behavior={Platform.select({ ios: 'padding', android: undefined })}
    >
      <View style={[styles.container, { backgroundColor: palette.screenBg }]}>
        <Text style={[styles.title, { color: palette.text }]}>Iniciar sesión</Text>

        <TextInput
          style={[
            styles.input,
            { color: palette.text, borderColor: palette.cardBorder, backgroundColor: palette.cardBg },
          ]}
          placeholder="Usuario o correo"
          placeholderTextColor={palette.softText}
          value={ident}
          onChangeText={setIdent}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          textContentType="username"
          keyboardType="email-address"
          editable={!loading}
          returnKeyType="next"
        />
        {!isEmail && !!ident && (
          <Text style={{ color: palette.softText, fontSize: 12, marginTop: -6, marginBottom: 8 }}>
            Se usará: <Text style={{ fontFamily: 'monospace' }}>{`*@${TENANT}.veyclon.local`}</Text>
          </Text>
        )}

        <TextInput
          style={[
            styles.input,
            { color: palette.text, borderColor: palette.cardBorder, backgroundColor: palette.cardBg },
          ]}
          placeholder="PIN / Contraseña"
          placeholderTextColor={palette.softText}
          value={secret}
          onChangeText={setSecret}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="password"
          textContentType="password"
          editable={!loading}
          returnKeyType="done"
          onSubmitEditing={manejarLogin}
        />

        <View style={styles.row}>
          <Checkbox
            style={[styles.checkbox, { borderColor: palette.cardBorder, backgroundColor: palette.kpiBg }]}
            value={remember}
            onValueChange={setRemember}
            color={remember ? palette.accent : undefined}
          />
          <Text style={[styles.checkboxLabel, { color: palette.text }]}>
            Recordar mi usuario (no guarda PIN)
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.button, { backgroundColor: palette.accent }]}
          onPress={manejarLogin}
          activeOpacity={0.9}
          disabled={loading}
        >
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Ingresar</Text>}
        </TouchableOpacity>

        <Text style={[styles.note, { color: palette.softText }]}>
          Por seguridad, la contraseña no se guarda en el dispositivo.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 20 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 26, fontWeight: 'bold', marginBottom: 24, textAlign: 'center' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  checkbox: { width: 22, height: 22, borderWidth: 1, borderRadius: 4 },
  checkboxLabel: { marginLeft: 8 },
  button: { padding: 14, borderRadius: 8, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  note: { marginTop: 10, fontSize: 12, textAlign: 'center' },
});
