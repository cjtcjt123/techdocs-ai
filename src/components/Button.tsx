import React from 'react';
import { Pressable, Text, StyleSheet, ViewStyle } from 'react-native';
import { colors, radius, space } from '../theme';

type Variant = 'primary' | 'ghost' | 'soft' | 'text' | 'danger';

type Props = {
  label: string;
  variant?: Variant;
  onPress?: () => void;
  disabled?: boolean;
  style?: ViewStyle;
};

// 全应用统一按钮：继承 base，只用 variant 切换，禁止页面内手写样式（对齐 PRD 6.1）
const bg: Record<Variant, string> = {
  primary: colors.primary,
  ghost: 'transparent',
  soft: colors.primarySoft,
  text: 'transparent',
  danger: colors.red,
};
const fg: Record<Variant, string> = {
  primary: '#fff',
  ghost: colors.primary,
  soft: colors.primary,
  text: colors.primary,
  danger: '#fff',
};
const border: Record<Variant, string> = {
  primary: 'transparent',
  ghost: colors.primary,
  soft: 'transparent',
  text: 'transparent',
  danger: 'transparent',
};

export default function Button({ label, variant = 'primary', onPress, disabled, style }: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: bg[variant], borderColor: border[variant] },
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      <Text style={[styles.label, { color: fg[variant] }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    paddingVertical: 11,
    paddingHorizontal: space.s3,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 13.5, fontWeight: '600' },
  pressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.4 },
});
