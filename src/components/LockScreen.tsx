import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, Alert } from 'react-native';
import { colors, radius, space } from '../theme';
import Button from './Button';
import { useStore } from '../store';

// 隐私锁：已设密码→输入解锁；未设→设置 4 位密码
export default function LockScreen() {
  const { passcodeSet, unlock, setPasscode } = useStore();
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');

  if (!passcodeSet) {
    return (
      <View style={styles.container}>
        <Text style={styles.h}>🔒 设置访问密码</Text>
        <Text style={styles.sub}>首次使用，设置一个 4 位密码以启用隐私锁（Face ID 可在「我的」开启）。</Text>
        <TextInput style={styles.input} placeholder="4 位密码" keyboardType="numeric" maxLength={4} secureTextEntry value={code} onChangeText={setCode} />
        <TextInput style={styles.input} placeholder="再次输入" keyboardType="numeric" maxLength={4} secureTextEntry value={confirm} onChangeText={setConfirm} />
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
    <View style={styles.container}>
      <Text style={styles.h}>🔒 已锁定</Text>
      <Text style={styles.sub}>输入密码以进入「技术资料 AI 助手」。</Text>
      <TextInput style={styles.input} placeholder="密码" keyboardType="numeric" maxLength={4} secureTextEntry value={code} onChangeText={setCode} />
      <Button
        label="解锁"
        onPress={() => {
          if (!unlock(code)) { setCode(''); Alert.alert('密码错误'); }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', padding: space.s4 },
  h: { fontSize: 24, fontWeight: '700', color: colors.text, textAlign: 'center' },
  sub: { fontSize: 13, color: colors.muted, textAlign: 'center', marginVertical: space.s3 },
  input: {
    backgroundColor: colors.surface, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border,
    padding: space.s3, fontSize: 16, color: colors.text, textAlign: 'center', marginBottom: space.s2,
  },
});
