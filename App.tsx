// App.tsx
import 'react-native-gesture-handler';
import React, { useEffect } from 'react';
import { StatusBar, Text, AppState } from 'react-native';
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

/**
 * Navegador principal que consume el tema desde el contexto
 */
function AppNavigator() {
  const { navigationTheme, isDark } = useAppTheme();
  const bg = navigationTheme.colors.background;

  return (
    <NavigationContainer theme={navigationTheme}>
      {/* StatusBar sin animación y con color de fondo real */}
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={navigationTheme.colors.card}
        animated={false}
        translucent={false}
      />

      <Stack.Navigator
        initialRouteName="DecoyRetro" // 🕹️ ahora el señuelo es la ruta inicial
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
        <Stack.Screen
          name="DecoyRetro"
          component={DecoyRetroScreen}
          options={{ headerShown: false }}
        />

        {/* Frecuentes */}
        <Stack.Screen
          name="Login"
          component={LoginScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen name="NuevoCliente" component={NuevoClienteScreen} />
        <Stack.Screen name="NuevoPrestamo" component={NuevoPrestamoScreen} />
        <Stack.Screen name="PagosDiarios" component={PagosDiariosScreen} />
        <Stack.Screen name="ClientesDisponibles" component={ClientesDisponiblesScreen} />
        <Stack.Screen name="MenuPrincipal" component={MenuPrincipalScreen} />
        <Stack.Screen name="PantallaInformes" component={PantallaInformes} />
        <Stack.Screen name="PagosDelDia" component={PagosDelDiaScreen} />
        <Stack.Screen name="VentasNuevas" component={VentasNuevasScreen} />
        <Stack.Screen
          name="InfoCliente"
          component={InfoClienteScreen}
          options={{ headerShown: false }}
        />

        {/* KPIs/gestión */}
        <Stack.Screen name="CajaDiaria" component={CajaDiariaScreen} />
        <Stack.Screen name="GastosHoy" component={GastosHoyScreen} />
        <Stack.Screen name="NuevoGasto" component={NuevoGastoScreen} />
        <Stack.Screen name="Gastos" component={GastosScreen} />
        <Stack.Screen name="Calculadora" component={CalculadoraScreen} />
        <Stack.Screen name="Pendientes" component={PendientesScreen} />
        <Stack.Screen
          name="DefinirCaja"
          component={DefinirCajaScreen}
          options={{ title: 'Definir caja' }}
        />
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
        <Stack.Screen
          name="EnrutarClientes"
          component={EnrutarClientesScreen}
          options={{ title: 'Enrutar clientes' }}
        />

        {/* Historiales y detalles */}
        <Stack.Screen name="HistorialPagos" component={HistorialPagosScreen} />
        <Stack.Screen name="DetalleCuotas" component={DetalleCuotasScreen} />
        <Stack.Screen name="HistorialPrestamos" component={HistorialPrestamosScreen} />
        <Stack.Screen
          name="DetalleHistorialPrestamo"
          component={DetalleHistorialPrestamoScreen}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
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

  return (
    <SafeAreaProvider /* @ts-ignore */ style={{ backgroundColor: '#0000' }}>
      <ThemeProvider>
        <AppNavigator />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
