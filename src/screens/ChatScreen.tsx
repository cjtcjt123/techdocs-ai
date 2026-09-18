import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView, StyleSheet, Pressable, Alert, KeyboardAvoidingView, Platform, Share } from 'react-native';
import { colors, mono, radius, space } from '../theme';
import Button from '../components/Button';
import SourceCard from '../components/SourceCard';
import ComplianceTable from '../components/ComplianceTable';
import { useStore } from '../store';
import { Attachment, Message, Conversation, ComplianceResult, Quote } from '../types';
import { complianceToCsv, convToMarkdown, shareText } from '../lib/export';

export default function ChatScreen() {
  const {
    conversations, currentConvId, newConversation, switchConversation, deleteConversation,
    renameConversation, sendMessage, runCompliance, thinking, pickAttachments, pickImage,
    lastError, pendingNasAttachment, clearPendingNas, settings, updateRetrieval, documents,
    lastRetrieval,
  } = useStore();
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showConvs, setShowConvs] = useState(false);
  // 删除会话的二次确认：点 🗑 先变成「确认删除」，再点才真删（不依赖平台弹窗，web/真机一致）
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  // 会话重命名（就地编辑，不依赖 Alert.prompt —— 那个在 web 上不生效）
  const [editingConv, setEditingConv] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  // 检索范围 / 条数面板
  const [showScope, setShowScope] = useState(false);
  // 导出预览
  const [exportState, setExportState] = useState<{ title: string; text: string } | null>(null);
  const [exportMsg, setExportMsg] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  const retrieval = settings.retrieval ?? { topK: 8, onlyPinned: false, tags: [] };
  const pinnedDocs = documents.filter((d) => d.pinned);
  const tagOptions = (() => {
    const s = new Set<string>();
    documents.forEach((d) => (d.tags || []).forEach((t) => s.add(t)));
    return Array.from(s).sort();
  })();
  const scopeLabel = retrieval.onlyPinned
    ? `仅钉住${pinnedDocs.length ? `（${pinnedDocs.length}）` : '（未钉任何文档）'}`
    : retrieval.tags.length
      ? `标签：${retrieval.tags.join('/')}`
      : '全部资料';

  // NAS 浏览里「带入对话」的文档，出现即并入附件并清空
  useEffect(() => {
    if (pendingNasAttachment) {
      setAttachments((a) => [...a, pendingNasAttachment]);
      clearPendingNas();
    }
  }, [pendingNasAttachment]);

  useEffect(() => {
    if (!currentConvId) newConversation();
  }, []);

  const conv = conversations.find((c) => c.id === currentConvId);
  const messages = conv?.messages || [];
  // 会话标题：取首条用户提问的前 14 字，方便在列表里区分「这轮在聊什么」
  const titleOf = (c?: (typeof conversations)[number]) => {
    if (!c) return '新会话';
    if (c.title) return c.title;
    const q = c.messages.find((m) => m.role === 'user')?.content?.replace(/^【需求符合性检查】/, '') || '';
    return q ? q.slice(0, 14) + (q.length > 14 ? '…' : '') : '新会话';
  };
  const convTitle = titleOf(conv);

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
      <View style={styles.convBar}>
        <Pressable style={styles.convPick} onPress={() => { setShowConvs((v) => !v); setConfirmDel(null); }}>
          <Text style={styles.convTitle} numberOfLines={1}>{convTitle}</Text>
          <Text style={styles.convChev}>{showConvs ? '▴' : '▾'}</Text>
        </Pressable>
        <Pressable style={styles.newBtn} onPress={() => { newConversation(); setShowConvs(false); }}>
          <Text style={styles.newBtnText}>＋ 新会话</Text>
        </Pressable>
      </View>

      {showConvs && (
        <ScrollView style={styles.convList} contentContainerStyle={styles.convListInner}>
          {conversations.length === 0 && <Text style={styles.convEmpty}>还没有历史会话</Text>}
          {conversations.map((c) => {
            const on = c.id === currentConvId;
            if (editingConv === c.id) {
              return (
                <View key={c.id} style={[styles.convItem, on && styles.convItemOn]}>
                  <TextInput
                    value={draftTitle}
                    onChangeText={setDraftTitle}
                    style={styles.convTitleInput}
                    placeholder="输入会话标题（留空则恢复自动标题）"
                    placeholderTextColor={colors.muted}
                    autoFocus
                    autoCorrect={false}
                  />
                  <Pressable hitSlop={8} onPress={() => { void renameConversation(c.id, draftTitle); setEditingConv(null); }}>
                    <Text style={styles.convSave}>保存</Text>
                  </Pressable>
                  <Pressable hitSlop={8} onPress={() => setEditingConv(null)}>
                    <Text style={styles.convDel}>取消</Text>
                  </Pressable>
                </View>
              );
            }
            return (
              <Pressable
                key={c.id}
                style={[styles.convItem, on && styles.convItemOn]}
                onPress={() => { switchConversation(c.id); setShowConvs(false); }}
              >
                <Text style={[styles.convItemText, on && styles.convItemTextOn]} numberOfLines={1}>
                  {titleOf(c)}
                </Text>
                <Text style={styles.convCount}>{c.messages.length} 条</Text>
                <Pressable
                  hitSlop={8}
                  onPress={() => { setEditingConv(c.id); setDraftTitle(c.title || titleOf(c)); setConfirmDel(null); }}
                >
                  <Text style={styles.convDel}>✏️</Text>
                </Pressable>
                {confirmDel === c.id ? (
                  <Pressable hitSlop={8} onPress={() => { void deleteConversation(c.id); setConfirmDel(null); }}>
                    <Text style={styles.convDelYes}>确认删除</Text>
                  </Pressable>
                ) : (
                  <Pressable hitSlop={8} onPress={() => setConfirmDel(c.id)}>
                    <Text style={styles.convDel}>🗑</Text>
                  </Pressable>
                )}
              </Pressable>
            );
          })}
          <View style={styles.exportRow}>
            <Pressable
              style={styles.exportBtn}
              onPress={() => {
                setExportMsg('');
                setExportState({ title: `对话-${convTitle}`, text: convToMarkdown(conv ?? { id: '', messages: [] }, convTitle) });
              }}
            >
              <Text style={styles.exportBtnText}>⬇ 导出本会话（Markdown）</Text>
            </Pressable>
            <Pressable
              style={styles.exportBtn}
              onPress={() => {
                const withComp = messages.filter((m) => m.compliance);
                if (!withComp.length) { setExportMsg('本会话还没有符合性检查结果。'); return; }
                setExportMsg('');
                const csv = withComp.map((m) => complianceToCsv(m.compliance as ComplianceResult)).join('\n\n');
                setExportState({ title: `符合性检查-${convTitle}`, text: csv });
              }}
            >
              <Text style={styles.exportBtnText}>⬇ 导出检查结果（CSV）</Text>
            </Pressable>
          </View>
          {!!exportMsg && <Text style={styles.convEmpty}>{exportMsg}</Text>}
        </ScrollView>
      )}

      {/* 检索范围 / 条数：答不准时第一件事就是调它，所以放在对话页随手可及 */}
      <View style={styles.scopeBar}>
        <Pressable style={styles.scopePick} onPress={() => setShowScope((v) => !v)}>
          <Text style={styles.scopeText} numberOfLines={1}>🔍 {scopeLabel} · {retrieval.topK} 段</Text>
          <Text style={styles.convChev}>{showScope ? '▴' : '▾'}</Text>
        </Pressable>
        {pinnedDocs.length > 0 && (
          <Text style={styles.scopeHint} numberOfLines={1}>⭐ 已钉住 {pinnedDocs.length} 份，问答自动带上</Text>
        )}
      </View>

      {showScope && (
        <View style={styles.scopePanel}>
          <Text style={styles.scopePanelHead}>检索范围</Text>
          <View style={styles.chipRow}>
            <Chip
              label="全部资料"
              on={!retrieval.onlyPinned && retrieval.tags.length === 0}
              onPress={() => updateRetrieval({ onlyPinned: false, tags: [] })}
            />
            <Chip
              label={`仅钉住${pinnedDocs.length ? ` ${pinnedDocs.length}` : ''}`}
              on={retrieval.onlyPinned}
              onPress={() => updateRetrieval({ onlyPinned: true, tags: [] })}
            />
          </View>

          {tagOptions.length > 0 && (
            <>
              <Text style={styles.scopePanelHead}>按标签（可多选）</Text>
              <View style={styles.chipRow}>
                {tagOptions.map((t) => {
                  const on = retrieval.tags.includes(t);
                  return (
                    <Chip
                      key={t}
                      label={t}
                      on={on}
                      onPress={() => {
                        const tags = on ? retrieval.tags.filter((x) => x !== t) : [...retrieval.tags, t];
                        updateRetrieval({ tags, onlyPinned: false });
                      }}
                    />
                  );
                })}
              </View>
            </>
          )}

          <Text style={styles.scopePanelHead}>带几段上下文</Text>
          <View style={styles.chipRow}>
            {[4, 8, 12, 16].map((n) => (
              <Chip key={n} label={`${n} 段`} on={retrieval.topK === n} onPress={() => updateRetrieval({ topK: n })} />
            ))}
          </View>
          <Text style={styles.scopeNote}>
            资料多时调大更好；回答啰嗦或串味就调小。修改即时生效并保存在本机。
          </Text>
        </View>
      )}

      {/* 检索步骤条：答完留在页面上，随时能回看「这次是怎么找到的」 */}
      {messages.length > 0 && (thinking || lastRetrieval) ? (
        <RetrievalSteps
          s={lastRetrieval ?? { total: 0, hits: 0, kw: 0, sem: 0, pinned: 0 }}
        />
      ) : null}

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
      {exportState && (
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle} numberOfLines={1}>⬇ {exportState.title}</Text>
            <ScrollView style={styles.sheetBody}>
              <Text style={styles.sheetText} selectable>{exportState.text}</Text>
            </ScrollView>
            {!!exportMsg && <Text style={styles.scopeNote}>{exportMsg}</Text>}
            <View style={styles.sheetBtns}>
              <Button
                label="关闭"
                variant="ghost"
                onPress={() => { setExportState(null); setExportMsg(''); }}
                style={{ flex: 1 }}
              />
              <Button
                label={Platform.OS === 'web' ? '复制全文' : '分享 / 存文件'}
                onPress={async () => { setExportMsg(await shareText(exportState.title, exportState.text)); }}
                style={{ flex: 1, marginLeft: space.s2 }}
              />
            </View>
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]}>
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{on ? `✓ ${label}` : label}</Text>
    </Pressable>
  );
}

