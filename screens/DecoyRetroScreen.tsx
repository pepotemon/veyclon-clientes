// screens/DecoyRetroScreen.tsx
import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  BackHandler,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { RootStackParamList } from '../App';
import { useAppTheme } from '../theme/ThemeProvider';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Props = NativeStackScreenProps<RootStackParamList, 'DecoyRetro'>;

const SECRET_SEQUENCE = '2025='; // Escribe esto para entrar

export default function DecoyRetroScreen({ navigation }: Props) {
  const { palette, isDark } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [buffer, setBuffer] = useState<string>('');
  const unlockedRef = useRef(false);

  // Botón atrás cierra la app
  useFocusEffect(
    React.useCallback(() => {
      const onBack = () => {
        BackHandler.exitApp();
        return true;
      };
      const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
      return () => sub.remove();
    }, [])
  );

  const onKey = (k: string) => {
    if (k === 'CLR') {
      setBuffer('');
      return;
    }
    setBuffer((prev) => {
      const next = (prev + k).slice(-Math.max(SECRET_SEQUENCE.length, 12));
      if (!unlockedRef.current && next.endsWith(SECRET_SEQUENCE)) {
        unlockedRef.current = true;
        setTimeout(() => {
          setBuffer('');
          navigation.replace('Login');
        }, 0);
      }
      return next;
    });
  };

  const KEYS = ['1','2','3','4','5','6','7','8','9','=','0','CLR'];

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: palette.screenBg }]}>
      <View
        style={[
          styles.container,
          {
            paddingTop: Math.max(insets.top + 12, 24),   // ⬅️ despega de la barra superior
            paddingBottom: Math.max(insets.bottom + 16, 24), // ⬅️ despega del home indicator inferior
          },
        ]}
      >
        {/* Header “arcade login” */}
        <Text style={[styles.brand, { color: palette.text }]}>
          <Text style={{ color: palette.accent }}>Retro</Text>Pad<Text style={{ color: palette.accent }}>88</Text>
        </Text>
        <Text style={[styles.caption, { color: palette.softText }]}>
          ACCESS CODE REQUIRED
        </Text>

        {/* Display del código */}
        <View style={[styles.display, { borderColor: palette.cardBorder, backgroundColor: palette.cardBg }]}>
          <Text style={[styles.displayTxt, { color: palette.text }]} numberOfLines={1}>
            {buffer ? buffer.replace(/./g, '•') : '—'}
          </Text>
        </View>

        {/* Keypad */}
        <View style={styles.grid}>
          {KEYS.map((k) => (
            <TouchableOpacity
              key={k}
              activeOpacity={0.9}
              onPress={() => onKey(k)}
              style={[
                styles.key,
                {
                  borderColor: palette.cardBorder,
                  backgroundColor: palette.topBg,
                  shadowColor: isDark ? '#000' : '#000',
                },
              ]}
            >
              <Text style={[styles.keyTxt, { color: palette.text }]}>{k}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Pie minimal sin pistas */}
        <Text style={[styles.footer, { color: palette.softText }]}>
          © RetroPad88 • INSERT ACCESS CODE
        </Text>
      </View>
    </SafeAreaView>
  );
}

const BTN_SIZE = 72;

const styles = StyleSheet.create({
  root: { flex: 1 },
  container: {
    flex: 1,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },

  brand: {
    fontSize: 26,
    fontWeight: '900',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  caption: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },

  display: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: Platform.select({ ios: 12, android: 10 }),
    paddingHorizontal: 14,
    marginTop: 18,
    marginBottom: 12,
  },
  displayTxt: {
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: 2,
  },

  grid: {
    alignSelf: 'stretch',
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
  },
  key: {
    width: '31%',
    height: BTN_SIZE,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 2,
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  keyTxt: { fontSize: 22, fontWeight: '900', letterSpacing: 1 },

  footer: {
    marginTop: 18,
    fontSize: 11,
    letterSpacing: 1,
  },
});
