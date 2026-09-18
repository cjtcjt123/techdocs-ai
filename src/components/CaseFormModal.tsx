// 案例表单（经验库的写入口）—— 新增与编辑共用一份表单
//
// 设计取舍：
//  ① 一份表单同时承担「成功记录」与「失败记录」，不拆成两个按钮。失败案例同样有价值
//     （失败只是「在当前条件下不成立」），而用户实操完只想点一个地方，多点一次就会少记一半。
//  ② 新增与编辑共用，而不是编辑另写一份：字段完全一样，拆开写迟早分叉，
//     分叉的症状是「编辑后某个字段莫名清空了」—— 且只在编辑路径上出现，很难发现。
//  ③ 文件名从 RecordCaseModal 改成 CaseFormModal：它已经不只负责「记录」了，
//     名字与职责不符是下一个改这份代码的人会踩的坑。
import React, { useEffect, useState } from 'react';
import {
  Modal, View, Text, TextInput, ScrollView, StyleSheet, Pressable, Switch,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { colors, mono, radius, space, verdictColor } from '../theme';
import { useStore } from '../store';
import { CaseInput, CaseOutcome, CaseRecord } from '../types';
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

export default function CaseFormModal({
  visible, prefill, editing, onClose, onSaved,
}: {
  visible: boolean;
  /** 从某轮问答起草（新增时用） */
  prefill?: CasePrefill;
  /** 传了就是编辑这条，否则新建 */
  editing?: CaseRecord | null;
  onClose: () => void;
  onSaved: (title: string) => void;
}) {
  const recordCase = useStore((s) => s.recordCase);
  const updateCase = useStore((s) => s.updateCase);
  const documents = useStore((s) => s.documents);
  const p = prefill || {};

  const [outcome, setOutcome] = useState<CaseOutcome>('success');
  const [finalFix, setFinalFix] = useState('');
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState('');
  const [product, setProduct] = useState('');
  const [environment, setEnvironment] = useState('');
  const [rootCause, setRootCause] = useState('');
  const [notes, setNotes] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [verified, setVerified] = useState(true);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isEdit = !!editing;

  // 每次打开重新填：编辑时用这条案例的现值，新建时用本轮问答起草的内容。
  // 不这么做就会带上上一次的残留 —— 那是「改了 A 案例，结果 B 案例的字段被覆盖」的源头。
  useEffect(() => {
    if (!visible) return;
    if (editing) {
      setOutcome(editing.outcome);
      setFinalFix(editing.finalFix || '');
      setTitle(editing.title || '');
      setProblem(editing.problem || '');
      setProduct(editing.product || '');
      setEnvironment(editing.environment || '');
      setRootCause(editing.rootCause || '');
      setNotes(editing.notes || '');
      setTagsText((editing.tags || []).join(' '));
      setVerified(editing.verified !== false);
      // 有补充内容就直接展开，省得用户以为字段丢了
      setMore(!!(editing.product || editing.environment || editing.rootCause || editing.notes || editing.tags?.length));
    } else {
      setOutcome('success');
      setFinalFix('');
      setTitle(p.title || '');
      setProblem(p.problem || '');
      setProduct('');
      setEnvironment('');
      setRootCause('');
      setNotes('');
      setTagsText('');
      setVerified(true);
      setMore(false);
    }
    setErr(null);
    setBusy(false);
  }, [visible, editing]);

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
      verified,
      aiAdvice: isEdit ? undefined : p.aiAdvice, // undefined = 编辑时保留原值（见 store.updateCase）
      docIds: isEdit ? undefined : (p.docIds?.length ? p.docIds : undefined),
      convId: isEdit ? undefined : p.convId,
      msgId: isEdit ? undefined : p.msgId,
    };
    const bad = validateCaseInput(input);
    if (bad) { setErr(bad); return; }
    setBusy(true);
    const saved = editing ? await updateCase(editing.id, input) : await recordCase(input);
    setBusy(false);
    if (!saved) { setErr('保存失败，请重试'); return; }
    onSaved(saved.title);
    onClose();
  };

  // 关联文档：编辑时库里存的是 docIds，这里把名字查回来显示（读不到就当它已被删）
  const linkedDocNames = isEdit
    ? (editing?.docIds || []).map((id) => documents.find((d) => d.id === id)?.name).filter(Boolean) as string[]
    : (p.docNames || []);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.mask}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.kw}>
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.sheetTitle}>{isEdit ? '编辑案例' : '记录这次怎么解决的'}</Text>
                <Text style={styles.sheetSub}>
                  {isEdit
                    ? '改完立刻生效 —— 下次问类似问题会用到新的内容'
                    : '存进经验库后，下次问类似问题会被优先检索到'}
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

                  {!isEdit && !!p.aiAdvice && (
                    <View style={styles.advice}>
                      <Text style={styles.adviceHead}>当时 AI 的建议（随案例一起存，便于日后回看）</Text>
                      <Text style={styles.adviceText} numberOfLines={4}>{p.aiAdvice}</Text>
                    </View>
                  )}
                  {!!linkedDocNames.length && (
                    <View style={styles.advice}>
                      <Text style={styles.adviceHead}>关联的原始文档</Text>
                      <Text style={styles.adviceText}>{linkedDocNames.join('、')}</Text>
                    </View>
                  )}
                </View>
              )}

              {/* 参与检索的开关：不藏在补充项里，因为它是唯一影响「之后每次回答」的字段 */}
              <View style={styles.toggleRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.toggleLabel}>参与问答检索</Text>
                  <Text style={styles.toggleHint}>
                    {verified
                      ? '下次问类似问题时，这条会被优先检索到。'
                      : '关掉 = 先存着但不用它影响回答（草稿）。记录仍在库里，随时可以再打开。'}
                  </Text>
                </View>
                <Switch value={verified} onValueChange={setVerified} />
              </View>

              {err ? <Text style={styles.err}>{err}</Text> : null}

              <Pressable style={[styles.save, busy && { opacity: 0.6 }]} disabled={busy} onPress={save}>
                <Text style={styles.saveText}>
                  {busy ? '保存中…' : isEdit ? '保存修改' : '保存到经验库'}
                </Text>
              </Pressable>
              <Text style={styles.footNote}>
                门禁：只有「参与问答检索」打开的案例才会进检索池。
                关掉的多半是还没验证过的记录 —— 一条错的记录若戴着「你亲手验证过」的帽子，
                会污染之后的每一次回答。
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
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.s2,
    marginTop: space.s3, paddingTop: space.s2, borderTopWidth: 1, borderTopColor: colors.borderSoft,
  },
  toggleLabel: { fontSize: 13.5, fontWeight: '700', color: colors.text },
  toggleHint: { fontSize: 11, color: colors.muted, marginTop: 3, lineHeight: 16 },
  err: { marginTop: space.s2, fontSize: 12, color: colors.red, fontWeight: '600' },
  save: {
    marginTop: space.s3, backgroundColor: colors.primary, borderRadius: radius.md,
    paddingVertical: 14, alignItems: 'center',
  },
  saveText: { color: '#fff', fontSize: 14.5, fontWeight: '700' },
  footNote: { fontSize: 10.5, color: colors.faint, lineHeight: 15, marginTop: 9, fontFamily: mono },
});
