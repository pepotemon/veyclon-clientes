// components/Themed.tsx
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  ViewProps,
  TextProps,
  StyleSheet,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { useAppTheme } from '../theme/ThemeProvider';

export function ThemedView(
  props: ViewProps & { variant?: 'screen' | 'card' | 'top' }
) {
  const { palette } = useAppTheme();
  const bg =
    props.variant === 'card'
      ? palette.cardBg
      : props.variant === 'top'
      ? palette.topBg
      : palette.screenBg;

  return <View {...props} style={[{ backgroundColor: bg }, props.style]} />;
}

export function ThemedText(
  props: TextProps & { soft?: boolean; bold?: boolean }
) {
  const { palette } = useAppTheme();
  return (
    <Text
      {...props}
      style={[
        { color: props.soft ? palette.softText : palette.text },
        props.bold && { fontWeight: '700' },
        props.style,
      ]}
    />
  );
}

type BtnBaseProps = Omit<React.ComponentProps<typeof Pressable>, 'style'> & {
  /** Forzamos a que style NO sea una función */
  style?: StyleProp<ViewStyle>;
};

type BtnProps = BtnBaseProps & {
  label: string;
  loading?: boolean;
  tone?: 'accent' | 'danger' | 'neutral';
};

export function ThemedButton({
  label,
  loading,
  tone = 'accent',
  style,
  ...rest
}: BtnProps) {
  const { palette } = useAppTheme();
  const bg =
    tone === 'danger'
      ? '#c62828'
      : tone === 'neutral'
      ? palette.cardBorder
      : palette.accent;

  return (
    <Pressable
      accessibilityRole="button"
      // style como callback que retorna SOLO estilos (no funciones dentro)
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: bg, opacity: pressed ? 0.85 : 1 },
        style, // ya garantizamos que no es función
      ]}
      {...rest}
    >
      {loading ? <ActivityIndicator /> : <Text style={styles.btnLabel}>{label}</Text>}
    </Pressable>
  );
}

export function Divider({ style }: { style?: any }) {
  const { palette } = useAppTheme();
  return (
    <View
      style={[
        { height: StyleSheet.hairlineWidth, backgroundColor: palette.divider },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  btn: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnLabel: { color: '#fff', fontWeight: '700' },
});
