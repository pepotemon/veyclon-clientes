// screens/AjustesScreen.tsx
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  StatusBar,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from '../theme/ThemeProvider';
import { RootStackParamList } from '../App';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { crearClientesDePrueba } from '../utils/crearClientesDePrueba'; // 👈 Import nuevo

type Props = NativeStackScreenProps<RootStackParamList, 'Ajustes'>;

type Item = {
  key: 'prefs' | 'enrutar' | 'cerrar' | 'caja' | 'demo';
  title: string;
  subtitle?: string;
  icon: keyof typeof Ionicons.glyphMap;
  tint?: string;
};

export default function AjustesScreen({ navigation }: Props) {
  const { palette, isDark } = useAppTheme();
  const insets = useSafeAreaInsets();

  const data: Item[] = [
    {
      key: 'prefs',
      title: 'Preferencias del usuario',
      subtitle: 'Personaliza la app',
      icon: 'options',
    },
    {
      key: 'enrutar',
      title: 'Enrutar Clientes',
      subtitle: 'Seleccionar y ordenar',
      icon: 'map',
    },
    {
      key: 'cerrar',
      title: 'Cerrar Día',
      subtitle: 'Resumen y corte de caja',
      icon: 'calendar',
    },
    {
      key: 'caja',
      title: 'Definir Caja',
      subtitle: 'Opción solo para revisadores',
      icon: 'cash',
    },
    {
      key: 'demo',
      title: '📦 Crear clientes demo',
      subtitle: 'Genera 80 clientes con préstamos activos (solo pruebas)',
      icon: 'construct',
      tint: '#009688',
    },
  ];

  const goWithAdmin = async (cb: (admin: string, tenantId: string) => void) => {
    try {
      const admin = await AsyncStorage.getItem('usuarioSesion');
      const tenantId = 'cobrox'; // ⚙️ si usas multi-tenant, puedes hacerlo dinámico aquí
      if (!admin) {
        Alert.alert('Sesión', 'No se encontró el usuario en sesión.');
        return;
      }
      cb(admin, tenantId);
    } catch {
      Alert.alert('Error', 'No fue posible leer la sesión.');
    }
  };

  const onPress = (item: Item) => {
    switch (item.key) {
      case 'prefs':
        navigation.navigate('PreferenciasUsuario');
        break;
      case 'enrutar':
        goWithAdmin((admin) => navigation.navigate('EnrutarClientes', { admin }));
        break;
      case 'cerrar':
        goWithAdmin((admin) => navigation.navigate('CerrarDia', { admin }));
        break;
      case 'caja':
        goWithAdmin((admin) => navigation.navigate('DefinirCaja', { admin }));
        break;
      case 'demo':
        goWithAdmin(async (admin, tenantId) => {
          Alert.alert(
            'Generar datos de prueba',
            '¿Seguro que quieres crear 80 clientes con préstamos activos? Esto puede tardar unos segundos.',
            [
              { text: 'Cancelar', style: 'cancel' },
              {
                text: 'Sí, crear',
                onPress: async () => {
                  try {
                    await crearClientesDePrueba(admin, tenantId);
                    Alert.alert('Éxito', 'Se crearon 80 clientes de prueba correctamente.');
                  } catch (err) {
                    console.warn('Error creando demo:', err);
                    Alert.alert('Error', 'No fue posible crear los clientes demo.');
                  }
                },
              },
            ]
          );
        });
        break;
    }
  };

  const renderItem = ({ item }: { item: Item }) => (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => onPress(item)}
      style={[
        styles.row,
        {
          backgroundColor: palette.cardBg,
          borderColor: palette.cardBorder,
          shadowColor: '#000',
        },
      ]}
    >
      <View style={styles.left}>
        <View
          style={[
            styles.iconCircle,
            {
              backgroundColor: isDark ? palette.kpiTrack : '#E8F5E9',
              borderColor: palette.cardBorder,
            },
          ]}
        >
          <Ionicons name={item.icon} size={20} color={item.tint || palette.accent} />
        </View>
      </View>

      <View style={styles.center}>
        <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>
          {item.title}
        </Text>
        {!!item.subtitle && (
          <Text style={[styles.subtitle, { color: palette.softText }]} numberOfLines={2}>
            {item.subtitle}
          </Text>
        )}
      </View>

      <Ionicons name="chevron-forward" size={18} color={palette.softText} />
    </TouchableOpacity>
  );

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: palette.screenBg }}
      edges={['left', 'right', 'bottom']}
    >
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <View
        style={[
          styles.header,
          { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder },
        ]}
      >
        <Text style={[styles.headerTxt, { color: palette.text }]}>Ajustes</Text>
      </View>

      <FlatList
        data={data}
        keyExtractor={(it) => it.key}
        renderItem={renderItem}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        contentContainerStyle={{
          paddingHorizontal: 12,
          paddingTop: 10,
          paddingBottom: 12 + Math.max(10, insets.bottom),
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    alignItems: 'center',
  },
  headerTxt: { fontSize: 16, fontWeight: '800' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 10,
    elevation: 1,
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    minHeight: 64,
  },
  left: { width: 40, alignItems: 'center', justifyContent: 'center' },
  iconCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  center: { flex: 1, paddingHorizontal: 8 },
  title: { fontSize: 14, fontWeight: '700' },
  subtitle: { fontSize: 12, marginTop: 2 },
});
