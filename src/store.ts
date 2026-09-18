// 全局状态：文档导入 / 检索 / 对话 / 合规检查 / 设置 / 锁屏
import { create } from 'zustand';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { secureGet, secureSet } from './lib/secure';
import {
  Document, Conversation, Message, ModelConfig, DataStrategy,
  Attachment, ComplianceResult, NasConnection, RetrievalConfig, SearchResult,
} from './types';
import { listDir, downloadText, type NasEntry } from './lib/nas-webdav';
import {
  initDB, getDocuments, insertDocument, insertChunks, updateDocStatus,
  deleteDocument, renameDocument, kvGet, kvSet,
  setDocumentPinned, setDocumentTags,
  getAllChunksForIndex, putEmbeddings, clearEmbeddings, embeddingStats,
} from './lib/storage';
import { searchAll, invalidateRetrievalIndex } from './lib/retrieval';
import { embedTexts, resetEmbeddingProbe } from './lib/embedding';
import { parseAsset, extToType, chunkText } from './lib/parser';
import type { ParseContext } from './lib/parser';
import { retrieve, buildContext, hitsToQuotes } from './lib/rag';
import type { Hit } from './lib/rag';
import { chat, ChatMsg } from './lib/llm';
import { compliancePrompt, parseCompliance } from './lib/compliance';
import { loadSettings, saveSettings, AppSettings } from './lib/settings';

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// 会话持久化：与文档库共用 kv 存储层（原生 sqlite / web localStorage 均可）。
// 只保留最近 N 个会话，避免聊天记录无限膨胀拖慢启动。
const CONV_KEY = 'conversations';
const CONV_LIMIT = 30;

async function persistConversations(convs: Conversation[]): Promise<void> {
  try {
    await kvSet(CONV_KEY, JSON.stringify(convs.slice(0, CONV_LIMIT)));
  } catch {
    // 持久化失败不应阻断对话主流程
  }
}

// 内存中保存当前解锁密码（本地 App，足够 MVP；安全存储由 secure-store 落盘）
let currentPasscode = '';

// 内部 Message.role 用 'user' | 'ai'，但 OpenAI 兼容接口只认 'assistant'。
// 必须显式转换：用 `as` 断言只改类型、不改运行时值，会直接把 'ai' 发出去导致 400。
function toChatHistory(msgs: Message[]): ChatMsg[] {
  return msgs
    .filter((m) => (m.role === 'user' || m.role === 'ai') && !(m.role === 'ai' && m.content.startsWith('⚠️')))
    .map((m) => ({
      role: (m.role === 'ai' ? 'assistant' : 'user') as 'user' | 'assistant',
      // 只带附件、没有文字的消息，content 会是空串，接口可能拒收，给个占位
      content: m.content && m.content.trim() ? m.content : '（见本条附件）',
    }));
}

// 根据设置解析出「本次问答用哪些资料」
// - onlyPinned：只检索钉住的文档
// - tags 非空：只检索带这些标签的文档
// - 都不设：全部资料
// pinnedDocIds 始终返回，钉住的资料每次问答都会强制带入
function resolveScope(s: { documents: Document[]; settings: AppSettings }) {
  const cfg: RetrievalConfig = s.settings.retrieval ?? { topK: 8, onlyPinned: false, tags: [] };
  const pinnedDocIds = s.documents.filter((d) => d.pinned).map((d) => d.id);
  let docIds: string[] | undefined;
  if (cfg.onlyPinned) {
    docIds = pinnedDocIds;
  } else if (cfg.tags.length) {
    docIds = s.documents
      .filter((d) => (d.tags || []).some((t) => cfg.tags.includes(t)))
      .map((d) => d.id);
  }
  return {
    topK: cfg.topK > 0 ? cfg.topK : 8,
    docIds,
    pinnedDocIds,
    // 没配嵌入服务就是 undefined → rag 只走关键词路（语义路静默缺席）
    embedding: s.settings.embedding,
  };
}

