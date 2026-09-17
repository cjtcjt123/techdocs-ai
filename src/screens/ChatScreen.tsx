import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView, StyleSheet, Pressable, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { colors, radius, space } from '../theme';
import Button from '../components/Button';
import SourceQuote from '../components/SourceQuote';
import ComplianceTable from '../components/ComplianceTable';
import { useStore } from '../store';
import { Attachment, Message } from '../types';

export default function ChatScreen() {
  const { conversations, currentConvId, newConversation, sendMessage, runCompliance, thinking, pickAttachments, pickImage, lastError } = useStore();
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!currentConvId) newConversation();
  }, []);

  const conv = conversations.find((c) => c.id === currentConvId);
  const messages = conv?.messages || [];

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages.length, thinking]);

  const addAttachments = async () => {
    const picked = await pickAttachments();
    if (picked.length) setAttachments((a) => [...a, ...picked]);
  };

  // 从系统相册选照片（此前这个按钮只弹了一句说明、并没有真正选图）
  const addPhoto = async () => {
    try {
      const picked = await pickImage();
      if (picked.length) setAttachments((a) => [...a, ...picked]);
    } catch (e: any) {
      Alert.alert('相册', e?.message || '选择照片失败');
    }
  };

  const removeAttach = (idx: number) => setAttachments((a) => a.filter((_, i) => i !== idx));

  const submit = (mode: 'chat' | 'compliance') => {
    if (!text.trim() && attachments.length === 0) return;
    const payload = text.trim();
    const att = [...attachments];
    setText(''); setAttachments([]);
    if (mode === 'compliance') runCompliance(payload, att.length ? att : undefined);
    else sendMessage(payload, att.length ? att : undefined);
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView ref={scrollRef} style={styles.list} contentContainerStyle={styles.listInner}>
        {messages.length === 0 && (
          <View style={styles.welcome}>
            <Text style={styles.welcomeText}>你好，导入资料后即可用自然语言提问。</Text>
            <Text style={styles.welcomeHint}>试试：「只给我 CY1578 的耐温值」「提取配置步骤」，或贴一段技术要求做「需求符合性检查」。</Text>
          </View>
        )}
        {messages.map((m) => <Bubble key={m.id} m={m} />)}
        {thinking && <View style={[styles.bubble, { alignSelf: 'flex-start', backgroundColor: colors.primarySoft }]}><Text style={{ color: colors.text }}>思考中…</Text></View>}
      </ScrollView>

      {attachments.length > 0 && (
        <View style={styles.attStrip}>
          {attachments.map((a, i) => (
            <Pressable key={i} onPress={() => removeAttach(i)} style={styles.attChip}>
              <Text style={styles.attChipText} numberOfLines={1}>{a.text ? '📄' : '🖼'} {a.name}</Text>
              <Text style={styles.attChipX}>×</Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={styles.inputBar}>
        <Pressable style={styles.attBtn} onPress={addAttachments}>
          <Text style={{ fontSize: 18 }}>📎</Text>
        </Pressable>
        <Pressable style={styles.attBtn} onPress={addPhoto}>
          <Text style={{ fontSize: 18 }}>🖼️</Text>
        </Pressable>
        <TextInput
          style={styles.input}
          placeholder="输入问题，或粘贴报错信息…"
          placeholderTextColor={colors.muted}
          value={text}
          onChangeText={setText}
          multiline
        />
        <Pressable style={styles.send} onPress={() => submit('chat')}>
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>发送</Text>
        </Pressable>
      </View>

      <View style={styles.modeBar}>
        <Pressable style={styles.complianceBtn} onPress={() => submit('compliance')}>
          <Text style={styles.complianceText}>✓ 需求符合性检查</Text>
        </Pressable>
        {lastError ? <Text style={styles.errText} numberOfLines={1}>{lastError}</Text> : null}
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({ m }: { m: Message }) {
  const isUser = m.role === 'user';
  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAi]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAi]}>
        {isUser ? (
          <Text style={{ color: '#fff' }}>{m.content}</Text>
        ) : (
          <Text style={{ color: colors.text }}>{m.content}</Text>
        )}
        {!isUser && m.compliance && <ComplianceTable result={m.compliance} />}
        {!isUser && m.quotes && m.quotes.length > 0 && (
          <View style={{ marginTop: space.s1 }}>
            <Text style={styles.quoteHead}>引用来源</Text>
            {m.quotes.map((q, i) => <SourceQuote key={i} quote={q} />)}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  list: { flex: 1 },
  listInner: { padding: space.s3, paddingBottom: space.s2 },
  welcome: { paddingVertical: space.s4, alignItems: 'center' },
  welcomeText: { fontSize: 15, color: colors.text, marginBottom: 6 },
  welcomeHint: { fontSize: 12, color: colors.muted, textAlign: 'center', paddingHorizontal: space.s4, lineHeight: 18 },
  row: { flexDirection: 'row', marginBottom: space.s2 },
  rowUser: { justifyContent: 'flex-end' },
  rowAi: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '86%', borderRadius: radius.md, padding: space.s3 },
  bubbleUser: { backgroundColor: colors.primary },
  bubbleAi: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  quoteHead: { fontSize: 12, fontWeight: '700', color: colors.text, marginTop: space.s1, marginBottom: 2 },
  attStrip: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: space.s3, paddingBottom: space.s1, gap: space.s1 },
  attChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primarySoft, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10, maxWidth: 200 },
  attChipText: { fontSize: 12, color: colors.primary, maxWidth: 150 },
  attChipX: { fontSize: 12, color: colors.primary, marginLeft: 6, fontWeight: '700' },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end', padding: space.s2, paddingBottom: space.s2 + (Platform.OS === 'ios' ? 0 : 0),
    borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface, gap: space.s1,
  },
  attBtn: { width: 38, height: 38, borderRadius: 999, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  input: {
    flex: 1, backgroundColor: colors.background, borderRadius: radius.sm, paddingVertical: space.s2 - 3,
    paddingHorizontal: space.s3, fontSize: 14, color: colors.text, maxHeight: 100,
  },
  send: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: space.s2 - 3, paddingHorizontal: space.s3, alignItems: 'center', justifyContent: 'center', height: 38 },
  modeBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.s3, paddingBottom: space.s3, gap: space.s2, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border },
  complianceBtn: { backgroundColor: colors.greenSoft, borderRadius: radius.sm, paddingVertical: space.s2 - 3, paddingHorizontal: space.s3 },
  complianceText: { color: colors.green, fontSize: 13, fontWeight: '700' },
  errText: { fontSize: 11, color: colors.red, flex: 1, textAlign: 'right' },
});
