// utils/whats.ts
import { Linking, Alert } from 'react-native';

export function sanitizePhone(raw?: string) {
  if (!raw) return '';
  // Mantém apenas dígitos. Se precisar, você pode prefixar com '55' se vier sem DDI.
  const digits = raw.replace(/\D+/g, '');
  return digits; // ex: "5591999998888"
}

export async function openWhats(phone: string, text: string) {
  const num = sanitizePhone(phone);
  if (!num) {
    Alert.alert('WhatsApp', 'O cliente não possui telefone válido.');
    return;
  }
  const url = `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
  const can = await Linking.canOpenURL(url);
  if (!can) {
    Alert.alert('WhatsApp', 'Não foi possível abrir o WhatsApp neste dispositivo.');
    return;
  }
  await Linking.openURL(url);
}
