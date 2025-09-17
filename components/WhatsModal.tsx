// components/WhatsModal.tsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, Platform,
  KeyboardAvoidingView, Alert, Pressable, Switch
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fillTemplatePT, TEMPLATES_PT } from '../utils/whatsTemplates';
import { openWhats, sanitizePhone } from '../utils/whats';

type Props = {
  visible: boolean;
  onClose: () => void;

  phone?: string;
  nombre?: string;
  valorCuota?: number;

  onSent?: () => void;
};

const KEY_WHATS_AUTO_CLOSE = 'prefs:whatsAutoCloseAfterSend';

export default function WhatsModal({
  visible, onClose, phone, nombre, valorCuota, onSent,
}: Props) {
  // Solo recordatorio/cobranza (sin preview ni edición)
  const DEFAULT_KEY: keyof typeof TEMPLATES_PT = 'LEMBRETE_SIMPLES';
  const [templateKey, setTemplateKey] = useState<keyof typeof TEMPLATES_PT>(DEFAULT_KEY);
  const [loading, setLoading] = useState(false);
  const [autoClose, setAutoClose] = useState(true);

  // persistimos preferencia autoClose
  useEffect(() => {
    (async () => {
      try {
        const v = await AsyncStorage.getItem(KEY_WHATS_AUTO_CLOSE);
        if (v === '0') setAutoClose(false);
      } catch {}
    })();
  }, []);
  useEffect(() => {
    AsyncStorage.setItem(KEY_WHATS_AUTO_CLOSE, autoClose ? '1' : '0').catch(() => {});
  }, [autoClose]);

  const phoneNormalized = useMemo(() => (phone ? sanitizePhone(phone) : ''), [phone]);

  const handleChangeTemplate = (key: keyof typeof TEMPLATES_PT) => {
    setTemplateKey(key);
  };

  const handleSend = async () => {
    // Construimos el mensaje JUSTO antes de enviar (sin mostrar previa)
    const text = fillTemplatePT(TEMPLATES_PT[templateKey], {
      NOME: nombre ?? 'cliente',
      VALOR_COTA: valorCuota != null ? valorCuota : undefined,
      // Plantillas actuales no usan DATA ni SALDO
    });

    if (!text.trim()) {
      Alert.alert('Mensagem vazia', 'Selecione um modelo válido.');
      return;
    }

    setLoading(true);
    try {
      await openWhats(phoneNormalized, text); // valida e abre
      onSent?.();
      if (autoClose) onClose();
    } catch (e) {
      Alert.alert('Erro', 'Não foi possível abrir o WhatsApp.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 40 : 0}
      >
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.sheet}>
          <Text style={styles.title}>Mensagem WhatsApp</Text>

          {/* Modelos (recordatório/cobrança) */}
          <View style={styles.row}>
            <Text style={styles.label}>Modelo</Text>
            <View style={styles.templatesRow}>
              {(Object.keys(TEMPLATES_PT) as Array<keyof typeof TEMPLATES_PT>).map((key) => {
                const active = key === templateKey;
                return (
                  <TouchableOpacity
                    key={String(key)}
                    onPress={() => handleChangeTemplate(key)}
                    style={[styles.chip, active && styles.chipActive]}
                    activeOpacity={0.9}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {TEMPLATES_PT[key].label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Telefone (somente exibição) */}
          <View style={styles.row}>
            <Text style={styles.label}>Telefone</Text>
            <Text style={styles.value}>
              {phoneNormalized ? phoneNormalized : 'Selecionar contato no WhatsApp'}
            </Text>
          </View>

          {/* Footer */}
          <View style={styles.footerRow}>
            <View style={styles.switchRow}>
              <Switch value={autoClose} onValueChange={setAutoClose} />
              <Text style={styles.switchLabel}>Fechar após enviar</Text>
            </View>

            <View style={styles.buttonsRow}>
              <TouchableOpacity onPress={onClose} style={styles.btnGhost} activeOpacity={0.9}>
                <Text style={styles.btnGhostTxt}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSend}
                style={[styles.btnPrimary, loading && { opacity: 0.7 }]}
                disabled={loading}
                activeOpacity={0.9}
              >
                <Text style={styles.btnPrimaryTxt}>{loading ? 'Abrindo…' : 'Enviar no WhatsApp'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, padding: 14, borderTopLeftRadius: 14,
    borderTopRightRadius: 14, backgroundColor: '#fff',
  },
  title: { fontSize: 16, fontWeight: '800', textAlign: 'center', marginBottom: 8, color: '#263238' },
  row: { marginBottom: 8 },
  label: { fontSize: 12, fontWeight: '700', color: '#607d8b', marginBottom: 4 },
  value: { fontSize: 13, color: '#37474F' },
  templatesRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1,
    borderColor: '#CFD8DC', backgroundColor: '#fff', marginRight: 6, marginBottom: 6,
  },
  chipActive: { backgroundColor: '#E8F5E9', borderColor: '#C8E6C9' },
  chipText: { fontSize: 12, color: '#37474F', fontWeight: '700' },
  chipTextActive: { color: '#2e7d32' },

  footerRow: { marginTop: 10 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  switchLabel: { fontSize: 12.5, color: '#455A64', fontWeight: '600' },
  buttonsRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  btnGhost: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, backgroundColor: '#ECEFF1' },
  btnGhostTxt: { color: '#37474F', fontWeight: '800' },
  btnPrimary: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, backgroundColor: '#2e7d32' },
  btnPrimaryTxt: { color: '#fff', fontWeight: '800' },
});
