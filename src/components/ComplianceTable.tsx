import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, radius, space } from '../theme';
import { ComplianceResult } from '../types';

const verdictMeta: Record<string, { label: string; bg: string; fg: string }> = {
  ok: { label: '满足', bg: colors.greenSoft, fg: colors.green },
  no: { label: '不满足', bg: colors.redSoft, fg: colors.red },
  warn: { label: '差一点', bg: colors.amberSoft, fg: colors.amber },
};

// 需求符合性检查卡：逐项三态判定 + 结论
export default function ComplianceTable({ result }: { result: ComplianceResult }) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>🔍 需求符合性检查 · {result.model}</Text>
      {result.items.map((it, i) => {
        const m = verdictMeta[it.verdict] || verdictMeta.warn;
        return (
          <View key={i} style={styles.row}>
            <View style={[styles.badge, { backgroundColor: m.bg }]}>
              <Text style={[styles.badgeText, { color: m.fg }]}>{m.label}</Text>
            </View>
            <View style={styles.body}>
              <Text style={styles.item}>{it.item}</Text>
              <Text style={styles.kv}><Text style={styles.k}>要求：</Text>{it.required}</Text>
              <Text style={styles.kv}><Text style={styles.k}>实际：</Text>{it.actual}</Text>
              {it.source ? <Text style={styles.src}>来源：{it.source}</Text> : null}
            </View>
          </View>
        );
      })}
      <View style={styles.concl}>
        <Text style={styles.conclText}>{result.conclusion}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: space.s3, marginTop: space.s2 },
  title: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: space.s2 },
  row: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: space.s2 },
  badge: { borderRadius: 999, paddingVertical: 3, paddingHorizontal: 10, marginRight: space.s2, marginTop: 2 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  body: { flex: 1 },
  item: { fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 2 },
  kv: { fontSize: 12, color: colors.text },
  k: { color: colors.muted },
  src: { fontSize: 11, color: colors.muted, marginTop: 2 },
  concl: { backgroundColor: colors.background, borderRadius: radius.sm, padding: space.s2, marginTop: space.s1 },
  conclText: { fontSize: 12, color: colors.text, lineHeight: 18 },
});
