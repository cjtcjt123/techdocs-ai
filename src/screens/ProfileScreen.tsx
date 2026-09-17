import React from 'react';
import { View, Text, ScrollView, StyleSheet, Switch, Pressable, TextInput } from 'react-native';
import { colors, radius, space } from '../theme';
import Button from '../components/Button';
import { useStore } from '../store';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ModelSource, DataStrategy, Provider } from '../types';

const sources: { key: ModelSource; label: string }[] = [
  { key: 'official', label: '官方API' },
  { key: 'nas', label: 'NAS后端' },
  { key: 'local', label: '手机本地' },
];
const providers: { key: Provider; label: string }[] = [
  { key: 'openai', label: 'OpenAI' },
  { key: 'claude', label: 'Claude' },
  { key: 'tongyi', label: '通义' },
  { key: 'zhipu', label: '智谱' },
  { key: 'custom', label: '自定义' },
];
const strategies: { key: DataStrategy; label: string }[] = [
  { key: 'local', label: '仅本地' },
  { key: 'local+sync', label: '本地+同步NAS' },
  { key: 'nas-only', label: '走NAS后端' },
];

export default function ProfileScreen() {
  const { settings, updateSettings, lock } = useStore();
  const navigation = useNavigation<NativeStackNavigationProp<any>>();
  const mc = settings.modelConfig;

  const seg = (
    opts: { key: string; label: string }[],
    value: string,
    onPick: (k: any) => void
  ) => (
    <View style={styles.seg}>
      {opts.map((o) => (
        <Pressable
          key={o.key}
          onPress={() => onPick(o.key)}
          style={[styles.segItem, value === o.key && styles.segItemOn]}
        >
          <Text style={[styles.segText, value === o.key && styles.segTextOn]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>我的</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>模型来源</Text>
        {seg(sources, mc.source, (k) => updateSettings({ modelConfig: { ...mc, source: k } }))}
        {mc.source === 'local' && <Text style={styles.note}>手机本地模型尚未接入（MVP 后续），切换后将提示未接入。</Text>}
        {mc.source === 'nas' && <Text style={styles.note}>走你的 NAS 后端 Ollama（OpenAI 兼容）。请在下方填写后端地址。</Text>}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>供应商</Text>
        {seg(providers, mc.provider || 'openai', (k) => updateSettings({ modelConfig: { ...mc, provider: k } }))}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>API 配置</Text>
        {mc.source === 'nas' && (
          <Field label="后端地址" placeholder="http://your-nas:11434/v1" value={mc.baseURL || ''} onChange={(v) => updateSettings({ modelConfig: { ...mc, baseURL: v } })} />
        )}
        {(mc.source === 'nas' || mc.provider === 'custom') && (
          <Field label="Base URL" placeholder="https://..." value={mc.baseURL || ''} onChange={(v) => updateSettings({ modelConfig: { ...mc, baseURL: v } })} />
        )}
        <Field label="模型名" placeholder={mc.source === 'nas' ? 'qwen2.5' : 'gpt-4o-mini'} value={mc.model || ''} onChange={(v) => updateSettings({ modelConfig: { ...mc, model: v } })} />
        {mc.source !== 'local' && (
          <Field label="API Key" placeholder="sk-..." secure value={mc.apiKey || ''} onChange={(v) => updateSettings({ modelConfig: { ...mc, apiKey: v } })} />
        )}
        <Text style={styles.note}>API Key 仅存于本机 secure-store，不上传。NAS 后端可由你在服务端代理官方 Key，进一步降低泄露面。</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>数据策略</Text>
        {seg(strategies, settings.dataStrategy, (k) => updateSettings({ dataStrategy: k }))}
        <Text style={styles.note}>
          {settings.dataStrategy === 'local' && '资料只存手机本地。'}
          {settings.dataStrategy === 'local+sync' && '手机本地为主，可选同步到你的 NAS 后端（同步功能后续接入）。'}
          {settings.dataStrategy === 'nas-only' && '默认走 NAS 后端，手机仅作客户端（同步功能后续接入）。'}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>隐私与安全</Text>
        <Row label="隐私锁（Face ID / 密码）" value={<Switch value={settings.privacy.faceID} onValueChange={(v) => updateSettings({ privacy: { ...settings.privacy, faceID: v } })} />} />
        <Row label="离线模式（禁用联网）" value={<Switch value={settings.privacy.offlineMode} onValueChange={(v) => updateSettings({ privacy: { ...settings.privacy, offlineMode: v } })} />} />
        <Row label="云端调用需确认" value={<Switch value={settings.privacy.cloudConfirm} onValueChange={(v) => updateSettings({ privacy: { ...settings.privacy, cloudConfirm: v } })} />} />
      </View>

      <View style={styles.card}>
        <Pressable style={styles.linkRow} onPress={() => navigation.navigate('Settings')}>
          <Text style={styles.linkText}>⚙️ 更多设置（导出格式 / 数据管理）</Text>
        </Pressable>
        <Pressable style={styles.linkRow} onPress={lock}>
          <Text style={[styles.linkText, { color: colors.red }]}>🔒 立即锁定</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {value}
    </View>
  );
}

function Field({ label, placeholder, value, onChange, secure }: { label: string; placeholder?: string; value: string; onChange: (v: string) => void; secure?: boolean }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput style={styles.fieldInput} placeholder={placeholder} placeholderTextColor={colors.muted} value={value} onChangeText={onChange} secureTextEntry={secure} autoCapitalize="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.s3, backgroundColor: colors.background, flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: space.s3 },
  card: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: space.s3, marginBottom: space.s2 },
  cardTitle: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: space.s2 },
  seg: { flexDirection: 'row', backgroundColor: colors.background, borderRadius: radius.sm, padding: 3, gap: 3 },
  segItem: { flex: 1, paddingVertical: 8, borderRadius: radius.sm - 2, alignItems: 'center' },
  segItemOn: { backgroundColor: colors.primary },
  segText: { fontSize: 13, color: colors.muted, fontWeight: '600' },
  segTextOn: { color: '#fff' },
  note: { fontSize: 12, color: colors.muted, marginTop: space.s2, lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: space.s1 },
  rowLabel: { fontSize: 14, color: colors.text },
  field: { marginBottom: space.s2 },
  fieldLabel: { fontSize: 12, color: colors.muted, marginBottom: 4 },
  fieldInput: { backgroundColor: colors.background, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, padding: space.s2, fontSize: 14, color: colors.text },
  linkRow: { paddingVertical: space.s2 },
  linkText: { fontSize: 14, color: colors.primary, fontWeight: '600' },
});
