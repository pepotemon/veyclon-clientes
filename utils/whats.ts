import { Linking, Alert, Platform } from 'react-native';

export function sanitizePhone(raw?: string) {
  if (!raw) return '';
  const digits = raw.replace(/\D+/g, '');

  // Heurística opcional: si parece número local BR (10-11 dígitos) sin DDI, anteponer 55.
  if (!digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) {
    return `55${digits}`;
  }
  return digits;
}

export async function openWhats(phone: string, text: string) {
  const num = sanitizePhone(phone);
  const encoded = encodeURIComponent(text || '');

  // Preferimos deep-link directo a la app
  const deep = num
    ? `whatsapp://send?phone=${num}&text=${encoded}`
    : `whatsapp://send?text=${encoded}`;

  // Fallback web (abre navegador → WhatsApp)
  const web = num
    ? `https://wa.me/${num}?text=${encoded}`
    : `https://wa.me/?text=${encoded}`;

  // 1) Intentar deep-link (no usamos canOpenURL por restricciones de "package visibility")
  try {
    await Linking.openURL(deep);
    return;
  } catch {}

  // 2) Fallback web
  try {
    await Linking.openURL(web);
    return;
  } catch {}

  Alert.alert(
    'WhatsApp',
    Platform.OS === 'android'
      ? 'No se pudo abrir WhatsApp. Asegúrate de que esté instalado y que el número tenga código de país (ej.: 55...).'
      : 'No se pudo abrir WhatsApp en este dispositivo.'
  );
}