// 一次检索的「交代」：检索了多少块、命中几条、关键词与语义各贡献几条、钉住几条。
// 步骤条要显示的就是它 —— 让「思考中」这段时间有个可解释的过程，而不是一个转圈。
export interface RetrievalStats {
  total: number;
  hits: number;
  kw: number;
  sem: number;
  pinned: number;
}

function summarizeHits(hits: Hit[], total: number): RetrievalStats {
  return {
    total,
    hits: hits.length,
    kw: hits.filter((h) => h.from?.includes('keyword')).length,
    sem: hits.filter((h) => h.from?.includes('semantic')).length,
    pinned: hits.filter((h) => h.pinned).length,
  };
}

// 解析上下文：只有设置里填了解析服务地址才走 NAS 高精度解析，否则纯本地
function parseContext(s: { settings: AppSettings }): ParseContext {
  const ps = s.settings.parseService;
  return ps?.endpoint ? { nasEndpoint: ps.endpoint, nasToken: ps.token } : {};
}

interface State {
  ready: boolean;
  documents: Document[];
  conversations: Conversation[];
  currentConvId: string | null;
  settings: AppSettings;
  nasPassword: string;
  nasFiles: NasEntry[];
  nasCurrent: { name: string; text: string } | null;
  nasScanning: boolean;
  pendingNasAttachment: Attachment | null;
  importing: boolean;
  thinking: boolean;
  lastError: string | null;
  locked: boolean;
  passcodeSet: boolean;
  searchQuery: string;
  searchResults: SearchResult[];
  searching: boolean;
  // 语义索引状态（「我的 → 语义检索」卡片用；没配嵌入服务时 total 仍会算出来）
  embeddingCount: number;
  embeddingTotal: number;
  embeddingBusy: boolean;
  embeddingProgress: string | null;
  // 独立「对比」页的结果（不写进会话，避免污染聊天记录）
  compareResult: ComplianceResult | null;
  compareBusy: boolean;
  compareError: string | null;
  // 最近一次检索的过程数据（问答页顶部的检索步骤条）
  lastRetrieval: RetrievalStats | null;

