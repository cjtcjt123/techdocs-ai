import React from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable } from 'react-native';
import { colors, radius, space } from '../theme';
import { useStore } from '../store';

const formats = [
  { key: 'markdown', label: 'Markdown' },
  { key: 'csv', label: 'CSV' },
  { key: 'pdf', label: 'PDF' },
] as const;

export default function SettingsScreen() {
  const { settings, updateSettings, documents } = useStore();
  const total = documents.length;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>更多设置</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>导出格式（默认）</Text>
        <View style={styles.seg}>
          {formats.map((f) => (
            <Pressable
              key={f.key}
              onPress={() => updateSettings({ exportFormat: f.key })}
              style={[styles.segItem, settings.exportFormat === f.key && styles.segItemOn]}
            >
              <Text style={[styles.segText, settings.exportFormat === f.key && styles.segTextOn]}>{f.label}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.note}>问答/合规结果可导出为所选格式（导出功能后续接入）。</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>数据管理</Text>
        <Text style={styles.row}>本地文档：{total} 份</Text>
        <Text style={styles.note}>重置数据库、批量导出等功能后续接入。NAS 同步按「我的 → 数据策略」启用。</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>关于</Text>
        <Text style={styles.row}>京美AI助手 · MVP-0</Text>
        <Text style={styles.note}>架构：手机本地存储 + 官方 API / NAS 后端 / 手机本地三源模型（C 方案）。本地离线模型与 NAS 同步为后续迭代。</Text>
      </View>
    </ScrollView>
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
  row: { fontSize: 14, color: colors.text, paddingVertical: space.s1 },
});
