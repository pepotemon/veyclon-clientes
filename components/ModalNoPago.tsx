// components/ModalNoPago.tsx
import React, { useMemo, useState, useEffect } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, TextInput, ActivityIndicator, Platform,
  Pressable, KeyboardAvoidingView, TouchableWithoutFeedback, Keyboard,
} from 'react-native';
import DateTimePickerModal from 'react-native-modal-datetime-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from '../theme/ThemeProvider';

type Reason =
  | 'no_contesto'
  | 'no_en_casa'
  | 'promesa'
  | 'dinero'
  | 'enfermedad'
  | 'viaje'
  | 'se_mudo'
  | 'otro';

const REASONS: { key: Reason; label: string }[] = [
  { key: 'no_contesto', label: 'No contestó' },
  { key: 'no_en_casa', label: 'No estaba en casa' },
  { key: 'promesa', label: 'Promesa de pago' },
  { key: 'dinero', label: 'Problemas de dinero' },
  { key: 'viaje', label: 'Trabajo/Viaje' },
  { key: 'enfermedad', label: 'Enfermedad' },
  { key: 'se_mudo', label: 'Se mudó' },
  { key: 'otro', label: 'Otro' },
];

type Props = {
  visible: boolean;
  onCancel: () => void;
  onSave: (payload: {
    reason: Reason;
    nota?: string;
    promesaFecha?: string; // YYYY-MM-DD
    promesaMonto?: number;
  }) => Promise<void> | void;
  saving?: boolean;
};

export default function ModalNoPago({ visible, onCancel, onSave, saving }: Props) {
  const { palette } = useAppTheme();
  const insets = useSafeAreaInsets();
  const ACCENT = palette.accent ?? '#2e7d32';

  const [reason, setReason] = useState<Reason>('no_contesto');
  const [nota, setNota] = useState('');
  const [promesaFecha, setPromesaFecha] = useState(''); // YYYY-MM-DD
  const [promesaMonto, setPromesaMonto] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  // reset al cerrar
  useEffect(() => {
    if (!visible) {
      setReason('no_contesto');
      setNota('');
      setPromesaFecha('');
      setPromesaMonto('');
      setPickerOpen(false);
    }
  }, [visible]);

  const isPromesa = reason === 'promesa';
  const isOtro = reason === 'otro';

  const disableSave = useMemo(() => !!saving, [saving]);

  const parseMonto = (v: string) => {
    const norm = v.replace(',', '.').trim();
    const n = Number(norm);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  const normYYYYMMDD = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };

  const today = new Date();
  const minDate = new Date(today.getFullYear(), today.getMonth(), today.getDate()); // desde hoy (promesas futuras o hoy)

  const handleSave = () => {
    onSave({
      reason,
      nota: isOtro && nota.trim() ? nota.trim() : undefined,
      promesaFecha: isPromesa && promesaFecha.trim() ? promesaFecha.trim() : undefined,
      promesaMonto: isPromesa && promesaMonto.trim() ? parseMonto(promesaMonto) : undefined,
    });
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <View style={styles.overlay}>
          {/* backdrop para cerrar */}
          <Pressable style={styles.backdrop} onPress={onCancel} />

          {/* sheet */}
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={[
              styles.sheet,
              { backgroundColor: palette.cardBg, paddingBottom: 12 + Math.max(insets.bottom, 10) },
            ]}
          >
            <Text style={[styles.title, { color: palette.text }]}>Razón de no pago</Text>

            <View style={styles.chips}>
              {REASONS.map((r) => {
                const active = r.key === reason;
                return (
                  <TouchableOpacity
                    key={r.key}
                    style={[
                      styles.chip,
                      { borderColor: palette.cardBorder, backgroundColor: palette.topBg },
                      active && { backgroundColor: palette.commBg, borderColor: ACCENT },
                    ]}
                    onPress={() => setReason(r.key)}
                    disabled={!!saving}
                    activeOpacity={0.85}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        { color: palette.softText },
                        active && { color: ACCENT, fontWeight: '700' },
                      ]}
                    >
                      {r.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {isPromesa && (
              <View style={{ marginTop: 10 }}>
                <Text style={[styles.label, { color: palette.softText }]}>Fecha prometida</Text>
                <TouchableOpacity
                  style={[
                    styles.input,
                    { borderColor: palette.cardBorder, backgroundColor: palette.kpiTrack },
                  ]}
                  onPress={() => setPickerOpen(true)}
                  disabled={!!saving}
                  activeOpacity={0.8}
                >
                  <Text style={{ color: palette.text }}>{promesaFecha || 'YYYY-MM-DD'}</Text>
                </TouchableOpacity>

                <Text style={[styles.label, { color: palette.softText }]}>Monto prometido (R$)</Text>
                <TextInput
                  style={[
                    styles.input,
                    {
                      borderColor: palette.cardBorder,
                      color: palette.text,
                      backgroundColor: palette.kpiTrack,
                    },
                  ]}
                  placeholder="50.00"
                  placeholderTextColor={palette.softText}
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                  value={promesaMonto}
                  onChangeText={setPromesaMonto}
                  editable={!saving}
                />
              </View>
            )}

            {isOtro && (
              <View style={{ marginTop: 10 }}>
                <Text style={[styles.label, { color: palette.softText }]}>Nota</Text>
                <TextInput
                  style={[
                    styles.input,
                    {
                      height: 90,
                      borderColor: palette.cardBorder,
                      color: palette.text,
                      backgroundColor: palette.kpiTrack,
                      textAlignVertical: 'top',
                    },
                  ]}
                  placeholder="Escribe una breve nota..."
                  placeholderTextColor={palette.softText}
                  value={nota}
                  onChangeText={setNota}
                  editable={!saving}
                  multiline
                />
              </View>
            )}

            <View style={styles.row}>
              <TouchableOpacity
                style={[styles.btnCancel, { backgroundColor: palette.commBg }]}
                onPress={onCancel}
                disabled={!!saving}
                activeOpacity={0.85}
              >
                <Text style={[styles.btnCancelTxt, { color: palette.text }]}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnSave, { backgroundColor: ACCENT }, disableSave && { opacity: 0.6 }]}
                onPress={handleSave}
                disabled={disableSave}
                activeOpacity={0.9}
              >
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnSaveTxt}>Guardar</Text>}
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>

          {/* Date picker (promesa) */}
          <DateTimePickerModal
            isVisible={pickerOpen}
            mode="date"
            onConfirm={(d) => {
              setPromesaFecha(normYYYYMMDD(d));
              setPickerOpen(false);
            }}
            onCancel={() => setPickerOpen(false)}
            minimumDate={minDate}
          />
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  title: { fontSize: 18, fontWeight: '800', textAlign: 'center', marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1, borderRadius: 18, paddingHorizontal: 10, paddingVertical: 6,
  },
  chipText: {},
  label: { fontSize: 12, marginBottom: 6, marginTop: 8 },
  input: {
    borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 10, marginBottom: 6,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14, gap: 12 },
  btnCancel: { flex: 1, padding: 12, borderRadius: 8 },
  btnCancelTxt: { textAlign: 'center', fontWeight: '700' },
  btnSave: { flex: 1, padding: 12, borderRadius: 8 },
  btnSaveTxt: { textAlign: 'center', color: '#fff', fontWeight: '800' },
});
