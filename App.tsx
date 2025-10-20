// App.tsx
import 'react-native-gesture-handler';
import React, { useEffect, useRef } from 'react';
import { StatusBar, Text, AppState, AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// ✅ Tema global
import { ThemeProvider, useAppTheme } from './theme/ThemeProvider';

// Pantallas existentes
import LoginScreen from './screens/LoginScreen';
import HomeScreen from './screens/HomeScreen';
import NuevoClienteScreen from './screens/NuevoClienteScreen';
import NuevoPrestamoScreen from './screens/NuevoPrestamoScreen';
import PagosDiariosScreen from './screens/PagosDiariosScreen';
import ClientesDisponiblesScreen from './screens/ClientesDisponiblesScreen';
import MenuPrincipalScreen from './screens/MenuPrincipalScreen';
import PantallaInformes from './screens/PantallaInformes';
import PagosDelDiaScreen from './screens/PagosDelDiaScreen';
import VentasNuevasScreen from './screens/VentasNuevasScreen';
import InfoClienteScreen from './screens/InfoClienteScreen';

// ✅ NUEVAS pantallas (todas sin lazy)
import CalculadoraScreen from './screens/CalculadoraScreen';
import PendientesScreen from './screens/PendientesScreen';
import GastosHoyScreen from './screens/GastosHoyScreen';
import NuevoGastoScreen from './screens/NuevoGastoScreen';
import GastosScreen from './screens/GastosScreen';
import CajaDiariaScreen from './screens/CajaDiariaScreen';
import CerrarDiaScreen from './screens/CerrarDiaScreen';
import DefinirCajaScreen from './screens/DefinirCajaScreen';
import GastosDelDiaScreen from './screens/GastosDelDiaScreen';
import RetirosDelDiaScreen from './screens/RetirosDelDiaScreen';
import IngresosDelDiaScreen from './screens/IngresosDelDiaScreen';

// 🕹️ Señuelo retro
import DecoyRetroScreen from './screens/DecoyRetroScreen';

// Ajustes / Preferencias / Acciones / Enrutar (sin lazy)
import AjustesScreen from './screens/AjustesScreen';
import PreferenciasUsuarioScreen from './screens/PreferenciasUsuarioScreen';
import AccionesScreen from './screens/AccionesScreen';
import EnrutarClientesScreen from './screens/EnrutarClientesScreen';

// Historiales y detalles (sin lazy)
import HistorialPagosScreen from './screens/HistorialPagosScreen';
import DetalleCuotasScreen from './screens/DetalleCuotasScreen';
import HistorialPrestamosScreen from './screens/HistorialPrestamosScreen';
import DetalleHistorialPrestamoScreen from './screens/DetalleHistorialPrestamoScreen';

// 👉 PATCH: listeners de conectividad y estado de app
import NetInfo from '@react-native-community/netinfo';
import { processOutboxBatch } from './utils/outbox';

// 👉 WATCHER de caja (auto cierre/apertura y live update)
import { onSnapshot, query, where, collection } from 'firebase/firestore';
import { db } from './firebase/firebaseConfig';
import { getSessionUser, DECOY_FLAG, logoutAndGoToDecoy } from './utils/session';
import { pickTZ, todayInTZ } from './utils/timezone';
import {
  updateCajaEstadoLive,
  autoCloseDay,
  ensureAperturaDeHoy,
  closeMissingDays,
} from './utils/cajaEstado';

// 👇 NUEVO: ref de navegación + gate de inactividad
import { navigationRef } from './navigation/navigationRef';
import InactivityGate from './security/InactivityGate';

// 🔐 Auth para detectar arranque “en frío”
import { auth } from './firebase/firebaseConfig';

// Tipado de navegación
export type RootStackParamList = {
  // 🕹️ nueva ruta inicial (señuelo)
  DecoyRetro: undefined;

  Login: undefined;

  // 👇 Home admite refreshToken opcional para forzar re-suscripción
  Home: { admin: string; refreshToken?: number };

  NuevoCliente: { admin: string };
  NuevoPrestamo: { cliente: any; admin: string; existingClienteId?: string };
  PagosDiarios: { admin: string };
  MenuPrincipal: undefined;
  PantallaInformes: { admin: string };
  PagosDelDia: { admin: string };
  VentasNuevas: { admin: string };
  GastosDelDia: { admin: string };
  RetirosDelDia: { admin: string };
  IngresosDelDia: { admin: string };

  HistorialPrestamos: {
    clienteId: string;
    nombreCliente: string;
    admin?: string;
  };

  InfoCliente: {
    clienteId: string;
    nombreCliente?: string;
    admin?: string;
  };

  HistorialPagos: {
    abonos: { monto: number; fecha: string }[];
    nombreCliente: string;
    valorCuota: number;
    totalPrestamo: number;
  };

  DetalleHistorialPrestamo: {
    clienteId: string;
    historialId: string;
    nombreCliente?: string;
  };

  DetalleCuotas: {
    abonos: { monto: number; fecha: string }[];
    valorCuota: number;
    totalPrestamo: number;
    nombreCliente: string;
  };

  ClientesDisponibles: { admin: string };

  // ✅ Nuevas rutas
  Calculadora: undefined;
  Pendientes: undefined;

  Ajustes: undefined;
  PreferenciasUsuario: undefined;

  GastosHoy: { admin: string };
  NuevoGasto: { admin: string };
  Gastos: { admin: string };
  CajaDiaria: { admin: string };

  // 👇 Nueva pantalla para el botón “Más …”
  Acciones: { admin: string };
  CerrarDia: { admin: string };
  DefinirCaja: { admin: string };

  // 👇 NUEVA ruta: Enrutar clientes
  EnrutarClientes: { admin: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

/** Navegador principal que consume el tema desde el contexto */
function AppNavigator() {
  const { navigationTheme, isDark } = useAppTheme();
  const bg = navigationTheme.colors.background;

  return (
    <NavigationContainer theme={navigationTheme} ref={navigationRef}>
      {/* StatusBar sin animación y con color de fondo real */}
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={navigationTheme.colors.card}
        animated={false}
        translucent={false}
      />

      <Stack.Navigator
        initialRouteName="Login" // ✅ Login es la ruta inicial real
        screenOptions={{
          animation: 'none',
          gestureEnabled: false,
          fullScreenGestureEnabled: false,
          headerStyle: { backgroundColor: navigationTheme.colors.card },
          headerTintColor: navigationTheme.colors.text,
          headerTitleAlign: 'center',
          headerTitle: () => (
            <Text
              style={{
                fontSize: 14,
                fontWeight: '700',
                letterSpacing: 0.2,
                color: navigationTheme.colors.text,
                opacity: 0.85,
              }}
              numberOfLines={1}
            >
              Veyclon Clientes
            </Text>
          ),
          contentStyle: { backgroundColor: bg },
        }}
      >
        {/* 🕹️ Señuelo retro (sin header) */}
        <Stack.Screen name="DecoyRetro" component={DecoyRetroScreen} options={{ headerShown: false }} />

        {/* Frecuentes */}
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen name="NuevoCliente" component={NuevoClienteScreen} />
        <Stack.Screen name="NuevoPrestamo" component={NuevoPrestamoScreen} />
        <Stack.Screen name="PagosDiarios" component={PagosDiariosScreen} />
        <Stack.Screen name="ClientesDisponibles" component={ClientesDisponiblesScreen} />
        <Stack.Screen name="MenuPrincipal" component={MenuPrincipalScreen} />
        <Stack.Screen name="PantallaInformes" component={PantallaInformes} />
        <Stack.Screen name="PagosDelDia" component={PagosDelDiaScreen} />
        <Stack.Screen name="VentasNuevas" component={VentasNuevasScreen} />
        <Stack.Screen name="InfoCliente" component={InfoClienteScreen} options={{ headerShown: false }} />

        {/* KPIs/gestión */}
        <Stack.Screen name="CajaDiaria" component={CajaDiariaScreen} />
        <Stack.Screen name="GastosHoy" component={GastosHoyScreen} />
        <Stack.Screen name="NuevoGasto" component={NuevoGastoScreen} />
        <Stack.Screen name="Gastos" component={GastosScreen} />
        <Stack.Screen name="Calculadora" component={CalculadoraScreen} />
        <Stack.Screen name="Pendientes" component={PendientesScreen} />
        <Stack.Screen name="DefinirCaja" component={DefinirCajaScreen} options={{ title: 'Definir caja' }} />
        <Stack.Screen name="CerrarDia" component={CerrarDiaScreen} />
        <Stack.Screen name="GastosDelDia" component={GastosDelDiaScreen} />
        <Stack.Screen name="RetirosDelDia" component={RetirosDelDiaScreen} />
        <Stack.Screen name="IngresosDelDia" component={IngresosDelDiaScreen} />

        {/* Otras pantallas */}
        <Stack.Screen name="Ajustes" component={AjustesScreen} />
        <Stack.Screen
          name="PreferenciasUsuario"
          component={PreferenciasUsuarioScreen}
          options={{ title: 'Preferencias de Usuario' }}
        />
        <Stack.Screen name="Acciones" component={AccionesScreen} />
        <Stack.Screen name="EnrutarClientes" component={EnrutarClientesScreen} options={{ title: 'Enrutar clientes' }} />

        {/* Historiales y detalles */}
        <Stack.Screen name="HistorialPagos" component={HistorialPagosScreen} />
        <Stack.Screen name="DetalleCuotas" component={DetalleCuotasScreen} />
        <Stack.Screen name="HistorialPrestamos" component={HistorialPrestamosScreen} />
        <Stack.Screen name="DetalleHistorialPrestamo" component={DetalleHistorialPrestamoScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  // 🧼 ARRANQUE EN FRÍO: si Firebase NO tiene usuario (con inMemoryPersistence siempre será así),
  // limpiamos cualquier sesión previa almacenada por la app y forzamos el señuelo.
  useEffect(() => {
    (async () => {
      try {
        if (!auth.currentUser) {
          await AsyncStorage.multiRemove([
            '@veyclon/session',
            '@veyclon/admin',
            'usuarioSesion',
            'usuarioPerfil',
          ]);
          await AsyncStorage.setItem(DECOY_FLAG, '1'); // para que se muestre el señuelo antes del login
        }
      } catch {}
    })();
  }, []);

  // 🔧 Limpieza única de claves legadas que podían forzar "Ruta1"
  useEffect(() => {
    (async () => {
      try {
        await AsyncStorage.multiRemove(['usuarioSesion', 'usuarioPerfil']); // legacy
      } catch {}
    })();
  }, []);

  // 👉 PATCH: listeners Outbox (NetInfo/AppState)
  useEffect(() => {
    // Drenado inicial pequeño por si había pendientes al arrancar
    void processOutboxBatch(5);

    // Reconexión de red → procesar 50
    const unsubNet = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) {
        void processOutboxBatch(50);
      }
    });

    // App vuelve a primer plano → procesar 10
    const subAppState = AppState.addEventListener('change', (st) => {
      if (st === 'active') {
        void processOutboxBatch(10);
      }
    });

    return () => {
      unsubNet();
      subAppState.remove();
    };
  }, []);

  // 👉 WATCHER automático de CAJA (sin archivos nuevos)
  useEffect(() => {
    let unsubDaySnap: (() => void) | null = null;
    let unsubAppState: (() => void) | null = null;
    let unsubNet: (() => void) | null = null;
    let mounted = true;

    const tz = pickTZ(undefined, 'America/Sao_Paulo');
    let currentYmd: string | null = null;
    let adminCache: string | null = null;

    async function tick() {
      if (!mounted || !adminCache) return;
      const ymdNow = todayInTZ(tz);

      // Cambió el día → cerrar AYER + asegurar apertura HOY y re-suscribir
      if (currentYmd && ymdNow !== currentYmd) {
        const ayer = currentYmd;
        await autoCloseDay(adminCache, ayer, tz);
        await ensureAperturaDeHoy(adminCache, ymdNow, tz);
        currentYmd = ymdNow;

        // re-suscripción al nuevo día
        if (unsubDaySnap) try { unsubDaySnap(); } catch {}
        const qDia = query(
          collection(db, 'cajaDiaria'),
          where('admin', '==', adminCache),
          where('operationalDate', '==', currentYmd),
        );
        unsubDaySnap = onSnapshot(qDia, async () => {
          try {
            await updateCajaEstadoLive(adminCache!, currentYmd!, tz);
          } catch (e) {
            console.warn('[CajaWatcher] live update error:', e);
          }
        });
      } else {
        // Mismo día → refresco live por foreground/reconexión
        await updateCajaEstadoLive(adminCache, ymdNow, tz);
      }

      // Saneo de días faltantes
      await closeMissingDays(adminCache, ymdNow, tz, 7);
    }

    async function mountFor(admin: string) {
      adminCache = admin;
      currentYmd = todayInTZ(tz);

      // suscripción en vivo al día actual
      if (unsubDaySnap) try { unsubDaySnap(); } catch {}
      const qDia = query(
        collection(db, 'cajaDiaria'),
        where('admin', '==', admin),
        where('operationalDate', '==', currentYmd),
      );
      unsubDaySnap = onSnapshot(qDia, async () => {
        try {
          await updateCajaEstadoLive(admin, currentYmd!, tz);
        } catch (e) {
          console.warn('[CajaWatcher] live update error:', e);
        }
      });

      // primer tick (aplica cierre/apertura si toca y sanea)
      await tick();
    }

    (async () => {
      const admin = await getSessionUser();
      if (!mounted || !admin) return;
      await mountFor(admin);

      // App al foreground → tick
      const appStateSub = AppState.addEventListener('change', (s) => {
        if (s === 'active') void tick();
      });
      unsubAppState = () => { try { appStateSub.remove(); } catch {} };

      // Reconexión de red → tick
      const netUn = NetInfo.addEventListener((state) => {
        if (state.isConnected) void tick();
      });
      unsubNet = () => { try { netUn(); } catch {} };
    })();

    return () => {
      mounted = false;
      if (unsubDaySnap) try { unsubDaySnap(); } catch {}
      if (unsubAppState) try { unsubAppState(); } catch {}
      if (unsubNet) try { unsubNet(); } catch {}
    };
  }, []);

  // ⛔️ Watcher GLOBAL de inactividad en segundo plano (aplica a TODAS las pantallas)
  const idleMs = 180000; // 3 minutos
  const lastBgAtRef = useRef<number | null>(null);
  const stateRef = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    const sub = AppState.addEventListener('change', async (next) => {
      const prev = stateRef.current;
      stateRef.current = next;

      if (next === 'background' || next === 'inactive') {
        lastBgAtRef.current = Date.now();
      }

      if (next === 'active') {
        const bgAt = lastBgAtRef.current;
        if (bgAt && Date.now() - bgAt >= idleMs) {
          try {
            await logoutAndGoToDecoy('global-background-idle');
          } catch {}
        }
      }
    });

    return () => {
      try { sub.remove(); } catch {}
    };
  }, [idleMs]);

  return (
    <SafeAreaProvider /* @ts-ignore */ style={{ backgroundColor: '#0000' }}>
      <ThemeProvider>
        {/* ⬇️ Cierre de sesión por inactividad dentro de la app (taps/gestos) */}
        <InactivityGate idleMs={180000}>
          <AppNavigator />
        </InactivityGate>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
