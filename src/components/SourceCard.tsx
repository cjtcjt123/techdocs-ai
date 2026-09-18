// 来源卡：编号 + 文件名 + 命中路徽章 + 分数 + 页码 + 引文
// 相比旧的 SourceQuote，多出的两样才是关键 —— 「这条是靠什么命中的」和「排第几的分」。
// 关键词没命中、全靠语义兜住的那条会显式标「语义」，用户才知道该不该信。
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, mono, radius, shadow, verdictColor } from '../theme';
import type { Quote } from '../types';

function badgeOf(q: Quote): { label: string; fg: string; bg: string } {
  const from = q.from || [];
  // 案例优先于其它徽章：这一条来自个人经验库、用户亲手验证过 ——
  // 回答里最该被看见的就是「这条不是文档说的，是你自己实测出来的」。
  if (q.kind === 'case') {
    // 但失败记录要单独一档：它同样是「用户实测事实」，含义却相反 ——
    // 不是「照这个做」，而是「这条路你试过，没成」。共用一个「案例」徽章的话，
    // 用户看到 AI 引用它时会以为那是一条被推荐的做法。
    if (q.outcome === 'fail') {
      const c = verdictColor('no');
      return { label: '失败案例', fg: c.fg, bg: c.bg };
    }
    return { label: '案例', fg: '#fff', bg: colors.caseInk };
  }
  if (q.pinned) return { label: '钉住', fg: colors.muted, bg: colors.borderSoft };
  const kw = from.includes('keyword');
  const sem = from.includes('semantic');
  if (kw && sem) return { label: 'KW+SEM', fg: '#fff', bg: colors.kw };
  if (sem) return { label: '语义', fg: colors.sem, bg: colors.semSoft };
  if (kw) return { label: 'KW', fg: colors.kw, bg: colors.kwSoft };
  return { label: '', fg: colors.muted, bg: colors.borderSoft };
}

export default function SourceCard({ quote, index }: { quote: Quote; index: number }) {
  const b = badgeOf(quote);
  // 钉住的条目是「无条件带入」，不是检索命中，分数对它没有意义
  const showScore = !quote.pinned && quote.score != null;
  const meta = [showScore ? q(quote.score as number) : '', quote.pageNo ? `p.${quote.pageNo}` : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.no}>{index + 1}</Text>
        <Text style={styles.fn} numberOfLines={1}>
          {/* 案例名字里自带「案例 · 」前缀（给全局搜索用），这里有徽章了，去掉避免重复 */}
          {quote.kind === 'case' ? (quote.docName || '').replace(/^案例 · /, '') : quote.docName}
        </Text>
        {b.label ? (
          <View style={[styles.bdg, { backgroundColor: b.bg }]}>
            <Text style={[styles.bdgT, { color: b.fg }]}>{b.label}</Text>
          </View>
        ) : null}
        {meta ? <Text style={styles.meta}>{meta}</Text> : null}
      </View>
      {quote.snippet ? (
        <Text style={styles.q} numberOfLines={2}>
          {quote.snippet}
        </Text>
      ) : null}
    </View>
  );
}

function q(n: number) {
  return n.toFixed(2);
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    ...shadow.card,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  no: {
    width: 17,
    height: 17,
    borderRadius: 6,
    backgroundColor: colors.primarySoft,
    color: colors.primary,
    fontFamily: mono,
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 17,
    overflow: 'hidden',
  },
  fn: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: '600', color: colors.text },
  bdg: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 3 },
  bdgT: { fontFamily: mono, fontSize: 9, fontWeight: '700', letterSpacing: 0.3 },
  meta: { fontFamily: mono, fontSize: 10, color: colors.faint },
  q: {
    marginTop: 7,
    paddingLeft: 9,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    fontSize: 11.5,
    lineHeight: 17,
    color: colors.muted,
  },
});
