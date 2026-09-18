// 经验库列表（方案 P1：经验库可管理）
//
// P0 只做到「记录 + 回灌」，结果是用户记了之后看不到、改不了、删不了 ——
// 这次补的正是这一段：列表 / 筛选 / 详情 / 编辑 / 删除 / 导出 / 参与检索开关。
import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput } from 'react-native';
import Button from './Button';
import CaseFormModal from './CaseFormModal';
import { colors, mono, radius, shadow, space, verdictColor } from '../theme';
import { useStore } from '../store';
import { CaseOutcome, CaseRecord } from '../types';
import {
  OUTCOMES, OUTCOME_LABEL, OUTCOME_VERDICT, filterCases, casesToMarkdown,
} from '../lib/cases';
import { shareText } from '../lib/export';

type Filter = 'all' | CaseOutcome | 'unverified';

const FILTERS: Array<{ k: Filter; label: string }> = [
  { k: 'all', label: '全部' },
  ...OUTCOMES.map((o) => ({ k: o as Filter, label: OUTCOME_LABEL[o] })),
  // 「待确认」= 未参与检索的那些。它不是按结果分的一类，而是按「能不能用」分的一类，
  // 所以放在最后单列 —— 用户最需要一眼看到的就是「有哪些我还没确认过」。
  { k: 'unverified', label: '未参与检索' },
];

const dayOf = (c: CaseRecord) => (c.occurredAt || c.createdAt || '').slice(0, 10);