function Bubble({ m }: { m: Message }) {
  const isUser = m.role === 'user';
  const quotes = m.quotes;
  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAi]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAi]}>
        {isUser ? (
          <Text style={{ color: '#fff' }}>{m.content}</Text>
        ) : (
          <InlineText content={m.content} quotes={quotes} />
        )}
        {!isUser && m.compliance && <ComplianceTable result={m.compliance} />}
        {!isUser && quotes && quotes.length > 0 && (
          <View style={{ marginTop: space.s1 }}>
            <Text style={styles.quoteHead}>
              来源 · {quotes.length}
              {quotes.some((q) => q.score != null) ? ' · 按融合得分排序' : ''}
            </Text>
            {quotes.map((q, i) => <SourceCard key={i} quote={q} index={i} />)}
          </View>
        )}
      </View>
    </View>
  );
}

// 答案正文里的 [来源N] 就地渲染成胶囊，直接显示文件名 ——
// 不用滚到底部对编号，读到「100 : 80」时出处就在同一行。
function InlineText({ content, quotes }: { content: string; quotes?: Quote[] }) {
  const raw = String(content || '');
  const parts = raw.split(/(\[来源\s*\d+\])/g);
  if (parts.length === 1) return <Text style={styles.aiText}>{raw}</Text>;
  return (
    <Text style={styles.aiText}>
      {parts.map((p, i) => {
        const m = /^\[来源\s*(\d+)\]$/.exec(p);
        if (!m) return <Text key={i}>{p}</Text>;
        const q = quotes?.[Number(m[1]) - 1];
        return (
          <Text key={i} style={styles.cite}>
            {q ? q.docName.replace(/\.[a-z0-9]+$/i, '') : `来源${m[1]}`}
          </Text>
        );
      })}
    </Text>
  );
}

