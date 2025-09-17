// screens/DecoyRetroScreen.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Easing,
  Alert,
  BackHandler,
  Dimensions,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { RootStackParamList } from '../App';
import { useAppTheme } from '../theme/ThemeProvider';

type Props = NativeStackScreenProps<RootStackParamList, 'DecoyRetro'>;

// ⚠️ Si quieres, saca estos a Remote Config/AsyncStorage más adelante
const SECRET_PIN = '2025';
const DURESS_PIN = '9999';

export default function DecoyRetroScreen({ navigation }: Props) {
  const { palette, isDark } = useAppTheme();

  const [showKeypad, setShowKeypad] = useState(false);
  const [input, setInput] = useState('');
  const [credits, setCredits] = useState(0);

  const startPressTsRef = useRef<number | null>(null);

  // “PRESS START / INSERT COIN” parpadeando
  const blink = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, { toValue: 0.25, duration: 650, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 650, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [blink]);

  // Efecto “scanlines” (CRT)
  const scanAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(scanAnim, { toValue: 1, duration: 4200, easing: Easing.linear, useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [scanAnim]);

  const translateY = scanAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 8],
  });

  // Al entrar/salir resetea states visuales
  useFocusEffect(
    React.useCallback(() => {
      setShowKeypad(false);
      setInput('');
      setCredits(0);
      return () => {
        setShowKeypad(false);
        setInput('');
      };
    }, [])
  );

  // Botón físico "Atrás" → salir de la app (evita regresar a pantallas internas)
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

  const keypadKeys = useMemo(() => ['1','2','3','4','5','6','7','8','9','0','CLR','OK'], []);

  const tryUnlockByPIN = () => {
    const pin = input.trim();
    setInput('');
    setShowKeypad(false);

    if (pin === SECRET_PIN) {
      navigation.replace('Login'); // luego pasas a Home normal
      return;
    }
    if (pin === DURESS_PIN) {
      Alert.alert('Modo seguro', 'Acceso restringido.');
      return;
    }
    Alert.alert('Código incorrecto', 'Inténtalo de nuevo.');
  };

  const onKeypadPress = (k: string) => {
    if (k === 'CLR') {
      setInput('');
    } else if (k === 'OK') {
      tryUnlockByPIN();
    } else {
      setInput((s) => (s + k).slice(0, 12));
    }
  };

  const insertCoin = () => setCredits((c) => Math.min(99, c + 1));

  const onStartPressIn = () => { startPressTsRef.current = Date.now(); };
  const onStartPressOut = () => {
    const t0 = startPressTsRef.current;
    startPressTsRef.current = null;
    if (!t0) return;
    const held = Date.now() - t0;

    if (held >= 1500) {
      if (credits <= 0) {
        Alert.alert('Sin crédito', 'Presiona SELECT para insertar una moneda.');
        return;
      }
      // Consumes 1 crédito y abres el login
      setCredits((c) => Math.max(0, c - 1));
      navigation.replace('Login');
    }
  };

  // HUD pseudo-arcade
  const HI_SCORE = '200000'; // decorativo
  const SCORE = '000000';    // decorativo

  // Cantidad de líneas para scanlines (4px por línea aprox.)
  const { height } = Dimensions.get('window');
  const scanCount = Math.ceil(height / 4);

  return (
    <View style={[styles.container, { backgroundColor: palette.screenBg }]}>
      {/* Marco “monitor” */}
      <View style={[styles.frame, { borderColor: palette.cardBorder, backgroundColor: palette.cardBg }]}>
        {/* HUD superior */}
        <View style={styles.hudTop}>
          <Text style={[styles.hudMono, { color: palette.softText }]}>SCORE {SCORE}</Text>
          <Text style={[styles.hudMono, { color: palette.softText }]}>HI-SCORE {HI_SCORE}</Text>
          <Text style={[styles.hudMono, { color: palette.softText }]}>CREDIT {String(credits).padStart(2,'0')}</Text>
        </View>

        {/* “Logo” retro */}
        <Text style={[styles.logo, { color: palette.text }]}>
          <Text style={{ color: palette.accent }}>8</Text>-Bit Tools
        </Text>

        {/* Texto central (Press/Insert) */}
        <Animated.Text style={[styles.pressStart, { color: palette.softText, opacity: blink }]}>
          {credits > 0 ? 'PRESS START' : 'INSERT COIN'}
        </Animated.Text>

        {/* Botones START / SELECT */}
        <View style={styles.actions}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPressIn={onStartPressIn}
            onPressOut={onStartPressOut}
            style={[styles.bigBtn, { backgroundColor: isDark ? '#263238' : '#E3F2FD', borderColor: palette.cardBorder }]}
          >
            <Text style={[styles.bigBtnTxt, { color: palette.text }]}>START</Text>
          </TouchableOpacity>

          <TouchableOpacity
            activeOpacity={0.85}
            onPress={insertCoin}
            onLongPress={() => setShowKeypad((v) => !v)}
            delayLongPress={450}
            style={[styles.bigBtn, { backgroundColor: isDark ? '#263238' : '#FFF3E0', borderColor: palette.cardBorder }]}
          >
            <Text style={[styles.bigBtnTxt, { color: palette.text }]}>SELECT</Text>
          </TouchableOpacity>
        </View>

        {/* Keypad secreto */}
        {showKeypad && (
          <View style={[styles.keypad, { borderColor: palette.cardBorder, backgroundColor: palette.topBg }]}>
            <Text style={[styles.pinLabel, { color: palette.softText }]}>ENTER CODE</Text>

            <View style={[styles.pinGhost, { borderColor: palette.cardBorder }]}>
              <Text style={[styles.pinGhostTxt, { color: palette.text }]} numberOfLines={1}>
                {input.replace(/./g, '•') || '—'}
              </Text>
            </View>

            <View style={styles.grid}>
              {keypadKeys.map((k) => (
                <TouchableOpacity
                  key={k}
                  onPress={() => onKeypadPress(k)}
                  style={[styles.key, { borderColor: palette.cardBorder, backgroundColor: palette.cardBg }]}
                  activeOpacity={0.9}
                >
                  <Text style={[styles.keyTxt, { color: palette.text }]}>{k}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* Instrucciones inferiores estilo arcade */}
        <View style={styles.hudBottom}>
          <Text style={[styles.hudMono, { color: palette.softText }]} numberOfLines={1}>
            SELECT = INSERT COIN  •  HOLD SELECT = ENTER CODE  •  HOLD START = UNLOCK
          </Text>
        </View>

        {/* Footer “fake” */}
        <Text style={[styles.footer, { color: palette.softText }]}>
          © 1988 Simple Entertainment
        </Text>

        {/* Scanlines overlay (no toca interacciones) */}
        <View pointerEvents="none" style={styles.scanOverlay}>
          <Animated.View style={{ transform: [{ translateY }] }}>
            {Array.from({ length: scanCount }).map((_, i) => (
              <View key={i} style={styles.scanLine} />
            ))}
          </Animated.View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container:{ flex:1, justifyContent:'center', padding:16 },
  frame:{
    borderWidth:1, borderRadius:14, padding:16,
    alignItems:'center',
    shadowColor:'#000', shadowOpacity:0.06, shadowRadius:6, shadowOffset:{ width:0, height:2 },
    overflow:'hidden',
  },

  // HUD
  hudTop:{
    alignSelf:'stretch',
    flexDirection:'row',
    justifyContent:'space-between',
    marginBottom:8,
  },
  hudMono:{ fontSize:12, fontWeight:'900', letterSpacing:1 },

  logo:{ fontSize:28, fontWeight:'900', letterSpacing:2, textTransform:'uppercase', marginBottom:6 },
  pressStart:{ fontSize:14, fontWeight:'800', letterSpacing:1, marginBottom:12, textAlign:'center' },

  actions:{ flexDirection:'row', gap:12, marginBottom:12 },
  bigBtn:{
    borderWidth:1, borderRadius:12, paddingVertical:12, paddingHorizontal:20,
  },
  bigBtnTxt:{ fontSize:16, fontWeight:'900', letterSpacing:1 },

  keypad:{
    alignSelf:'stretch',
    borderWidth:1, borderRadius:12, padding:12, marginTop:8,
  },
  pinLabel:{ fontSize:12, fontWeight:'800', textAlign:'center', marginBottom:6, letterSpacing:1 },
  pinGhost:{
    alignSelf:'stretch',
    borderWidth:1, borderRadius:10, paddingVertical:8, paddingHorizontal:12, marginBottom:10,
  },
  pinGhostTxt:{ fontSize:18, fontWeight:'800', textAlign:'center', letterSpacing:2 },

  grid:{ flexDirection:'row', flexWrap:'wrap', gap:8, justifyContent:'space-between' },
  key:{
    width:'31%', aspectRatio:1.1,
    borderWidth:1, borderRadius:10,
    alignItems:'center', justifyContent:'center',
  },
  keyTxt:{ fontSize:16, fontWeight:'900', letterSpacing:1 },

  hudBottom:{ alignSelf:'stretch', marginTop:8 },
  footer:{ marginTop:8, fontSize:11, letterSpacing:1 },

  // Scanlines
  scanOverlay:{
    position:'absolute',
    left:0, right:0, top:0, bottom:0,
  },
  scanLine:{
    height:2,
    backgroundColor:'rgba(255,255,255,0.04)',
    marginBottom:2,
  },
});
