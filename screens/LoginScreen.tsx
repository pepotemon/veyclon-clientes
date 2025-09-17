// screens/LoginScreen.tsx
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import Checkbox from 'expo-checkbox';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { useAppTheme } from '../theme/ThemeProvider';

// 🔐 Nuevo: consultas acotadas y helpers de sesión
import { findUserByLogin, passwordMatches } from '../utils/userLookup';
import { setSessionUser } from '../utils/session';

type Props = NativeStackScreenProps<RootStackParamList, 'Login'>;

const STORAGE_KEYS = {
  remember: '@login/remember',
  username: '@login/username',
  password: '@login/password', // legacy (lo eliminamos si existe)
};

export default function LoginScreen({ navigation }: Props) {
  const { palette } = useAppTheme();

  const [usuario, setUsuario] = useState('');      // usuario o correo
  const [contraseña, setContraseña] = useState(''); // NO se guardará
  const [remember, setRemember] = useState<boolean>(false);

  const [autofilling, setAutofilling] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(false);

  // Autocompletar SOLO el usuario si el usuario marcó "Recordar"
  // y borrar cualquier password legacy almacenada previamente.
  useEffect(() => {
    const loadSaved = async () => {
      try {
        const [rememberStr, savedUser, legacyPass] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.remember),
          AsyncStorage.getItem(STORAGE_KEYS.username),
          AsyncStorage.getItem(STORAGE_KEYS.password), // legacy
        ]);

        const remembered = rememberStr === 'true';
        setRemember(remembered);
        if (remembered) {
          setUsuario(savedUser ?? '');
        }

        // 🔒 Limpieza: si había contraseña guardada de versiones anteriores, elimínala
        if (legacyPass) {
          await AsyncStorage.removeItem(STORAGE_KEYS.password);
        }
      } catch (e) {
        console.warn('No se pudieron cargar credenciales guardadas', e);
      } finally {
        setAutofilling(false);
      }
    };
    loadSaved();
  }, []);

  const manejarLogin = async () => {
    const loginVal = usuario.trim();
    const passVal = contraseña; // no trim para no romper casos raros

    if (!loginVal || !passVal) {
      Alert.alert('Completa los campos', 'Ingresa usuario/correo y contraseña.');
      return;
    }

    setLoading(true);
    try {
      // 🔎 Lookup acotado: primero por usuario, luego por correo (limit 1)
      const user = await findUserByLogin(loginVal);
      if (!user) {
        Alert.alert('Usuario no encontrado', 'Revisa el usuario o correo.');
        return;
      }

      // ✅ Compat: passwordMatches (password/pass) + soporte 'contraseña' (campo con tilde)
      const matches =
        passwordMatches(passVal, user as any) ||
        (user as any)?.contraseña === passVal;

      if (!matches) {
        Alert.alert('Contraseña incorrecta', 'Vuelve a intentarlo.');
        return;
      }

      // Persistir SOLO la sesión (sin contraseña)
      const admin = (user as any)?.usuario || user.id; // muchos screens esperan "admin"
      await setSessionUser(admin, { ...user, password: undefined, pass: undefined, contraseña: undefined });

      // “Recordar” sólo guarda el usuario (no la contraseña)
      if (remember) {
        await AsyncStorage.multiSet([
          [STORAGE_KEYS.remember, 'true'],
          [STORAGE_KEYS.username, admin],
        ]);
      } else {
        await AsyncStorage.multiRemove([STORAGE_KEYS.remember, STORAGE_KEYS.username]);
      }

      // Navegar a Home (ajusta la ruta si tu flujo difiere)
      navigation.reset({
        index: 0,
        routes: [{ name: 'Home', params: { admin } }],
      });
    } catch (e) {
      console.warn('Login error:', e);
      Alert.alert('Error', 'No se pudo iniciar sesión en este momento.');
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
            {
              color: palette.text,
              borderColor: palette.cardBorder,
              backgroundColor: palette.cardBg,
            },
          ]}
          placeholder="Usuario o correo"
          placeholderTextColor={palette.softText}
          value={usuario}
          onChangeText={setUsuario}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          textContentType="username"
          keyboardType="email-address"
          editable={!loading}
          returnKeyType="next"
        />

        <TextInput
          style={[
            styles.input,
            {
              color: palette.text,
              borderColor: palette.cardBorder,
              backgroundColor: palette.cardBg,
            },
          ]}
          placeholder="Contraseña"
          placeholderTextColor={palette.softText}
          value={contraseña}
          onChangeText={setContraseña}
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
            style={[
              styles.checkbox,
              { borderColor: palette.cardBorder, backgroundColor: palette.kpiBg },
            ]}
            value={remember}
            onValueChange={setRemember}
            color={remember ? palette.accent : undefined}
          />
          <Text style={[styles.checkboxLabel, { color: palette.text }]}>
            Recordar mi usuario (no guarda contraseña)
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.button, { backgroundColor: palette.accent }]}
          onPress={manejarLogin}
          activeOpacity={0.9}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Ingresar</Text>
          )}
        </TouchableOpacity>

        <Text style={[styles.note, { color: palette.softText }]}>
          Por seguridad, la contraseña no se guarda en el dispositivo.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 20,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 26,
    fontWeight: 'bold',
    marginBottom: 24,
    textAlign: 'center',
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderWidth: 1,
    borderRadius: 4,
  },
  checkboxLabel: {
    marginLeft: 8,
  },
  button: {
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  note: {
    marginTop: 10,
    fontSize: 12,
    textAlign: 'center',
  },
});
