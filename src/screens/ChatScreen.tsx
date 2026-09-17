import React, { useState } from 'react';
import { View, Text, TextInput, ScrollView, StyleSheet } from 'react-native';
import { colors, radius, space } from '../theme';
import Button from '../components/Button';

// MVP 占位：问答对话 + 输入框（后续接云端 AI + 来源引用卡）
export default function ChatScreen() {
  const [q, setQ] = useState('');

  return (
    <View style={styles.container}>
      <ScrollView style={styles.list} contentContainerStyle={styles.listInner}>
        <View style={[styles.bubble, { alignSelf: 'flex-start', backgroundColor: colors.primarySoft }]}>
          <Text style={{ color: colors.text }}>
            你好，导入资料后可以用自然语言提问，例如「只给我 XX 型号的耐温值」。
          </Text>
        </View>
      </ScrollView>

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          placeholder="用自然语言提问…"
          placeholderTextColor={colors.muted}
          value={q}
          onChangeText={setQ}
        />
        <Button label="发送" onPress={() => setQ('')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  list: { flex: 1 },
  listInner: { padding: space.s3 },
  bubble: {
    maxWidth: '80%',
    borderRadius: radius.md,
    padding: space.s3,
    marginBottom: space.s2,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: space.s2,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    gap: space.s2,
  },
  input: {
    flex: 1,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    paddingVertical: space.s2 - 3,
    paddingHorizontal: space.s3,
    fontSize: 14,
    color: colors.text,
  },
});
