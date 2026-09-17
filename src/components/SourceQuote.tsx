import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { colors, radius, space } from '../theme';
import { Quote } from '../types';

// 来源引用卡：文档名 + 页码 + 原文片段（点击可跳转，MVP 暂提示）
export default function SourceQuote({ quote, onPress }: { quote: Quote; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}>
      <Text style={styles.head}>📎 来源：{quote.docName}{quote.pageNo ? ` · 第${quote.pageNo}页` : ''}</Text>
      <Text style={styles.snip} numberOfLines={3}>{quote.snippet}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.background, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border,
    padding: space.s2, marginTop: space.s2,
  },
  head: { fontSize: 12, fontWeight: '600', color: colors.primary, marginBottom: 4 },
  snip: { fontSize: 12, color: colors.muted, lineHeight: 18 },
});
