// 需求符合性检查：逐项三态判定
// 数值一律等宽（mono），让「实际 vs 要求」成列 —— 比参数时不用来回对位置
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, mono, radius, shadow, space, verdictColor } from '../theme';
import type { ComplianceResult } from '../types';

const LABEL: Record<string, string> = { ok: '满足', no: '不满足', warn: '差一点' };

export default function ComplianceTable({
  result,
  showConclusion = true,
}: {
  result: ComplianceResult;
  showConclusion?: boolean;
}) {
  return (
    <View style={styles.wrap}>
      {result.items.map((it, i) => {
        const v = (['ok', 'no', 'warn'].includes(it.verdict) ? it.verdict : 'warn') as 'ok' | 'no' | 'warn';
        const c = verdictColor(v === 'warn' ? 'warn' : v === 'no' ? 'no' : 'ok');
        const na = /资料未提供|未提供|未列/.test(it.actual);
        return (
          <View key={i} style={[styles.row, i === result.items.length - 1 && styles.rowLast]}>
            <View style={styles.left}>
              <Text style={styles.item} numberOfLines={1}>
                {it.item}
              </Text>
              <Text style={styles.vs} numberOfLines={1}>
                <Text style={[styles.a, na && styles.na]}>{it.actual}</Text>
                <Text style={styles.b}>  vs {it.required}</Text>
              </Text>
              {it.source ? (
                <Text style={styles.src} numberOfLines={1}>
                  {it.source}
                </Text>
              ) : null}
            </View>
            <View style={[styles.pill, { backgroundColor: na ? colors.borderSoft : c.bg }]}>
              <Text style={[styles.pillT, { color: na ? colors.muted : c.fg }]}>{na ? '无数据' : LABEL[v]}</Text>
            </View>
          </View>
        );
      })}
      {showConclusion && result.conclusion ? (
        <View style={styles.concl}>
          <Text style={styles.conclT}>{result.conclusion}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    paddingHorizontal: 14,
    paddingVertical: 4,
    ...shadow.card,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  rowLast: { borderBottomWidth: 0 },
  left: { flex: 1, minWidth: 0 },
  item: { fontSize: 12.5, fontWeight: '600', color: colors.inkSoft },
  vs: { fontFamily: mono, fontSize: 11.5, color: colors.muted, marginTop: 2 },
  a: { color: colors.text, fontWeight: '600' },
  na: { color: colors.muted, fontWeight: '400' },
  b: { color: colors.muted },
  src: { fontFamily: mono, fontSize: 10, color: colors.faint, marginTop: 2 },
  pill: { borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, flexShrink: 0 },
  pillT: { fontFamily: mono, fontSize: 9.5, fontWeight: '700' },
  concl: {
    marginTop: space.s1,
    marginBottom: space.s2,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    padding: space.s2,
  },
  conclT: { fontSize: 12, lineHeight: 18, color: colors.text2 },
});
