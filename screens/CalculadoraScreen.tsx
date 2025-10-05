// screens/CalculadoraScreen.tsx
import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
  Keyboard,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAppTheme } from '../theme/ThemeProvider';
import { MaterialCommunityIcons as MIcon } from '@expo/vector-icons';

type Modo = 'simulador' | 'basica';

export default function CalculadoraScreen() {
  const { palette } = useAppTheme();
  const [modo, setModo] = useState<Modo>('simulador');

  // ─────────────────────────────────────────────────────────────
  // MODO 1: Simulador de préstamo (tu lógica original)
  // ─────────────────────────────────────────────────────────────
  const [valorNeto, setValorNeto] = useState('');
  const [interes, setInteres] = useState('0');
  const [cuotas, setCuotas] = useState('');

  const toNum = (s: string) => {
    const x = parseFloat((s ?? '').replace(',', '.'));
    return Number.isFinite(x) ? x : 0;
    };

  const valor = toNum(valorNeto);
  const interesPct = toNum(interes);
  const cuotasNum = Math.max(0, Math.trunc(toNum(cuotas)));

  const totalCalc = useMemo(() => {
    if (valor <= 0) return 0;
    return +(valor + (valor * interesPct) / 100).toFixed(2);
  }, [valor, interesPct]);

  const valorCuota = useMemo(() => {
    if (totalCalc <= 0 || cuotasNum <= 0) return 0;
    return +(totalCalc / cuotasNum).toFixed(2);
  }, [totalCalc, cuotasNum]);

  // ─────────────────────────────────────────────────────────────
  // MODO 2: Calculadora básica
  // ─────────────────────────────────────────────────────────────
  const [expr, setExpr] = useState<string>('');   // texto mostrado
  const [justEvaluated, setJustEvaluated] = useState(false);

  const isOp = (c: string) => ['+', '−', '×', '÷'].includes(c);

  const handleClear = () => {
    setExpr('');
    setJustEvaluated(false);
  };
  const handleBack = () => {
    if (!expr) return;
    setExpr(expr.slice(0, -1));
  };

  const pushDigit = (d: string) => {
    // si acabamos de evaluar y ahora escribimos un número, comenzar nueva expresión
    if (justEvaluated) {
      setExpr(d === '.' ? '0.' : d);
      setJustEvaluated(false);
      return;
    }
    // control de múltiples puntos en el último número
    if (d === '.') {
      const lastNum = expr.split(/[+\-−×÷]/).pop() ?? '';
      if (lastNum.includes('.')) return;
      if (!lastNum) {
        // si empieza con punto, anteponer 0
        setExpr(expr + '0.');
        return;
      }
    }
    setExpr(expr + d);
  };

  const pushOp = (op: '＋' | '−' | '×' | '÷' | '+') => {
    const trueOp = op === '＋' ? '+' : (op as '+' | '−' | '×' | '÷');
    if (!expr) {
      // permitir negativo inicial
      if (trueOp === '−') setExpr('−');
      return;
    }
    const last = expr.slice(-1);
    if (isOp(last)) {
      // reemplazar operador
      setExpr(expr.slice(0, -1) + trueOp);
    } else {
      setExpr(expr + trueOp);
    }
    setJustEvaluated(false);
  };

  // Eval simple con precedencia (× y ÷ primero, luego + y −)
  const evaluate = () => {
    if (!expr) return;
    // no terminar con operador
    if (isOp(expr.slice(-1))) setExpr(expr.slice(0, -1));

    try {
      // tokenizar números (incluye negativos) y operadores
      const tokens: (number | string)[] = [];
      let i = 0;
      while (i < expr.length) {
        const ch = expr[i];
        if (isOp(ch)) {
          // signo negativo como unario (al inicio o tras otro op)
          if (ch === '−' && (i === 0 || isOp(expr[i - 1]))) {
            // leer número negativo
            let j = i + 1;
            let numStr = '-';
            while (j < expr.length && /[\d.]/.test(expr[j])) {
              numStr += expr[j++];
            }
            const num = parseFloat(numStr);
            if (Number.isFinite(num)) {
              tokens.push(num);
              i = j;
              continue;
            }
          }
          tokens.push(ch);
          i++;
          continue;
        }
        // número
        if (/\d|\./.test(ch)) {
          let j = i;
          let numStr = '';
          while (j < expr.length && /[\d.]/.test(expr[j])) {
            numStr += expr[j++];
          }
          const num = parseFloat(numStr);
          if (!Number.isFinite(num)) throw new Error('num inválido');
          tokens.push(num);
          i = j;
          continue;
        }
        // ignorar espacios
        if (ch === ' ') { i++; continue; }
        throw new Error('carácter inválido');
      }

      if (tokens.length === 0) return;

      // primera pasada: × y ÷
      const pass1: (number | string)[] = [];
      let k = 0;
      while (k < tokens.length) {
        const t = tokens[k];
        if (t === '×' || t === '÷') {
          const a = pass1.pop();
          const b = tokens[k + 1];
          if (typeof a !== 'number' || typeof b !== 'number') throw new Error('expresión inválida');
          const res = t === '×' ? a * b : a / b;
          pass1.push(res);
          k += 2;
        } else {
          pass1.push(t);
          k++;
        }
      }

      // segunda pasada: + y −
      let acc: number | null = null;
      let op: string | null = null;
      for (const t of pass1) {
        if (typeof t === 'number') {
          if (acc === null) acc = t;
          else if (op === '+') acc = acc + t;
          else if (op === '−') acc = acc - t;
          else throw new Error('operador inesperado');
        } else if (t === '+' || t === '−') {
          op = t;
        } else {
          throw new Error('token inesperado');
        }
      }

      if (acc === null || !Number.isFinite(acc)) throw new Error('NaN');
      const out = (Math.round(acc * 1e10) / 1e10).toString(); // limitar flotantes
      setExpr(out);
      setJustEvaluated(true);
    } catch {
      // si hay error, no romper UI; feedback simple
      setExpr('Error');
      setJustEvaluated(true);
    }
  };

  // ─────────────────────────────────────────────────────────────
  return (
      <SafeAreaView
    style={{ flex: 1, backgroundColor: palette.screenBg }}
    edges={['left','right','bottom']}   // 👈 evita el hueco
  >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={[styles.container, { padding: 16 }]}>
            {/* Header con toggle */}
            <View style={styles.headerRow}>
              <Text style={[styles.title, { color: palette.text }]}>
                {modo === 'simulador' ? 'Calculadora de Préstamo' : 'Calculadora Básica'}
              </Text>
              <TouchableOpacity
                onPress={() => setModo(modo === 'simulador' ? 'basica' : 'simulador')}
                activeOpacity={0.8}
                style={[
                  styles.toggleBtn,
                  { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
                ]}
              >
                <MIcon
                  name={modo === 'simulador' ? 'calculator-variant' : 'finance'}
                  size={18}
                  color={palette.text}
                />
              </TouchableOpacity>
            </View>

            {modo === 'simulador' ? (
              <>
                <Field
                  label="Valor neto (R$)"
                  value={valorNeto}
                  onChangeText={setValorNeto}
                  keyboardType="decimal-pad"
                  palette={palette}
                />

                <Field
                  label="Interés (%)"
                  value={interes}
                  onChangeText={setInteres}
                  keyboardType="decimal-pad"
                  palette={palette}
                />

                <Field
                  label="Cuotas"
                  value={cuotas}
                  onChangeText={setCuotas}
                  keyboardType="number-pad"
                  palette={palette}
                />

                <View
                  style={[
                    styles.card,
                    { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
                  ]}
                >
                  <Row
                    label="Total préstamo"
                    value={totalCalc ? `R$ ${totalCalc.toFixed(2)}` : '—'}
                    palette={palette}
                  />
                  <Row
                    label="Valor por cuota"
                    value={valorCuota ? `R$ ${valorCuota.toFixed(2)}` : '—'}
                    palette={palette}
                  />
                </View>

                <Text style={[styles.hint, { color: palette.softText }]}>
                  Esta calculadora no guarda datos. Úsala para simular antes de crear el préstamo.
                </Text>
              </>
            ) : (
              <>
                {/* Display */}
                <View
                  style={[
                    styles.display,
                    { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
                  ]}
                >
                  <Text
                    style={[
                      styles.displayText,
                      { color: palette.text },
                    ]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                  >
                    {expr || '0'}
                  </Text>
                </View>

                {/* Teclado */}
                <View style={styles.pad}>
                  <PadRow>
                    <Key text="C" kind="util" onPress={handleClear} palette={palette} />
                    <Key text="⌫" kind="util" onPress={handleBack} palette={palette} />
                    <Key text="÷" kind="op" onPress={() => pushOp('÷')} palette={palette} />
                    <Key text="×" kind="op" onPress={() => pushOp('×')} palette={palette} />
                  </PadRow>
                  <PadRow>
                    <Key text="7" onPress={() => pushDigit('7')} palette={palette} />
                    <Key text="8" onPress={() => pushDigit('8')} palette={palette} />
                    <Key text="9" onPress={() => pushDigit('9')} palette={palette} />
                    <Key text="−" kind="op" onPress={() => pushOp('−')} palette={palette} />
                  </PadRow>
                  <PadRow>
                    <Key text="4" onPress={() => pushDigit('4')} palette={palette} />
                    <Key text="5" onPress={() => pushDigit('5')} palette={palette} />
                    <Key text="6" onPress={() => pushDigit('6')} palette={palette} />
                    <Key text="+" kind="op" onPress={() => pushOp('+')} palette={palette} />
                  </PadRow>
                  <PadRow>
                    <Key text="1" onPress={() => pushDigit('1')} palette={palette} />
                    <Key text="2" onPress={() => pushDigit('2')} palette={palette} />
                    <Key text="3" onPress={() => pushDigit('3')} palette={palette} />
                    <Key text="=" kind="eq" onPress={evaluate} palette={palette} />
                  </PadRow>
                  <PadRow>
                    <Key text="0" wide onPress={() => pushDigit('0')} palette={palette} />
                    <Key text="." onPress={() => pushDigit('.')} palette={palette} />
                  </PadRow>
                </View>
              </>
            )}
          </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/* ───────── componentes internos ───────── */

function Field({
  label,
  value,
  onChangeText,
  keyboardType = 'default',
  palette,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  keyboardType?: 'default' | 'number-pad' | 'decimal-pad';
  palette: ReturnType<typeof useAppTheme>['palette'];
}) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={[styles.label, { color: palette.softText }]}>{label}</Text>
      <TextInput
        style={[
          styles.input,
          { color: palette.text, borderColor: palette.cardBorder, backgroundColor: palette.cardBg },
        ]}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        placeholder={label}
        placeholderTextColor={palette.softText}
      />
    </View>
  );
}

function Row({
  label,
  value,
  palette,
}: {
  label: string;
  value: string;
  palette: ReturnType<typeof useAppTheme>['palette'];
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: palette.text }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: palette.text }]}>{value}</Text>
    </View>
  );
}

function PadRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.padRow}>{children}</View>;
}

function Key({
  text,
  onPress,
  kind = 'num',
  wide = false,
  palette,
}: {
  text: string;
  onPress: () => void;
  kind?: 'num' | 'op' | 'eq' | 'util';
  wide?: boolean;
  palette: ReturnType<typeof useAppTheme>['palette'];
}) {
  const base = [
    styles.key,
    wide && styles.keyWide,
    { backgroundColor: palette.cardBg, borderColor: palette.cardBorder },
  ];
  let color = palette.text;
  if (kind === 'op') color = palette.accent;
  if (kind === 'eq') color = '#ffffff';
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={[
        ...base,
        kind === 'eq' && { backgroundColor: palette.accent, borderColor: palette.accent },
      ]}
    >
      <Text
        style={[
          styles.keyTxt,
          { color },
        ]}
      >
        {text}
      </Text>
    </TouchableOpacity>
  );
}

/* ───────── estilos ───────── */

const styles = StyleSheet.create({
  container: { flex: 1 },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  toggleBtn: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },

  title: { fontSize: 18, fontWeight: '800', marginBottom: 4, textAlign: 'left' },
  label: { fontSize: 12, marginBottom: 6, fontWeight: '700' },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  card: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  rowLabel: { fontSize: 14, fontWeight: '700' },
  rowValue: { fontSize: 14, fontWeight: '700' },
  hint: { textAlign: 'center', marginTop: 10, fontSize: 12 },

  // Calculadora básica
  display: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    marginTop: 6,
    marginBottom: 10,
    minHeight: 54,
    justifyContent: 'center',
  },
  displayText: { fontSize: 28, fontWeight: '800', textAlign: 'right' },

  pad: { marginTop: 4 },
  padRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  key: {
    flex: 1,
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyWide: {
    flex: 2,
  },
  keyTxt: { fontSize: 18, fontWeight: '800' },
});
