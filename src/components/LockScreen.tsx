import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, Alert } from 'react-native';
import { colors, mono, radius, shadow, space } from '../theme';
import Button from './Button';
import { useStore } from '../store';

// 隐私锁：已设密码→输入解锁；未设→设置 4 位密码
export default function LockScreen() {
  const { passcodeSet, unlock, setPasscode } = useStore();
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');

  const Brand = (
    <View style={s.brandWrap}>
      <View style={s.logo}>
        <Text style={s.logoT}>京</Text>
      </View>
      <Text style={s.brand}>京美AI助手</Text>
    </View>
  );

  if (!passcodeSet) {
    return (
      <View style={s.container}>
        {Brand}
        <Text style={s.h}>设置访问密码</Text>
        <Text style={s.sub}>首次使用，设置一个 4 位密码以启用隐私锁（Face ID 可在「设置」里开启）。</Text>
        <TextInput style={s.input} placeholder="4 位密码" placeholderTextColor={colors.faint} keyboardType="numeric" maxLength={4} secureTextEntry value={code} onChangeText={setCode} />
        <TextInput style={s.input} placeholder="再次输入" placeholderTextColor={colors.faint} keyboardType="numeric" maxLength={4} secureTextEntry value={confirm} onChangeText={setConfirm} />
        <Button
          label="启用并进入"
          onPress={() => {
            if (code.length !== 4) return Alert.alert('请设置 4 位数字密码');
            if (code !== confirm) return Alert.alert('两次输入不一致');
            setPasscode(code);
          }}
        />
      </View>
    );
  }

  return (
    <View style={s.container}>
      {Brand}
      <Text style={s.h}>已锁定</Text>
      <Text style={s.sub}>输入密码以进入「京美AI助手」。</Text>
      <TextInput style={s.input} placeholder="密码" placeholderTextColor={colors.faint} keyboardType="numeric" maxLength={4} secureTextEntry value={code} onChangeText={setCode} />
      <Button
        label="解锁"
        onPress={() => {
          if (!unlock(code)) { setCode(''); Alert.alert('密码错误'); }
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', paddingHorizontal: space.s4 },
  brandWrap: { alignItems: 'center', marginBottom: space.s4 },
  logo: {
    width: 56, height: 56, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#8ea6f7',
    shadowColor: '#7882dc', shadowOpacity: 0.5, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 4,
  },
  logoT: { color: '#fff', fontSize: 24, fontWeight: '700' },
  brand: { marginTop: 12, fontSize: 14, fontWeight: '700', color: colors.text2, letterSpacing: 0.2 },
  h: { fontSize: 24, fontWeight: '700', color: colors.text, textAlign: 'center', letterSpacing: -0.5 },
  sub: { fontSize: 12.5, color: colors.muted, textAlign: 'center', marginTop: 8, marginBottom: space.s4, lineHeight: 19 },
  input: {
    backgroundColor: colors.card, borderRadius: radius.xl, paddingVertical: space.s3,
    fontFamily: mono, fontSize: 20, letterSpacing: 8, color: colors.text, textAlign: 'center',
    marginBottom: space.s2 + 2, ...shadow.card,
  },
});
