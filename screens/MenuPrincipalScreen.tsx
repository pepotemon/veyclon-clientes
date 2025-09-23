// screens/MenuPrincipalScreen.tsx
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../App';
import { sincronizarTodo } from '../utils/syncHelper';
import { useAppTheme } from '../theme/ThemeProvider';

// ✅ helpers de sesión (consistentes con Ajustes)
import { getSessionUser, clearSession } from '../utils/session';

// ✅ saneador de caja
import { closeMissingDays, ensureAperturaDeHoy } from '../utils/cajaEstado';
import { pickTZ, todayInTZ } from '../utils/timezone';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'MenuPrincipal'>;
};

type Opcion = {
  icon: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
};

export default function MenuPrincipalScreen({ navigation }: Props) {
  const { palette } = useAppTheme();
  const [admin, setAdmin] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // carga de sesión
  useEffect(() => {
    let alive = true;
    (async () => {
      const usuario = await getSessionUser();
      if (alive) setAdmin(usuario);
    })();
    return () => { alive = false; };
  }, []);

  // ✅ Al tener admin, sanea días pendientes y asegura apertura de HOY (una sola vez)
  const saneadorOnce = useRef(false);
  useEffect(() => {
    if (!admin || saneadorOnce.current) return;
    saneadorOnce.current = true;

    (async () => {
      try {
        // 🔒 TZ fija para caja (evita cierres con TZs distintas y fechas raras)
        const tz = pickTZ('America/Sao_Paulo');
        const hoy = todayInTZ(tz);
        await closeMissingDays(admin, hoy, tz, 7);
        await ensureAperturaDeHoy(admin, hoy, tz);
      } catch (e: any) {
        console.warn('[MenuPrincipal] saneador error:', e?.message || e);
      }
    })();
  }, [admin]);

  // ✅ Cerrar sesión → confirmar, limpiar y resetear a DecoyRetro
  const cerrarSesion = () => {
    Alert.alert(
      'Salir',
      '¿Cerrar sesión y volver al inicio?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Salir',
          style: 'destructive',
          onPress: async () => {
            try {
              await clearSession(); // borra usuarioSesion y perfil (si lo hubiera)
            } finally {
              navigation.reset({
                index: 0,
                // 👇 volvemos al señuelo retro (no al Login)
                routes: [{ name: 'DecoyRetro' as any }],
              });
            }
          },
        },
      ],
    );
  };

  const sincronizar = async () => {
    try {
      if (!admin) {
        Alert.alert('Error', 'No se encontró la sesión del usuario.');
        return;
      }
      if (syncing) return;
      setSyncing(true);

      const res = await sincronizarTodo(admin);
      const msg =
        `Pendientes enviados: ${res.pushed}\n` +
        `Pendientes restantes: ${res.remaining}\n\n` +
        `Clientes descargados: ${res.pulled.clientes}\n` +
        `Préstamos descargados: ${res.pulled.prestamos}\n` +
        `Cache guardado: ${res.cacheSaved ? 'Sí' : 'No'}`;

      Alert.alert('✔️ Sincronización completa', msg);
    } catch (e) {
      Alert.alert('❌ Error', 'Ocurrió un problema al sincronizar.');
      console.error(e);
    } finally {
      setSyncing(false);
    }
  };

  const goIfAdmin = (fn: (admin: string) => void) => {
    if (!admin) {
      Alert.alert('Espera', 'Cargando información del usuario...');
      return;
    }
    fn(admin);
  };

  const opciones: Opcion[] = [
    {
      icon: 'chart-line',
      label: 'Informes',
      onPress: () => goIfAdmin((a) => navigation.navigate('PantallaInformes', { admin: a })),
    },
    {
      icon: 'sync',
      label: syncing ? 'Sincronizando…' : 'Sincronizar',
      onPress: sincronizar,
      disabled: syncing,
    },
    {
      icon: 'hand-coin',
      label: 'Gastos',
      onPress: () => goIfAdmin((a) => navigation.navigate('Gastos', { admin: a })),
    },
    {
      icon: 'calculator',
      label: 'Caja',
      onPress: () => goIfAdmin((a) => navigation.navigate('CajaDiaria', { admin: a })),
    },
    {
      icon: 'cog',
      label: 'Ajustes',
      onPress: () => navigation.navigate('Ajustes'),
    },
  ];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: palette.screenBg }]}>
      <Text style={[styles.title, { color: palette.text }]}>Menú Principal</Text>

      <View style={styles.grid}>
        {opciones.map((op, index) => (
          <TouchableOpacity
            key={index}
            style={[styles.boton, op.disabled && { opacity: 0.6 }]}
            onPress={op.onPress}
            activeOpacity={0.85}
            disabled={!!op.disabled}
          >
            <View
              style={[
                styles.circle,
                { backgroundColor: palette.accent, shadowColor: palette.text },
              ]}
            >
              {op.label === 'Sincronizando…' ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Icon name={op.icon} size={32} color="#ffffff" />
              )}
            </View>
            <Text style={[styles.label, { color: palette.text }]}>{op.label}</Text>
          </TouchableOpacity>
        ))}

        {/* Botón Salir → mismo comportamiento que Ajustes */}
        <TouchableOpacity style={styles.boton} onPress={cerrarSesion} activeOpacity={0.85}>
          <View
            style={[
              styles.circle,
              { backgroundColor: palette.accent, shadowColor: palette.text },
            ]}
          >
            <Icon name="logout" size={32} color="#ffffff" />
          </View>
          <Text style={[styles.label, { color: palette.text }]}>Salir</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 22, textAlign: 'center', marginVertical: 16, fontWeight: 'bold' },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-around',
    alignItems: 'center',
    gap: 20,
  },
  boton: { width: '40%', marginVertical: 16, alignItems: 'center' },
  circle: {
    width: 70, height: 70, borderRadius: 35,
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 8, elevation: 3,
  },
  label: { fontSize: 14, textAlign: 'center' },
});