// 检索步骤条：让「思考中」这段时间有交代 —— 检索了多少块、命中几条、双路各贡献几条
function RetrievalSteps({ s }: { s: NonNullable<ReturnType<typeof useStore.getState>['lastRetrieval']> }) {
  const dual = s.sem > 0;
  return (
    <View style={styles.steps}>
      <View style={styles.stepsL1}>
        <View style={styles.stepsDot} />
        <Text style={styles.stepsT1}>
          已检索 {s.total} 块 · 命中 {s.hits} 处
        </Text>
        <Text style={styles.stepsN}>{dual ? `关键词 ${s.kw} + 语义 ${s.sem}` : `关键词 ${s.kw}`}</Text>
      </View>
      <Text style={styles.stepsL2}>
        BM25 命中 {s.kw}
        {dual ? ` · 语义命中 ${s.sem}` : ' · 未配嵌入服务，仅关键词'}
        {' · RRF 融合排序'}
        {s.pinned ? ` · 钉住 ${s.pinned} 条` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  convBar: { flexDirection: 'row', alignItems: 'center', gap: space.s2, paddingHorizontal: space.s3, paddingVertical: space.s2, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  convPick: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.background, borderRadius: radius.sm, paddingVertical: 7, paddingHorizontal: space.s2 },
  convTitle: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.text },
  convChev: { fontSize: 11, color: colors.muted },
  newBtn: { backgroundColor: colors.primarySoft, borderRadius: radius.sm, paddingVertical: 8, paddingHorizontal: space.s2 },
  newBtnText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  convList: { maxHeight: 240, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  convListInner: { paddingHorizontal: space.s3, paddingBottom: space.s2 },
  convEmpty: { fontSize: 12, color: colors.muted, paddingVertical: space.s2 },
  convItem: { flexDirection: 'row', alignItems: 'center', gap: space.s2, paddingVertical: 9, paddingHorizontal: space.s2, borderRadius: radius.sm, marginTop: 6, backgroundColor: colors.background },
  convItemOn: { backgroundColor: colors.primarySoft },
  convItemText: { flex: 1, fontSize: 13, color: colors.text },
  convItemTextOn: { color: colors.primary, fontWeight: '700' },
  convCount: { fontSize: 11, color: colors.muted },
  convDel: { fontSize: 13, opacity: 0.6 },
  convDelYes: { fontSize: 12, color: colors.red, fontWeight: '700' },
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
  quoteHead: { fontSize: 12, fontWeight: '700', color: colors.text, marginTop: space.s1, marginBottom: 6 },
  // 答案正文 + 内联来源胶囊
  aiText: { fontSize: 14, lineHeight: 22, color: colors.text },
  cite: {
    fontSize: 10.5, fontWeight: '700', color: colors.primary, backgroundColor: colors.primarySoft,
    borderRadius: 7, paddingHorizontal: 5, paddingVertical: 1, overflow: 'hidden',
  },
  // 检索步骤条
  steps: {
    marginHorizontal: space.s2, marginBottom: space.s1, borderRadius: radius.lg,
    backgroundColor: colors.cardAlt, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 13, paddingVertical: 10,
  },
  stepsL1: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepsDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.primary },
  stepsT1: { flex: 1, fontFamily: mono, fontSize: 11.5, color: colors.muted },
  stepsN: { fontFamily: mono, fontSize: 11, color: colors.faint },
  stepsL2: { marginTop: 6, paddingLeft: 15, fontFamily: mono, fontSize: 10.5, lineHeight: 16, color: colors.faint },
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
  // 会话重命名（就地编辑）
  convTitleInput: {
    flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.primary,
    borderRadius: radius.sm, paddingHorizontal: space.s2, paddingVertical: 5,
    fontSize: 13, color: colors.text,
  },
  convSave: { fontSize: 12.5, color: colors.primary, fontWeight: '700' },
  // 导出
  exportRow: { flexDirection: 'row', gap: space.s2, marginTop: space.s2, flexWrap: 'wrap' },
  exportBtn: {
    flex: 1, minWidth: 150, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed',
    borderRadius: radius.sm, paddingVertical: 9, alignItems: 'center', backgroundColor: colors.background,
  },
  exportBtnText: { fontSize: 12.5, color: colors.primary, fontWeight: '600' },
  // 检索范围条
  scopeBar: { flexDirection: 'row', alignItems: 'center', gap: space.s2, paddingHorizontal: space.s3, paddingVertical: 7, backgroundColor: colors.background, borderBottomWidth: 1, borderBottomColor: colors.border },
  scopePick: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingVertical: 5, paddingHorizontal: space.s2, maxWidth: '58%' },
  scopeText: { fontSize: 12.5, color: colors.text, fontWeight: '600', flexShrink: 1 },
  scopeHint: { fontSize: 11.5, color: colors.muted, flex: 1, textAlign: 'right' },
  scopePanel: { backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border, paddingHorizontal: space.s3, paddingBottom: space.s2 },
  scopePanelHead: { fontSize: 11.5, color: colors.muted, fontWeight: '700', marginTop: space.s2, marginBottom: 6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  chipOn: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.muted, fontWeight: '600' },
  chipTextOn: { color: colors.primary },
  scopeNote: { fontSize: 11.5, color: colors.muted, marginTop: space.s2, lineHeight: 17 },
  // 导出预览浮层
  overlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, padding: space.s3, maxHeight: '82%' },
  sheetTitle: { fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: space.s2 },
  sheetBody: { maxHeight: 340, marginBottom: space.s2, backgroundColor: colors.background, borderRadius: radius.sm, padding: space.s2 },
  sheetText: { fontSize: 12, color: colors.text, lineHeight: 18, fontFamily: Platform.OS === 'ios' ? 'Menlo' : undefined },
  sheetBtns: { flexDirection: 'row' },
});
