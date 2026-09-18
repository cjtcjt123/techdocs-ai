import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView, StyleSheet, Pressable, Alert, KeyboardAvoidingView, Platform, Share } from 'react-native';
import { colors, mono, radius, shadow, space } from '../theme';
import Button from '../components/Button';
import SourceCard from '../components/SourceCard';
import ComplianceTable from '../components/ComplianceTable';
import CaseFormModal from '../components/CaseFormModal';
import type { CasePrefill } from '../components/CaseFormModal';
import { useStore } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { Attachment, Message, Conversation, ComplianceResult, Quote } from '../types';
import { complianceToFormat, convToMarkdown, shareText } from '../lib/export';
import { draftFromTurn } from '../lib/cases';

// 空态里的常用问题。写具体型号而不是「查个指标」这类空话 ——
// 点一下真能得到答案，才知道这个输入框该怎么用。
const QUICK = ['CY1578 的适用温度范围', '混合比例与操作时间', '保质期是多久', '和 HY5192 的区别'];

export default function ChatScreen() {
  // useShallow 包一层：只订阅下面列出来的这些字段。
  // 裸用 useStore() 会订阅整个 store —— 于是「我的」页改个设置、资料库扫一次 NAS
  // （nasFiles / nasScanning）都会让这一屏连同它的消息列表一起重渲染，
  // 而切 Tab 时两屏是同时挂着的，这类无谓重渲染在真机上就是掉帧。
  const {
    conversations, currentConvId, newConversation, switchConversation, deleteConversation,
    renameConversation, sendMessage, runCompliance, stopGeneration, thinking, pickAttachments, pickImage,
    lastError, pendingNasAttachment, clearPendingNas, settings, updateRetrieval, documents,
    lastRetrieval, cases, embeddingCount, embeddingTotal,
  } = useStore(
    useShallow((s) => ({
      conversations: s.conversations,
      currentConvId: s.currentConvId,
      newConversation: s.newConversation,
      switchConversation: s.switchConversation,
      deleteConversation: s.deleteConversation,
      renameConversation: s.renameConversation,
      sendMessage: s.sendMessage,
      runCompliance: s.runCompliance,
      stopGeneration: s.stopGeneration,
      thinking: s.thinking,
      pickAttachments: s.pickAttachments,
      pickImage: s.pickImage,
      lastError: s.lastError,
      pendingNasAttachment: s.pendingNasAttachment,
      clearPendingNas: s.clearPendingNas,
      settings: s.settings,
      updateRetrieval: s.updateRetrieval,
      documents: s.documents,
      lastRetrieval: s.lastRetrieval,
      cases: s.cases,
      embeddingCount: s.embeddingCount,
      embeddingTotal: s.embeddingTotal,
    }))
  );
  const [text, setText] = useState('');
  // 输入栏的模式开关：「问一句」= 普通提问，「贴要求核对」= 逐项比对。
  // 后者就是原来那个独立的「对比」Tab —— 两条路本来就是同一段提示词、同一个 system prompt，
  // 只有「结果去哪」不同，摆成两个入口只会让人不知道该点哪个。现在合成一个输入栏、一份会话记录。
  const [mode, setMode] = useState<'chat' | 'compliance'>('chat');
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
  // 「记录解决过程」表单的预填内容（null = 未打开）
  const [recordFor, setRecordFor] = useState<CasePrefill | null>(null);
  const [toast, setToast] = useState('');
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

  const submit = () => {
    // 双保险：store 里也守了一道。这里守的是「手快点了两次」——
    // 两次点击之间 set({thinking:true}) 可能还没回流到这一屏。
    if (thinking) return;
    if (!text.trim() && attachments.length === 0) return;
    const payload = text.trim();
    const att = [...attachments];
    setText(''); setAttachments([]);
    if (mode === 'compliance') void runCompliance(payload, att.length ? att : undefined);
    else void sendMessage(payload, att.length ? att : undefined);
  };

  // 打开「记录解决过程」。预填是纯规则拼装，不调模型：
  // 唯一真正有价值的字段（最终怎么解决的）只能由人填，模型编不出来；
  // 而问题与 AI 建议本来就在手上，直接带上即可 —— 少一次调用、少一段要改的文字。
  const openRecord = (idx: number) => {
    const ai = messages[idx];
    if (!ai) return;
    const prevUser = [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user');
    const q = (prevUser?.content || '').replace(/^【需求符合性检查】/, '');
    const d = draftFromTurn(q, ai.content);
    const docs = (ai.quotes || []).filter((x) => x.kind !== 'case');
    setRecordFor({
      title: d.title,
      problem: d.problem,
      aiAdvice: d.aiAdvice,
      docIds: [...new Set(docs.map((x) => x.docId))],
      docNames: [...new Set(docs.map((x) => x.docName))],
      convId: currentConvId || undefined,
      msgId: ai.id,
    });
  };

  // 保存成功的提示：3 秒后自己消失，不需要用户点确认
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* 标题栏：Tab 页不带系统 header，自己画一个。
          会话切换与「＋新会话」仍留在它下面那一行 —— 两件事各占一行，顶栏不再是塞了三个控件的拥挤横条。 */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>助手</Text>
      </View>
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
                // 按「我的 → 更多设置 → 导出格式」走，不再写死 CSV
                const text = withComp
                  .map((m) => complianceToFormat(m.compliance as ComplianceResult, settings.exportFormat).text)
                  .join('\n\n');
                setExportState({ title: `符合性检查-${convTitle}`, text });
              }}
            >
              <Text style={styles.exportBtnText}>
                ⬇ 导出检查结果（{settings.exportFormat === 'markdown' ? 'Markdown 表' : 'CSV'}）
              </Text>
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
          s={lastRetrieval ?? { total: 0, hits: 0, kw: 0, sem: 0, pinned: 0, cases: 0 }}
        />
      ) : null}

      <ScrollView ref={scrollRef} style={styles.list} contentContainerStyle={styles.listInner}>
        {messages.length === 0 && (
          <View style={styles.welcome}>
            {/* 状态卡从「工作台」整屏搬过来 —— 那一屏取消了，但这三个数字是每次进 App 都想瞟一眼的，
                丢掉可惜。放在空态里恰好：有消息时它自然让位给对话。 */}
            <View style={styles.bento}>
              <View style={styles.bentoCard}>
                <Text style={styles.bentoK}>资料</Text>
                <Text style={styles.bentoV}>{documents.length}<Text style={styles.bentoU}>份</Text></Text>
              </View>
              <View style={styles.bentoCard}>
                <Text style={styles.bentoK}>经验案例</Text>
                <Text style={styles.bentoV}>{cases.length}<Text style={styles.bentoU}>条</Text></Text>
              </View>
              <View style={styles.bentoCard}>
                <Text style={styles.bentoK}>语义索引</Text>
                <Text style={styles.bentoV}>
                  {embeddingCount}
                  <Text style={styles.bentoU}>/{embeddingTotal || 0}</Text>
                </Text>
                <View style={styles.bentoBar}>
                  <View style={[styles.bentoBarI, { width: `${embeddingTotal ? Math.round((embeddingCount / embeddingTotal) * 100) : 0}%` }]} />
                </View>
              </View>
            </View>
            <Text style={styles.welcomeText}>问点什么，或者直接贴一段技术要求。</Text>
            <Text style={styles.welcomeHint}>答案会带上来源页码。要核对规格书，把下面的模式切到「贴要求核对」。</Text>
            <View style={styles.quickRow}>
              {QUICK.map((c) => (
                <Pressable key={c} style={styles.quickChip} onPress={() => setText(c)}>
                  <Text style={styles.quickChipT}>{c}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
        {messages.map((m, i) => (
          <Bubble
            key={m.id}
            m={m}
            // 报错气泡不给记录入口：没解决问题时能记的只有「未解决」，
            // 而失败记录的价值在于「换条件再试」，不是把一次网络错误记成案例
            onRecord={m.role === 'ai' && !m.content.startsWith('⚠️') ? () => openRecord(i) : undefined}
          />
        ))}
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

      {/* 模式条放在输入栏【上方】：它是「这个输入框眼下按哪种方式处理」的开关，贴着输入框才说得通。
          放在下面的话，往上滚着看历史时屏幕里就看不到它了 —— 而「把一段技术要求当普通问题发出去」
          的代价是答非所问，这个错不能靠用户记性来防。 */}
      <View style={styles.modeBar}>
        <View style={styles.seg}>
          <Pressable style={[styles.segItem, mode === 'chat' && styles.segItemOn]} onPress={() => setMode('chat')}>
            <Text style={[styles.segText, mode === 'chat' && styles.segTextOn]}>问一句</Text>
          </Pressable>
          <Pressable style={[styles.segItem, mode === 'compliance' && styles.segItemOn]} onPress={() => setMode('compliance')}>
            <Text style={[styles.segText, mode === 'compliance' && styles.segTextOn]}>贴要求核对</Text>
          </Pressable>
        </View>
        {lastError ? <Text style={styles.errText} numberOfLines={1}>{lastError}</Text> : null}
      </View>

      <View style={[styles.inputBar, mode === 'compliance' && styles.inputBarHot]}>
        <Pressable style={styles.attBtn} onPress={addAttachments}>
          <Text style={{ fontSize: 18 }}>📎</Text>
        </Pressable>
        <Pressable style={styles.attBtn} onPress={addPhoto}>
          <Text style={{ fontSize: 18 }}>🖼️</Text>
        </Pressable>
        <TextInput
          style={styles.input}
          placeholder={mode === 'compliance' ? '贴上技术要求…' : '输入问题，或粘贴报错信息…'}
          placeholderTextColor={mode === 'compliance' ? colors.primary : colors.muted}
          value={text}
          onChangeText={setText}
          multiline
          // 生成中不让改：能打字但发不出去，比直接禁用更让人困惑（会以为 App 卡了）
          editable={!thinking}
        />
        {thinking ? (
          <Pressable style={[styles.send, styles.sendStop]} onPress={stopGeneration}>
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>停止</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.send} onPress={submit}>
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>{mode === 'compliance' ? '核对' : '发送'}</Text>
          </Pressable>
        )}
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
      {/* 记录解决过程：把这一轮变成一张经验卡片 */}
      <CaseFormModal
        visible={!!recordFor}
        prefill={recordFor || {}}
        onClose={() => setRecordFor(null)}
        onSaved={(t) => setToast(`已存入经验库：${t}`)}
      />

      {!!toast && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>📝 {toast}</Text>
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

function Bubble({ m, onRecord }: { m: Message; onRecord?: () => void }) {
  const isUser = m.role === 'user';
  const quotes = m.quotes;
  const caseCount = (quotes || []).filter((q) => q.kind === 'case').length;
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
              {caseCount > 0 ? `（含经验案例 ${caseCount}）` : ''}
              {quotes.some((q) => q.score != null) ? ' · 按融合得分排序' : ''}
            </Text>
            {quotes.map((q, i) => <SourceCard key={i} quote={q} index={i} />)}
          </View>
        )}
        {/* 记录入口挂在回答下方（而不是页面底部）：用户刚照着做完，
            视线就在这条回答上，此时「记下来」的转化率最高 */}
        {!isUser && onRecord ? (
          <Pressable onPress={onRecord} style={styles.recBtn}>
            <Text style={styles.recText}>📝 记录怎么解决的</Text>
            <Text style={styles.recHint}>存进经验库，下次优先命中</Text>
          </Pressable>
        ) : null}
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
        <Text style={styles.stepsN}>
          {s.cases ? `案例 ${s.cases} · ` : ''}
          {dual ? `关键词 ${s.kw} + 语义 ${s.sem}` : `关键词 ${s.kw}`}
        </Text>
      </View>
      <Text style={styles.stepsL2}>
        BM25 命中 {s.kw}
        {dual ? ` · 语义命中 ${s.sem}` : ' · 未配嵌入服务，仅关键词'}
        {s.cases ? ` · 经验库命中 ${s.cases}` : ''}
        {' · RRF 融合排序'}
        {s.pinned ? ` · 钉住 ${s.pinned} 条` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  // 记录入口：用「案例」配色（深底），与正文的浅紫来源卡区分开
  recBtn: {
    marginTop: 9,
    alignSelf: 'flex-start',
    backgroundColor: colors.caseSoft,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  recText: { fontSize: 12, fontWeight: '700', color: colors.caseInk },
  recHint: { fontSize: 10.5, color: colors.muted, marginTop: 2 },
  // 保存成功的轻提示：不需要点确认，3 秒自散
  toast: {
    position: 'absolute',
    left: space.s3,
    right: space.s3,
    bottom: 96,
    backgroundColor: colors.caseInk,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  toastText: { color: '#fff', fontSize: 12.5, fontWeight: '600' },
  header: { paddingHorizontal: space.s3, paddingTop: space.s3, paddingBottom: space.s1, backgroundColor: colors.surface },
  headerTitle: { fontSize: 26, fontWeight: '700', color: colors.text, letterSpacing: -0.8 },
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
  welcome: { paddingVertical: space.s3, alignItems: 'center' },
  welcomeText: { fontSize: 15, color: colors.text, marginBottom: 6 },
  welcomeHint: { fontSize: 12, color: colors.muted, textAlign: 'center', paddingHorizontal: space.s4, lineHeight: 18 },
  // 空态状态卡（原来「工作台」那一屏的三张）：等宽三列，数字用等宽字体，改天数值变化时列宽不跳
  bento: { flexDirection: 'row', gap: 8, alignSelf: 'stretch', marginBottom: space.s4 },
  bentoCard: { flex: 1, minWidth: 0, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingVertical: 11, paddingHorizontal: 12, ...shadow.card },
  bentoK: { fontFamily: mono, fontSize: 9.5, letterSpacing: 0.9, color: colors.muted },
  bentoV: { fontFamily: mono, fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 7 },
  bentoU: { fontSize: 10.5, fontWeight: '600', color: colors.muted },
  bentoBar: { height: 4, borderRadius: 2, backgroundColor: colors.border, marginTop: 8, overflow: 'hidden' },
  bentoBarI: { height: 4, backgroundColor: colors.primary },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, justifyContent: 'center', marginTop: space.s3 },
  quickChip: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 11 },
  quickChipT: { fontSize: 11.5, color: colors.text2 },
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
  // 核对模式下给输入栏描一圈主色边：切了模式而输入框毫无变化的话，人不会意识到模式变了
  inputBarHot: { borderTopColor: colors.primary },
  attBtn: { width: 38, height: 38, borderRadius: 999, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  input: {
    flex: 1, backgroundColor: colors.background, borderRadius: radius.sm, paddingVertical: space.s2 - 3,
    paddingHorizontal: space.s3, fontSize: 14, color: colors.text, maxHeight: 100,
  },
  send: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: space.s2 - 3, paddingHorizontal: space.s3, alignItems: 'center', justifyContent: 'center', height: 38 },
  // 生成中的「停止」：换成中性灰，和紫色的「发送」区分开 —— 一眼能看出这一下不是发送
  sendStop: { backgroundColor: colors.text2 },
  // 模式条：两个分段的开关，紧贴输入框上方
  modeBar: { paddingHorizontal: space.s3, paddingBottom: space.s2, backgroundColor: colors.surface },
  seg: { flexDirection: 'row', backgroundColor: colors.cardAlt, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 3, gap: 3 },
  segItem: { flex: 1, paddingVertical: 8, borderRadius: radius.md - 3, alignItems: 'center' },
  segItemOn: { backgroundColor: colors.card },
  segText: { fontSize: 12.5, fontWeight: '600', color: colors.muted },
  segTextOn: { color: colors.primary },
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
