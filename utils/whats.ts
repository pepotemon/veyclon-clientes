// utils/whats.ts
import { Linking, Alert, Platform } from 'react-native';

export function sanitizePhone(raw?: string) {
  if (!raw) return '';
  const digits = raw.replace(/\D+/g, '');

  // Heurística opcional BR: si es 10–11 dígitos sin DDI, anteponer 55
  if (!digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) {
    return `55${digits}`;
  }
  return digits;
}

/**
 * Abre WhatsApp a un número específico con texto.
 * Mantiene la validación de número para no afectar el flujo del Home/plantillas.
 */
export async function openWhats(phone: string, text: string) {
  const num = sanitizePhone(phone);
  if (!num) {
    Alert.alert('WhatsApp', 'El cliente no tiene teléfono válido.');
    return;
  }

  const encoded = encodeURIComponent(text || '');
  const deep = `whatsapp://send?phone=${num}&text=${encoded}`;
  const web  = `https://wa.me/${num}?text=${encoded}`;

  // 1) Deep link directo
  try {
    await Linking.openURL(deep);
    return;
  } catch {}

  // 2) Fallback web (navegador → WhatsApp)
  try {
    await Linking.openURL(web);
    return;
  } catch {}

  // 3) Último intento Android: intent explícito
  if (Platform.OS === 'android') {
    try {
      await Linking.openURL(
        `intent://send?text=${encoded}#Intent;scheme=whatsapp;package=com.whatsapp;end`
      );
      return;
    } catch {}
  }

  Alert.alert(
    'WhatsApp',
    Platform.OS === 'android'
      ? 'No se pudo abrir WhatsApp. Asegúrate de que esté instalado y que el número tenga código de país (ej.: 55...).'
      : 'No se pudo abrir WhatsApp en este dispositivo.'
  );
}

/**
 * Abre WhatsApp SIN número (selector de contacto) con el texto (recibo).
 * Úsalo en Preferencias → “Confirmar envío de recibo”.
 */
export async function openWhatsPicker(text: string) {
  const encoded = encodeURIComponent(text || '');
  const deep = `whatsapp://send?text=${encoded}`;
  const web  = `https://wa.me/?text=${encoded}`;

  // 1) Deep link
  try {
    await Linking.openURL(deep);
    return;
  } catch {}

  // 2) Fallback web
  try {
    await Linking.openURL(web);
    return;
  } catch {}

  // 3) Intent Android
  if (Platform.OS === 'android') {
    try {
      await Linking.openURL(
        `intent://send?text=${encoded}#Intent;scheme=whatsapp;package=com.whatsapp;end`
      );
      return;
    } catch {}
  }

  Alert.alert('WhatsApp', 'No se pudo abrir WhatsApp en este dispositivo.');
}
