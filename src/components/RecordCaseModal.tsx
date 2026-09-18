// 记录解决过程（经验库入口）—— 问答页底部弹出的记录表单
//
// 设计取舍：一份表单同时承担「成功记录」与「失败记录」，不拆成两个按钮。
// 因为失败案例同样有价值（失败只是「在当前条件下不成立」的假设），
// 而用户实操完只想点一个地方，多点一次就会少记一半。
import React, { useEffect, useState } from 'react';
import {
  Modal, View, Text, TextInput, ScrollView, StyleSheet, Pressable,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { colors, mono, radius, space, verdictColor } from '../theme';
import { useStore } from '../store';
import { CaseInput, CaseOutcome } from '../types';
import {
  OUTCOMES, OUTCOME_LABEL, OUTCOME_VERDICT, parseTags, validateCaseInput,
} from '../lib/cases';

export interface CasePrefill {
  title?: string;
  problem?: string;
  aiAdvice?: string;
  docIds?: string[];
  docNames?: string[];
  convId?: string;
  msgId?: string;
}

export default function RecordCaseModal({
  visible, prefill, onClose, onSaved,
}: {
  visible: boolean;
  prefill: CasePrefill;
  onClose: () => void;
  onSaved: (title: string) => void;
}) {
  const recordCase = useStore((s) => s.recordCase);

  const [outcome, setOutcome] = useState<CaseOutcome>('success');
  const [finalFix, setFinalFix] = useState('');
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState('');
  const [product, setProduct] = useState('');
  const [environment, setEnvironment] = useState('');
  const [rootCause, setRootCause] = useState('');
  const [notes, setNotes] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 每次打开都从这一轮问答重新起草，避免带上上一次的残留
  useEffect(() => {
    if (!visible) return;
    setOutcome('success');
    setFinalFix('');
    setTitle(prefill.title || '');
    setProblem(prefill.problem || '');
    setProduct('');
    setEnvironment('');
    setRootCause('');
    setNotes('');
    setTagsText('');
    setMore(false);
    setErr(null);
    setBusy(false);
  }, [visible]);

  const save = async () => {
    const input: CaseInput = {
      title: title.trim() || problem.trim().slice(0, 30) || '（未命名案例）',
      problem: problem.trim() || undefined,
      product: product.trim() || undefined,
      environment: environment.trim() || undefined,
      rootCause: rootCause.trim() || undefined,
      finalFix: finalFix.trim(),
      outcome,
      notes: notes.trim() || undefined,
      tags: parseTags(tagsText),
      aiAdvice: prefill.aiAdvice,
      docIds: prefill.docIds?.length ? prefill.docIds : undefined,
      convId: prefill.convId,
      msgId: prefill.msgId,
    };
    const bad = validateCaseInput(input);
    if (bad) { setErr(bad); return; }
    setBusy(true);
    const saved = await recordCase(input);
    setBusy(false);
    if (!saved) { setErr('保存失败，请重试'); return; }
    onSaved(saved.title);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.mask}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.kw}>
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.sheetTitle}>记录这次怎么解决的</Text>
                <Text style={styles.sheetSub}>
                  存进经验库后，下次问类似问题会被优先检索到
                </Text>
              </View>
              <Pressable hitSlop={10} onPress={onClose}>
                <Text style={styles.close}>✕</Text>
              </Pressable>
            </View>

            <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 6 }} keyboardShouldPersistTaps="handled">
              {/* 第一步先问结果：这是唯一决定「这条经验能不能信」的字段 */}
              <Text style={styles.label}>结果</Text>
              <View style={styles.outcomeRow}>
                {OUTCOMES.map((o) => {
                  const on = outcome === o;
                  const c = verdictColor(OUTCOME_VERDICT[o]);
                  return (
                    <Pressable
                      key={o}
                      onPress={() => setOutcome(o)}
                      style={[styles.outcome, { borderColor: on ? c.fg : colors.border, backgroundColor: on ? c.bg : colors.card }]}
                    >
                      <Text style={[styles.outcomeText, { color: on ? c.fg : colors.text2 }]}>
                        {OUTCOME_LABEL[o]}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.note}>
                选「失败」也有用：失败案例会被记为「在当时的条件下不成立」，换条件再试才有对照。
              </Text>

              <Text style={styles.label}>
                最终怎么解决的 <Text style={styles.req}>必填</Text>
              </Text>
              <TextInput
                style={[styles.input, styles.inputMulti]}
                value={finalFix}
                onChangeText={(v) => { setFinalFix(v); if (err) setErr(null); }}
                placeholder="例如：升温至 60℃ 抽真空 30 min，静置 5 min 后再浇注，气泡消除"
                placeholderTextColor={colors.faint}
                multiline
                textAlignVertical="top"
              />

              <Text style={styles.label}>问题 / 现象</Text>
              <TextInput
                style={styles.input}
                value={title}
                onChangeText={setTitle}
                placeholder="一句话，例如：CY1578 混合料出现气泡"
                placeholderTextColor={colors.faint}
              />

              <Pressable onPress={() => setMore((v) => !v)} style={styles.moreBtn}>
                <Text style={styles.moreText}>{more ? '▾ 收起补充项' : '▸ 补充项（型号 / 根因 / 注意 / 标签）'}</Text>
              </Pressable>

              {more && (
                <View>
                  <Text style={styles.label}>产品 / 型号</Text>
                  <TextInput style={styles.input} value={product} onChangeText={setProduct}
                    placeholder="例如：Araldite CY1578 / HY1578" placeholderTextColor={colors.faint} />

                  <Text style={styles.label}>环境 / 设备 / 版本</Text>
                  <TextInput style={styles.input} value={environment} onChangeText={setEnvironment}
                    placeholder="例如：25℃ 常温 / 真空搅拌机 A / 固件 1.2" placeholderTextColor={colors.faint} />

                  <Text style={styles.label}>根因</Text>
                  <TextInput style={styles.input} value={rootCause} onChangeText={setRootCause}
                    placeholder="最后发现的原因" placeholderTextColor={colors.faint} />

                  <Text style={styles.label}>注意事项 / 适用范围</Text>
                  <TextInput style={[styles.input, styles.inputMulti]} value={notes} onChangeText={setNotes}
                    placeholder="坑、限制条件、什么情况下不适用" placeholderTextColor={colors.faint}
                    multiline textAlignVertical="top" />

                  <Text style={styles.label}>标签</Text>
                  <TextInput style={styles.input} value={tagsText} onChangeText={setTagsText}
                    placeholder="空格或逗号分隔，例如：气泡 工艺 CY1578" placeholderTextColor={colors.faint} />

                  {!!prefill.aiAdvice && (
                    <View style={styles.advice}>
                      <Text style={styles.adviceHead}>当时 AI 的建议（随案例一起存，便于日后回看）</Text>
                      <Text style={styles.adviceText} numberOfLines={4}>{prefill.aiAdvice}</Text>
                    </View>
                  )}
                  {!!prefill.docNames?.length && (
                    <View style={styles.advice}>
                      <Text style={styles.adviceHead}>关联的原始文档</Text>
                      <Text style={styles.adviceText}>{prefill.docNames.join('、')}</Text>
                    </View>
                  )}
                </View>
              )}

              {err ? <Text style={styles.err}>{err}</Text> : null}

              <Pressable style={[styles.save, busy && { opacity: 0.6 }]} disabled={busy} onPress={save}>
                <Text style={styles.saveText}>{busy ? '保存中…' : '保存到经验库'}</Text>
              </Pressable>
              <Text style={styles.footNote}>
                只有「解决了」的案例才会参与问答检索；草稿永远不进检索池 ——
                否则一条错的记录会戴着「你亲手验证过」的帽子污染之后的每一次回答。
              </Text>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  mask: { flex: 1, backgroundColor: 'rgba(18,20,26,0.42)', justifyContent: 'flex-end' },
  kw: { width: '100%' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    maxHeight: '88%',
    paddingBottom: Platform.OS === 'ios' ? 20 : 10,
  },
  sheetHead: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.s2,
    paddingHorizontal: space.s3, paddingTop: space.s3, paddingBottom: space.s2,
    borderBottomWidth: 1, borderBottomColor: colors.borderSoft,
  },
  sheetTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  sheetSub: { fontSize: 11.5, color: colors.muted, marginTop: 3 },
  close: { fontSize: 16, color: colors.muted, paddingHorizontal: 4 },
  body: { paddingHorizontal: space.s3 },
  label: { fontSize: 12.5, fontWeight: '700', color: colors.inkSoft, marginTop: space.s2, marginBottom: 6 },
  req: { color: colors.red, fontSize: 11 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm,
    paddingHorizontal: 11, paddingVertical: 9, fontSize: 13.5, color: colors.text,
    backgroundColor: colors.card,
  },
  inputMulti: { minHeight: 84 },
  outcomeRow: { flexDirection: 'row', gap: 8 },
  outcome: { flex: 1, borderWidth: 1.5, borderRadius: radius.sm, paddingVertical: 11, alignItems: 'center' },
  outcomeText: { fontSize: 13, fontWeight: '700' },
  note: { fontSize: 11, color: colors.muted, marginTop: 7, lineHeight: 16 },
  moreBtn: { marginTop: space.s2, paddingVertical: 4 },
  moreText: { fontSize: 12.5, fontWeight: '600', color: colors.primary },
  advice: {
    marginTop: space.s2, backgroundColor: colors.cardAlt, borderRadius: radius.sm,
    paddingHorizontal: 11, paddingVertical: 9,
  },
  adviceHead: { fontSize: 11, fontWeight: '700', color: colors.muted, marginBottom: 4 },
  adviceText: { fontSize: 12, color: colors.text2, lineHeight: 18 },
  err: { marginTop: space.s2, fontSize: 12, color: colors.red, fontWeight: '600' },
  save: {
    marginTop: space.s3, backgroundColor: colors.primary, borderRadius: radius.md,
    paddingVertical: 14, alignItems: 'center',
  },
  saveText: { color: '#fff', fontSize: 14.5, fontWeight: '700' },
  footNote: { fontSize: 10.5, color: colors.faint, lineHeight: 15, marginTop: 9, fontFamily: mono },
});