  init: () => Promise<void>;
  importFiles: () => Promise<void>;
  removeDoc: (id: string) => Promise<void>;
  renameDoc: (id: string, name: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  updateDocTags: (id: string, tags: string[]) => Promise<void>;
  allTags: () => string[];
  runSearch: (q: string) => Promise<void>;
  clearSearch: () => void;
  updateRetrieval: (patch: Partial<RetrievalConfig>) => Promise<void>;
  refreshEmbeddingStats: () => Promise<void>;
  rebuildEmbeddings: () => Promise<void>;
  newConversation: () => void;
  switchConversation: (id: string) => void;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  sendMessage: (text: string, attachments?: Attachment[]) => Promise<void>;
  runCompliance: (text: string, attachments?: Attachment[]) => Promise<void>;
  runCompare: (text: string) => Promise<void>;
  clearCompare: () => void;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  saveNas: (conn: NasConnection, password: string) => Promise<void>;
  syncFromNas: () => Promise<void>;
  browseNas: () => Promise<void>;
  openNasDoc: (entry: NasEntry) => Promise<void>;
  attachNasToChat: () => void;
  clearPendingNas: () => void;
  closeNasDoc: () => void;
  pickAttachments: () => Promise<Attachment[]>;
  pickImage: () => Promise<Attachment[]>;
  setPasscode: (code: string) => Promise<void>;
  unlock: (code: string) => boolean;
  lock: () => void;
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  documents: [],
  conversations: [],
  currentConvId: null,
  settings: {
    modelConfig: { source: 'api', provider: 'openai', baseURL: '', apiKey: '', model: 'gpt-4o-mini' },
    dataStrategy: 'local',
    privacy: { faceID: false, offlineMode: false, cloudConfirm: false },
    exportFormat: 'markdown',
    retrieval: { topK: 8, onlyPinned: false, tags: [] },
  },
  nasPassword: '',
  nasFiles: [],
  nasCurrent: null,
  nasScanning: false,
  pendingNasAttachment: null,
  importing: false,
  thinking: false,
  lastError: null,
  locked: false,
  passcodeSet: false,
  searchQuery: '',
  searchResults: [],
  searching: false,
  embeddingCount: 0,
  embeddingTotal: 0,
  embeddingBusy: false,
  embeddingProgress: null,
  compareResult: null,
  compareBusy: false,
  compareError: null,
  lastRetrieval: null,

  async init() {
    await initDB();
    const [docs, settings, pc, nasPw, convRaw] = await Promise.all([
      getDocuments(),
      loadSettings(),
      secureGet('app_passcode'),
      secureGet('nas_password'),
      kvGet(CONV_KEY),
    ]);
    currentPasscode = pc || '';
    // 恢复上次的会话列表（首次启动或旧版本无此键时为空数组）
    let convs: Conversation[] = [];
    try {
      const parsed = convRaw ? JSON.parse(convRaw) : null;
      if (Array.isArray(parsed)) {
        convs = parsed.filter((c: any) => c && typeof c.id === 'string' && Array.isArray(c.messages));
      }
    } catch {
      convs = [];
    }
    set({
      ready: true,
      documents: docs,
      conversations: convs,
      currentConvId: convs[0]?.id ?? null,
      settings,
      nasPassword: nasPw || '',
      passcodeSet: !!pc,
      locked: !!pc, // 若已设密码，则启动即锁
    });
    void get().refreshEmbeddingStats();
  },

  async importFiles() {
    set({ importing: true, lastError: null });
    try {
      const res = await DocumentPicker.getDocumentAsync({
        multiple: true, type: '*/*', copyToCacheDirectory: true,
      });
      if (res.canceled) { set({ importing: false }); return; }
      const ctx = parseContext(get());
      const failed: string[] = [];
      for (const a of res.assets) {
        const type = extToType(a.name);
        // 先解析再入库：meta 一次写全，省掉一次补更新
        const out = await parseAsset(a, ctx);
        const doc: Document = {
          id: uid(), name: a.name, type, folderId: null, tags: [],
          status: out.text ? 'indexed' : 'partial',
          meta: {
            size: a.size,
            parseSource: out.source,
            parseQuality: Number(out.quality.toFixed(2)),
            pages: out.pages,
            chars: out.text?.length ?? 0,
            note: out.note,
          },
          createdAt: new Date().toISOString(),
        };
        await insertDocument(doc);
        if (out.text) {
          const chunks = chunkText(out.text).map((c) => ({ ...c, docId: doc.id }));
          await insertChunks(chunks);
        } else {
          failed.push(`${a.name}：${out.note || '未能提取到文本'}`);
        }
      }
      set({
        documents: await getDocuments(),
        importing: false,
        lastError: failed.length ? `以下文件未索引到内容\n${failed.join('\n')}` : null,
      });
    } catch (e: any) {
      set({ importing: false, lastError: e?.message || '导入失败' });
    }
  },

  async removeDoc(id) {
    await deleteDocument(id);
    set({ documents: await getDocuments() });
  },

  async renameDoc(id, name) {
    await renameDocument(id, name);
    set({ documents: await getDocuments() });
  },

  // 钉住 / 取消钉住 —— 钉住的文档每次问答都会自动带入上下文，不用每次手动加附件
  async togglePin(id) {
    const doc = get().documents.find((d) => d.id === id);
    if (!doc) return;
    await setDocumentPinned(id, !doc.pinned);
    set({ documents: await getDocuments() });
  },

  // 覆盖式设置标签（去重、去空）
  async updateDocTags(id, tags) {
    const clean = Array.from(new Set(tags.map((t) => t.trim()).filter(Boolean)));
    await setDocumentTags(id, clean);
    set({ documents: await getDocuments() });
  },

  // 资料库已有标签全集（分组筛选用）
  allTags() {
    const s = new Set<string>();
    get().documents.forEach((d) => (d.tags || []).forEach((t) => s.add(t)));
    return Array.from(s).sort();
  },

  // 全局搜索：不经过模型，直接看命中的原文片段
  async runSearch(q) {
    set({ searchQuery: q });
    if (!q.trim()) { set({ searchResults: [], searching: false }); return; }
    set({ searching: true });
    try {
      const res = await searchAll(q, 30);
      set({ searchResults: res, searching: false });
    } catch (e: any) {
      set({ searching: false, lastError: e?.message || '搜索失败' });
    }
  },

  clearSearch() {
    set({ searchQuery: '', searchResults: [], searching: false });
  },

  // 检索范围与条数（问答页可直接调，答不准时第一件事就是调它）
  async updateRetrieval(patch) {
    const next: AppSettings = {
      ...get().settings,
      retrieval: { ...get().settings.retrieval, ...patch },
    };
    set({ settings: next });
    await saveSettings(next);
  },

  // 语义索引状态：已建向量数 / 待建总数（「我的 → 语义检索」卡片用）
  async refreshEmbeddingStats() {
    try {
      const [stat, chunks] = await Promise.all([embeddingStats(), getAllChunksForIndex()]);
      set({ embeddingCount: stat.count, embeddingTotal: chunks.length });
    } catch {
      /* 统计失败不该影响主流程 */
    }
  },

  // 重建语义索引：全库 chunk 分批送嵌入服务 → 落库 → 作废检索缓存
  // 之所以是「全量重算」而不是增量：换了嵌入模型后旧向量的维度和语义都变了，
  // 混用会得到无意义的结果，整库重算才安全。向量是派生数据，重算成本只是时间。
  async rebuildEmbeddings() {
    const cfg = get().settings.embedding;
    if (!cfg?.endpoint) {
      set({ lastError: '还没配置嵌入服务：请先在「我的 → 语义检索」里填写地址。' });
      return;
    }
    if (get().embeddingBusy) return;

    set({ embeddingBusy: true, embeddingProgress: null, lastError: null });
    try {
      const chunks = await getAllChunksForIndex();
      if (!chunks.length) {
        set({ embeddingBusy: false, lastError: '资料库里还没有可索引的正文（先导入并解析文档）。' });
        return;
      }

      await clearEmbeddings();
      invalidateRetrievalIndex();
      resetEmbeddingProbe(); // 换了地址/模型，重新探测服务形状

      const BATCH = 32;
      let done = 0;
      for (let i = 0; i < chunks.length; i += BATCH) {
        const slice = chunks.slice(i, i + BATCH);
        // embedTexts 会跳过空白文本，所以这里先滤掉，保证 rows 与 vectors 严格一一对应
        const usable = slice.filter((c) => (c.content || '').trim().length > 0);
        if (!usable.length) {
          done += slice.length;
          set({ embeddingProgress: `${done}/${chunks.length}` });
          continue;
        }
        const out = await embedTexts(
          usable.map((c) => c.content),
          { ...cfg, batchSize: BATCH }
        );
        if (!out || out.vectors.length !== usable.length) {
          throw new Error(`嵌入服务返回条数不符（要 ${usable.length} 条，回 ${out?.vectors.length ?? 0} 条）`);
        }
        await putEmbeddings(
          usable.map((c) => ({ chunkId: c.id, docId: c.docId })),
          out.vectors,
          out.model
        );
        done += slice.length;
        set({ embeddingProgress: `${done}/${chunks.length}` });
      }

      invalidateRetrievalIndex(); // 让新的向量立刻生效
      set({ embeddingBusy: false, embeddingProgress: null, embeddingCount: done, embeddingTotal: chunks.length });
    } catch (e: any) {
      invalidateRetrievalIndex();
      set({
        embeddingBusy: false,
        embeddingProgress: null,
        lastError: `语义索引失败：${e?.message || e}`,
      });
    }
  },

  newConversation() {
    const conv: Conversation = { id: uid(), messages: [] };
    const next = [conv, ...get().conversations];
    set({ conversations: next, currentConvId: conv.id });
    void persistConversations(next);
  },

  switchConversation(id) {
    if (!get().conversations.some((c) => c.id === id)) return;
    set({ currentConvId: id });
  },

  // 删除会话（UI 侧有二次确认）。若删的是当前会话，自动切到最新一个；全删光则留空由界面新建。
  async deleteConversation(id) {
    const next = get().conversations.filter((c) => c.id !== id);
    const cur = get().currentConvId;
    set({
      conversations: next,
      currentConvId: cur === id ? (next[0]?.id ?? null) : cur,
    });
    await persistConversations(next);
  },

  // 会话重命名（标题留空则回退到「按首句自动截取」）
  async renameConversation(id, title) {
    const t = (title || '').trim();
    const next = get().conversations.map((c) => (c.id === id ? { ...c, title: t || undefined } : c));
    set({ conversations: next });
    await persistConversations(next);
  },

  async sendMessage(text, attachments) {
    let convId = get().currentConvId;
    if (!convId) { get().newConversation(); convId = get().currentConvId!; }
    const conv = get().conversations.find((c) => c.id === convId)!;
    const userMsg: Message = { id: uid(), role: 'user', content: text, attachments };
    const updated = { ...conv, messages: [...conv.messages, userMsg] };
    set({ conversations: get().conversations.map((c) => (c.id === convId ? updated : c)), thinking: true, lastError: null });

    try {
      const hits = await retrieve(text || '', resolveScope(get()));
      set({ lastRetrieval: summarizeHits(hits, get().embeddingTotal) });
      const ctx = buildContext(hits);
      const attText = (attachments || []).filter((a) => a.text).length
        ? '【本次附件文本】\n' + (attachments || []).filter((a) => a.text).map((a) => `《${a.name}》\n${a.text}`).join('\n\n')
        : '';
      const sys = `你是「京美AI助手」，只基于下方【可引用资料】与【本次附件】回答，每条结论尽量标注来源（如"见[来源1]"）。
若资料中没有明确答案，必须说明"资料未提供"，严禁编造数据或参数。`;
      const fullContext = `${sys}\n\n【可引用资料】\n${ctx}\n\n${attText}`;
      const history = toChatHistory(updated.messages);
      const messages: ChatMsg[] = [
        { role: 'system', content: fullContext },
        ...history.slice(0, -1), // 去掉刚加的 user（已放最后）
        { role: 'user', content: text && text.trim() ? text : '（见本次附件）' },
      ];
      const aiText = await chat(get().settings.modelConfig, messages);
      const aiMsg: Message = { id: uid(), role: 'ai', content: aiText, quotes: hitsToQuotes(hits) };
      const conv2 = get().conversations.find((c) => c.id === convId)!;
      set({
        conversations: get().conversations.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, aiMsg] } : c)),
        thinking: false,
      });
      void persistConversations(get().conversations);
    } catch (e: any) {
      const errMsg: Message = { id: uid(), role: 'ai', content: `⚠️ ${e?.message || '请求失败'}`, quotes: [] };
      set({
        conversations: get().conversations.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, errMsg] } : c)),
        thinking: false, lastError: e?.message || '请求失败',
      });
      void persistConversations(get().conversations);
    }
  },

  async runCompliance(text, attachments) {
    let convId = get().currentConvId;
    if (!convId) { get().newConversation(); convId = get().currentConvId!; }
    const conv = get().conversations.find((c) => c.id === convId)!;
    const userMsg: Message = { id: uid(), role: 'user', content: `【需求符合性检查】${text}`, attachments };
    set({ conversations: get().conversations.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, userMsg] } : c)), thinking: true, lastError: null });

    try {
      const hits = await retrieve(text || '', resolveScope(get()));
      set({ lastRetrieval: summarizeHits(hits, get().embeddingTotal) });
      const ctx = buildContext(hits);
      const attText = (attachments || []).filter((a) => a.text).length
        ? '【用户附件】\n' + (attachments || []).filter((a) => a.text).map((a) => `《${a.name}》\n${a.text}`).join('\n\n')
        : '';
      const prompt = compliancePrompt(text + (attText ? '\n\n' + attText : ''), ctx);
      const raw = await chat(get().settings.modelConfig, [
        { role: 'system', content: '你是树脂材料选型工程师，只输出合规检查结果 JSON。' },
        { role: 'user', content: prompt },
      ]);
      const result: ComplianceResult | null = parseCompliance(raw);
      const aiMsg: Message = result
        ? { id: uid(), role: 'ai', content: `已对要求逐项比对（详见合规卡片）。\n\n${result.conclusion}`, compliance: result }
        : { id: uid(), role: 'ai', content: `未能解析合规结果，原始返回：\n${raw}` };
      set({
        conversations: get().conversations.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, aiMsg] } : c)),
        thinking: false,
      });
      void persistConversations(get().conversations);
    } catch (e: any) {
      const errMsg: Message = { id: uid(), role: 'ai', content: `⚠️ ${e?.message || '合规检查失败'}`, quotes: [] };
      set({
        conversations: get().conversations.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, errMsg] } : c)),
        thinking: false, lastError: e?.message || '合规检查失败',
      });
      void persistConversations(get().conversations);
    }
  },

  // 独立「对比」页比对：与 runCompliance 的区别是结果只进 compareResult，不写进任何会话。
  // 对比页是一个常驻 Tab，把每次比对都塞成一条聊天记录会把会话列表冲垮。
  async runCompare(text) {
    const t = (text || '').trim();
    if (!t) return;
    set({ compareBusy: true, compareError: null, compareResult: null });
    try {
      // 比对要的上下文比问答多：逐项核数值，少带一段就会漏判
      const scope = resolveScope(get());
      const hits = await retrieve(t, { ...scope, topK: Math.max(scope.topK, 12) });
      set({ lastRetrieval: summarizeHits(hits, get().embeddingTotal) });
      const ctx = buildContext(hits);
      const prompt = compliancePrompt(t, ctx);
      const raw = await chat(get().settings.modelConfig, [
        { role: 'system', content: '你是树脂材料选型工程师，只输出合规检查结果 JSON。' },
        { role: 'user', content: prompt },
      ]);
      const result = parseCompliance(raw);
      if (!result) {
        set({ compareBusy: false, compareError: '模型没有返回可解析的 JSON。可在「我的」里换成结构化输出更稳的模型再试。' });
        return;
      }
      set({ compareBusy: false, compareResult: result });
    } catch (e: any) {
      set({ compareBusy: false, compareError: e?.message || '比对失败' });
    }
  },

  clearCompare() {
    set({ compareResult: null, compareError: null });
  },

  async updateSettings(patch) {
    const next: AppSettings = { ...get().settings, ...patch };
    set({ settings: next });
    await saveSettings(next);
  },

  // 保存 NAS 连接（密码单独落 secure 层）
  async saveNas(conn, password) {
    await secureSet('nas_password', password);
    const next: AppSettings = { ...get().settings, nas: conn };
    set({ settings: next, nasPassword: password });
    await saveSettings(next);
  },

  // 本地+NAS同步：把 NAS 上的文本类资料拉到手机建本地索引（离线可搜）
  async syncFromNas() {
    const conn = get().settings.nas;
    if (!conn) { set({ lastError: '尚未配置 NAS 连接，请先到「我的 → NAS 连接」填写。' }); return; }
    if (conn.protocol === 'smb') { set({ lastError: 'SMB 尚未接入，请先在「我的 → NAS 连接」选用 WebDAV。' }); return; }
    const pw = get().nasPassword;
    set({ importing: true, lastError: null });
    try {
      const entries = await listDir(conn, pw);
      const files = entries.filter((e) => !e.isDir);
      let added = 0;
      for (const f of files) {
        try {
          const text = await downloadText(conn, pw, f.href);
          if (!text) continue;
          const type = extToType(f.name);
          const doc: Document = {
            id: uid(), name: f.name, type, folderId: null, tags: ['NAS'],
            status: 'indexing', meta: { size: f.size, source: 'nas' }, createdAt: new Date().toISOString(),
          };
          await insertDocument(doc);
          const chunks = chunkText(text).map((c) => ({ ...c, docId: doc.id }));
          await insertChunks(chunks);
          await updateDocStatus(doc.id, 'indexed');
          added++;
        } catch {
          // 单个文件失败不影响其他
        }
      }
      set({ documents: await getDocuments(), importing: false, lastError: added ? null : 'NAS 上未找到可索引的文本文档（仅支持 TXT/MD 拉取，PDF/Word 暂跳过）。' });
    } catch (e: any) {
      set({ importing: false, lastError: e?.message || 'NAS 同步失败' });
    }
  },

  // 纯NAS后端：浏览 NAS 文件列表（不落本地）
  async browseNas() {
    const conn = get().settings.nas;
    if (!conn) { set({ lastError: '尚未配置 NAS 连接。' }); return; }
    if (conn.protocol === 'smb') { set({ lastError: 'SMB 尚未接入，请先在「我的 → NAS 连接」选用 WebDAV。' }); return; }
    set({ nasScanning: true, lastError: null });
    try {
      const entries = await listDir(conn, get().nasPassword);
      set({ nasFiles: entries, nasScanning: false });
    } catch (e: any) {
      set({ nasScanning: false, lastError: e?.message || '浏览 NAS 失败' });
    }
  },

  // 纯NAS后端：打开某个 NAS 文件（下载文本用于查看 / 带入对话）
  async openNasDoc(entry) {
    const conn = get().settings.nas;
    if (!conn) return;
    set({ nasScanning: true, lastError: null });
    try {
      const text = await downloadText(conn, get().nasPassword, entry.href);
      set({ nasCurrent: { name: entry.name, text }, nasScanning: false });
    } catch (e: any) {
      set({ nasScanning: false, lastError: e?.message || '打开失败' });
    }
  },

  // 把当前打开的 NAS 文档作为附件，带入下一次对话
  attachNasToChat() {
    const cur = get().nasCurrent;
    if (!cur) return;
    set({
      pendingNasAttachment: { name: cur.name, text: cur.text, type: 'text/plain' },
      nasCurrent: null,
    });
  },

  clearPendingNas() {
    set({ pendingNasAttachment: null });
  },

  closeNasDoc() {
    set({ nasCurrent: null });
  },

  async pickAttachments() {
    const res = await DocumentPicker.getDocumentAsync({ multiple: true, type: '*/*', copyToCacheDirectory: true });
    if (res.canceled) return [];
    const out: Attachment[] = [];
    const ctx = parseContext(get());
    for (const a of res.assets) {
      const isImage = (a.mimeType || '').startsWith('image/');
      let text: string | undefined;
      if (!isImage) text = (await parseAsset(a, ctx)).text || undefined;
      out.push({ name: a.name, uri: a.uri, text, type: a.mimeType || (isImage ? 'image' : 'file') });
    }
    return out;
  },

  // 从系统相册选照片（🖼️ 按钮）
  async pickImage() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      throw new Error('未获得相册权限。请到 iPhone「设置 → 隐私与安全性 → 照片」中允许本 App 访问相册。');
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 5,
      quality: 0.8,
    });
    if (res.canceled) return [];
    return res.assets.map((a) => ({
      name: a.fileName || `照片_${Date.now()}.jpg`,
      uri: a.uri,
      type: a.mimeType || 'image/jpeg',
    } as Attachment));
  },

  async setPasscode(code) {
    currentPasscode = code;
    await secureSet('app_passcode', code);
    set({ passcodeSet: true, locked: false });
  },

  unlock(code) {
    const ok = !!currentPasscode && code === currentPasscode;
    if (ok) set({ locked: false });
    return ok;
  },

  lock() { set({ locked: true }); },
}));
