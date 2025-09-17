// screens/PreferenciasUsuarioScreen.tsx
import React, { useEffect, useState } from 'react';
import { SafeAreaView, View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from '../theme/ThemeProvider';

const KEY_SEND_RECEIPT_CONFIRM = 'prefs:sendReceiptConfirm';

export default function PreferenciasUsuarioScreen() {
  const { palette } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [sendReceiptConfirm, setSendReceiptConfirm] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const v = await AsyncStorage.getItem(KEY_SEND_RECEIPT_CONFIRM);
        setSendReceiptConfirm(v === '1');
      } catch {}
      setLoaded(true);
    })();
  }, []);

  const toggle = async () => {
    const nv = !sendReceiptConfirm;
    setSendReceiptConfirm(nv);
    try {
      await AsyncStorage.setItem(KEY_SEND_RECEIPT_CONFIRM, nv ? '1' : '0');
    } catch {}
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg }}>
      <View style={[styles.header, { backgroundColor: palette.topBg, borderBottomColor: palette.topBorder }]}>
        <Text style={[styles.headerTxt, { color: palette.text }]}>Preferencias</Text>
      </View>

      <View style={{ padding: 14, paddingBottom: 14 + Math.max(10, insets.bottom) }}>
        {/* Item: Confirmación recibo post-pago */}
        <View style={[styles.card, { backgroundColor: palette.cardBg, borderColor: palette.cardBorder }]}>
          <View style={styles.rowBetween}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Text style={[styles.title, { color: palette.text }]}>Confirmar envío de recibo</Text>
              <Text style={[styles.subtitle, { color: palette.softText }]}>
                Si está activo, al registrar un pago la app te preguntará si quieres abrir WhatsApp con el recibo.
              </Text>
            </View>

            {/* Píldora Toggle */}
            <TouchableOpacity
              onPress={toggle}
              activeOpacity={0.85}
              disabled={!loaded}
              style={[
                styles.toggle,
                { borderColor: palette.cardBorder, backgroundColor: sendReceiptConfirm ? palette.accent : palette.kpiTrack },
              ]}
            >
              <Text style={[styles.toggleTxt, { color: sendReceiptConfirm ? '#fff' : palette.text }]}>
                {sendReceiptConfirm ? 'Activo' : 'Inactivo'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, alignItems: 'center' },
  headerTxt: { fontSize: 16, fontWeight: '800' },

  card: { borderWidth: 1, borderRadius: 12, padding: 12 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 14, fontWeight: '800' },
  subtitle: { fontSize: 12, marginTop: 4 },

  toggle: {
    borderWidth: 1, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12, minWidth: 88, alignItems: 'center',
  },
  toggleTxt: { fontSize: 12, fontWeight: '800' },
});