export default function CaseList() {
  const cases = useStore((s) => s.cases);
  const removeCase = useStore((s) => s.removeCase);
  const setCaseVerified = useStore((s) => s.setCaseVerified);

  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<CaseRecord | null>(null);
  const [formFor, setFormFor] = useState<{ editing?: CaseRecord } | null>(null);
  const [confirmDel, setConfirmDel] = useState<CaseRecord | null>(null);
  const [msg, setMsg] = useState('');

  const visible = useMemo(() => filterCases(cases, {
    outcome: filter === 'unverified' ? 'all' : filter,
    onlyUnverified: filter === 'unverified',
    q,
  }), [cases, filter, q]);

  const verifiedCount = cases.filter((c) => c.verified).length;

  const exportMd = async () => {
    if (!visible.length) { setMsg('当前筛选下没有案例可导出。'); return; }
    const md = casesToMarkdown(visible);
    // 只导出当前筛选结果：用户筛完再导出，意图就是「要这几条」
    setMsg(await shareText(`经验库-${visible.length}条`, md));
  };

  return (
    <View style={styles.wrap}>
      {/* 概览 + 新建/导出 */}
      <View style={styles.bar}>
        <Text style={styles.stat}>
          共 {cases.length} 条 · 参与检索 {verifiedCount}
          {cases.length > verifiedCount ? ` · 未参与 ${cases.length - verifiedCount}` : ''}
        </Text>
        <View style={styles.barBtns}>
          <Pressable style={styles.chipBtn} onPress={() => setFormFor({})}>
            <Text style={styles.chipBtnText}>＋ 新建</Text>
          </Pressable>
          <Pressable style={styles.chipBtn} onPress={exportMd}>
            <Text style={styles.chipBtnText}>导出</Text>
          </Pressable>
        </View>
      </View>

      {cases.length > 0 && (
        <>
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="搜案例（标题 / 现象 / 根因 / 解决 / 标签）"
            placeholderTextColor={colors.muted}
            style={styles.search}
            autoCorrect={false}
          />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsRow} contentContainerStyle={styles.chipsInner}>
            {FILTERS.map((f) => {
              const n = f.k === 'all' ? cases.length
                : f.k === 'unverified' ? cases.length - verifiedCount
                : cases.filter((c) => c.outcome === f.k).length;
              return (
                <Pressable
                  key={f.k}
                  onPress={() => setFilter(f.k)}
                  style={[styles.chip, filter === f.k && styles.chipOn]}
                >
                  <Text style={[styles.chipText, filter === f.k && styles.chipTextOn]}>
                    {f.label}{n ? ` ${n}` : ''}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </>
      )}

      <ScrollView style={styles.list} contentContainerStyle={styles.listInner}>
        {cases.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>经验库还是空的。</Text>
            <Text style={styles.emptyHint}>
              去「问答」页问一次问题，回答下方有「记录这次怎么解决的」——
              把实操结果记下来，之后问类似问题时会优先命中你的经验。
            </Text>
          </View>
        )}

        {cases.length > 0 && visible.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyHint}>当前筛选下没有案例。换个条件，或点「全部」。</Text>
          </View>
        )}

        {visible.map((c) => {
          const vc = verdictColor(OUTCOME_VERDICT[c.outcome]);
          return (
            <Pressable
              key={c.id}
              onPress={() => { setMsg(''); setDetail(c); }}
              style={({ pressed }) => [styles.card, pressed && { opacity: 0.75 }]}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={styles.titleRow}>
                  <Text style={styles.name} numberOfLines={2}>{c.title || '（未命名案例）'}</Text>
                </View>
                <Text style={styles.meta} numberOfLines={1}>
                  {[c.product, c.environment, dayOf(c)].filter(Boolean).join(' · ')}
                </Text>
                {!!c.tags?.length && (
                  <Text style={styles.tags} numberOfLines={1}>{c.tags.join(' · ')}</Text>
                )}
              </View>
              <View style={{ alignItems: 'flex-end', gap: 5 }}>
                <View style={[styles.badge, { backgroundColor: vc.bg }]}>
                  <Text style={[styles.badgeText, { color: vc.fg }]}>{OUTCOME_LABEL[c.outcome]}</Text>
                </View>
                {!c.verified && (
                  <View style={styles.offBadge}>
                    <Text style={styles.offBadgeText}>未参与检索</Text>
                  </View>
                )}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

      {!!msg && (
        <Pressable style={styles.msgBar} onPress={() => setMsg('')}>
          <Text style={styles.msgText} numberOfLines={3}>{msg}</Text>
        </Pressable>
      )}

      {/* ---------- 案例详情 ---------- */}
      {detail && (
        <View style={styles.overlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setDetail(null)} />
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle} numberOfLines={2}>{detail.title || '（未命名案例）'}</Text>
              <Pressable hitSlop={10} onPress={() => setDetail(null)}>
                <Text style={styles.close}>✕</Text>
              </Pressable>
            </View>
            <ScrollView style={styles.sheetBody}>
              <DetailRow label="结果" value={OUTCOME_LABEL[detail.outcome]} />
              {detail.product ? <DetailRow label="产品 / 型号" value={detail.product} /> : null}
              {detail.environment ? <DetailRow label="环境" value={detail.environment} /> : null}
              {detail.problem ? <DetailRow label="问题 / 现象" value={detail.problem} /> : null}
              {detail.rootCause ? <DetailRow label="根因" value={detail.rootCause} /> : null}
              <DetailRow label="最终解决" value={detail.finalFix} />
              {detail.notes ? <DetailRow label="注意" value={detail.notes} /> : null}
              {detail.tags?.length ? <DetailRow label="标签" value={detail.tags.join('、')} /> : null}
              <DetailRow label="记录时间" value={dayOf(detail)} />
              {detail.aiAdvice ? <DetailRow label="当时的 AI 建议" value={detail.aiAdvice} /> : null}
            </ScrollView>

            <Pressable
              style={styles.toggleRow}
              onPress={() => {
                const next = !detail.verified;
                void setCaseVerified(detail.id, next);
                setDetail({ ...detail, verified: next });
              }}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.toggleLabel}>
                  {detail.verified ? '✓ 参与问答检索' : '未参与问答检索'}
                </Text>
                <Text style={styles.toggleHint}>
                  {detail.verified ? '点一下可临时停用（记录仍留着）' : '点一下重新启用'}
                </Text>
              </View>
              <Text style={styles.toggleAction}>{detail.verified ? '停用' : '启用'}</Text>
            </Pressable>

            <View style={styles.sheetBtns}>
              <Button
                label="编辑"
                variant="soft"
                onPress={() => { const t = detail; setDetail(null); setFormFor({ editing: t }); }}
                style={{ flex: 1 }}
              />
              <Button
                label="删除"
                variant="danger"
                onPress={() => { const t = detail; setDetail(null); setConfirmDel(t); }}
                style={{ flex: 1, marginLeft: space.s2 }}
              />
            </View>
          </View>
        </View>
      )}

      {/* ---------- 删除确认 ---------- */}
      {confirmDel && (
        <View style={styles.overlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setConfirmDel(null)} />
          <View style={[styles.sheet, { maxHeight: '60%' }]}>
            <Text style={styles.sheetTitle}>删除这条案例？</Text>
            <Text style={styles.delName} numberOfLines={3}>{confirmDel.title || '（未命名案例）'}</Text>
            <Text style={styles.warnText}>
              案例是全 App 最不可再生的数据：文档丢了能重新导入，经验丢了只能重新踩一遍坑。
              确认删除后无法撤销。
            </Text>
            <View style={styles.sheetBtns}>
              <Button label="取消" variant="ghost" onPress={() => setConfirmDel(null)} style={{ flex: 1 }} />
              <Button
                label="确认删除"
                variant="danger"
                onPress={() => { const id = confirmDel.id; setConfirmDel(null); void removeCase(id); setMsg('已从经验库删除。'); }}
                style={{ flex: 1, marginLeft: space.s2 }}
              />
            </View>
          </View>
        </View>
      )}

      {/* 新增 / 编辑共用同一份表单 */}
      <CaseFormModal
        visible={!!formFor}
        editing={formFor?.editing || null}
        onClose={() => setFormFor(null)}
        onSaved={(t) => setMsg(formFor?.editing ? `已保存修改：${t}` : `已存入经验库：${t}`)}
      />
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingBottom: space.s2, gap: space.s2,
  },
  stat: { flex: 1, minWidth: 0, fontFamily: mono, fontSize: 10.5, color: colors.muted },
  barBtns: { flexDirection: 'row', gap: 8 },
  chipBtn: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  chipBtnText: { fontSize: 12.5, fontWeight: '600', color: colors.primary },
  search: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    paddingHorizontal: space.s3, paddingVertical: 10,
    fontSize: 13, color: colors.text, marginBottom: space.s2, ...shadow.card,
  },
  chipsRow: { marginBottom: space.s2, flexGrow: 0 },
  chipsInner: { flexDirection: 'row', gap: 8, paddingRight: space.s3 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  chipText: { fontSize: 12.5, color: colors.muted, fontWeight: '600' },
  chipTextOn: { color: colors.primary },

  list: { flex: 1 },
  listInner: { paddingBottom: space.s2 },
  empty: { paddingVertical: space.s4, alignItems: 'center' },
  emptyText: { fontSize: 14, color: colors.text, marginBottom: 6 },
  emptyHint: { fontSize: 12, color: colors.muted, textAlign: 'center', paddingHorizontal: space.s3, lineHeight: 19 },

  card: {
    backgroundColor: colors.card, borderRadius: radius.xl,
    paddingHorizontal: space.s2 + 2, paddingVertical: space.s2, marginBottom: space.s1 + 2,
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    borderWidth: 1, borderColor: 'transparent',
    ...shadow.card,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: '600', color: colors.text, lineHeight: 18 },
  meta: { fontFamily: mono, fontSize: 9.5, color: colors.faint, marginTop: 3 },
  tags: { fontSize: 10.5, color: colors.muted, marginTop: 3 },
  badge: { borderRadius: 9, paddingVertical: 5, paddingHorizontal: 9 },
  badgeText: { fontFamily: mono, fontSize: 10, fontWeight: '700' },
  offBadge: {
    borderRadius: 9, paddingVertical: 3, paddingHorizontal: 7,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background,
  },
  offBadgeText: { fontFamily: mono, fontSize: 9, color: colors.muted, fontWeight: '600' },

  msgBar: {
    backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border,
    paddingHorizontal: space.s3, paddingVertical: 10,
  },
  msgText: { fontSize: 11.5, color: colors.text2, lineHeight: 16 },

  overlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md,
    padding: space.s3, maxHeight: '85%',
  },
  sheetHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.s2, marginBottom: space.s2 },
  sheetTitle: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '700', color: colors.text },
  close: { fontSize: 15, color: colors.muted, paddingHorizontal: 4 },
  sheetBody: { maxHeight: 320 },
  detailRow: { marginBottom: space.s2 },
  detailLabel: { fontFamily: mono, fontSize: 10, letterSpacing: 0.8, color: colors.muted, marginBottom: 3 },
  detailValue: { fontSize: 13, color: colors.text, lineHeight: 19 },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.s2,
    borderTopWidth: 1, borderTopColor: colors.borderSoft, paddingTop: space.s2, marginTop: space.s1,
  },
  toggleLabel: { fontSize: 13, fontWeight: '700', color: colors.text },
  toggleHint: { fontSize: 10.5, color: colors.muted, marginTop: 2 },
  toggleAction: { fontSize: 12.5, fontWeight: '600', color: colors.primary },
  sheetBtns: { flexDirection: 'row', marginTop: space.s2 },
  delName: { fontSize: 13.5, color: colors.text, lineHeight: 19, marginBottom: space.s2 },
  warnText: { fontSize: 12, color: colors.red, lineHeight: 18, marginBottom: space.s2 },
});
