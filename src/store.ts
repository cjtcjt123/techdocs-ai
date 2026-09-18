// 全局状态：文档导入 / 检索 / 对话 / 合规检查 / 设置 / 锁屏
import { create } from 'zustand';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { secureGet, secureSet } from './lib/secure';
import {
  Document, Conversation, Message, ModelConfig, DataStrategy,
  Attachment, ComplianceResult, NasConnection, RetrievalConfig, SearchResult,
  CaseRecord, CaseInput,
} from './types';
import { listDir, downloadText, type NasEntry } from './lib/nas-webdav';
import {
  initDB, getDocuments, insertDocument, insertChunks, updateDocStatus,
  deleteDocument, renameDocument, kvGet, kvSet,
  setDocumentPinned, setDocumentTags,
  getAllChunksForIndex, putEmbeddings, clearEmbeddings, embeddingStats,
  listCases, saveCase as saveCaseRow, deleteCase as deleteCaseRow,
} from './lib/storage';
import { searchAll, invalidateRetrievalIndex } from './lib/retrieval';
import { sortCases, validateCaseInput } from './lib/cases';
import { embedTexts, resetEmbeddingProbe } from './lib/embedding';
import { parseAsset, extToType, chunkText } from './lib/parser';
import type { ParseContext } from './lib/parser';
import { retrieve, buildContext, hitsToQuotes } from './lib/rag';
import type { Hit } from './lib/rag';
import { chat, ChatMsg } from './lib/llm';
import { stopLocalChat } from './lib/local-llm';
import { compliancePrompt, parseCompliance } from './lib/compliance';
import { loadSettings, saveSettings, AppSettings } from './lib/settings';
import { setPrivacySwitches, setConfirmHook } from './lib/net-guard';

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

// ---------------------------------------------------------------- 生成控制（可中断 + 超时）
//
// 为什么要有这一层：以前 chat() 一发出去就没有回头路 —— 网络挂起（NAS 关机、手机连上
// 没出口的 Wi-Fi）时界面会**永久停在「思考中」**，用户只能杀 App 重开；本地模型同理，
// 一个 3B 模型在旧手机上跑几百 token 要几十秒，中途想改问法只能干等。
//
// 两个标志分开记，因为【用户主动停止】和【超时】要给人看的话完全不同：
//   · 主动停止 —— 不是故障，说「已停止」
//   · 超时     —— 是失败，要说清可能是网络或模型那边的问题
let genCtl: AbortController | null = null;
let genStopped = false;
let genTimedOut = false;

/** 生成的默认上限。正常回答几秒到几十秒，超过 120 秒基本就是网络或服务端出问题了 */
const GEN_TIMEOUT_MS = 120_000;

/**
 * 正文指纹，只用来判重（导入 / NAS 同步时「这份是不是已经在库里了」）。
 *
 * 刻意**取样**而不是全量哈希：几 MB 的 PDF 正文逐字符跑一遍没必要，
 * 而「头 60k + 尾 60k + 总长度」这三个数要撞，得是两份几乎一样的资料 —— 那正是该判重的。
 * 结尾带上长度，是为了让「同样开头但长短不同」的两份不会误判成同一份。
 */
function contentHash(text: string): string {
  const sample = text.length <= 120_000 ? text : text.slice(0, 60_000) + text.slice(-60_000);
  let h = 5381;
  for (let i = 0; i < sample.length; i++) h = ((h << 5) + h + sample.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}-${text.length}`;
}

/** 标签清洗（去空、去重、trim）。单条与批量两条路共用，避免一边清洗一边不清洗 */
function cleanTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((t) => t.trim()).filter(Boolean)));
}

/**
 * 开一次可中断的生成。返回的 `done()` **必须**在 finally 里调，否则定时器会泄漏。
 * ⚠️ 没用 `AbortSignal.timeout()`：那是比较新的 API，Hermes 不保证有，手写更稳。
 */
function beginGeneration(timeoutMs = GEN_TIMEOUT_MS) {
  const ac = new AbortController();
  genStopped = false;
  genTimedOut = false;
  genCtl = ac;
  const timer = setTimeout(() => {
    genTimedOut = true;
    ac.abort();
  }, timeoutMs);
  return {
    signal: ac.signal,
    done: () => {
      clearTimeout(timer);
      if (genCtl === ac) genCtl = null;
    },
  };
}

// 「云端调用需确认」弹窗的挂起回调。放在模块级而不是 state 里：
// 它是个函数、不参与渲染，放进 state 只会让每次 set 都触发一次无意义的重渲染。
let confirmResolver: ((ok: boolean) => void) | null = null;

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

// 一次检索的「交代」：检索了多少块、命中几条、关键词/语义/案例各贡献几条、钉住几条。
// 步骤条要显示的就是它 —— 让「思考中」这段时间有个可解释的过程，而不是一个转圈。
export interface RetrievalStats {
  total: number;
  hits: number;
  kw: number;
  sem: number;
  pinned: number;
  cases: number; // 命中几条「个人经验库」案例（要不要信这条回答，这一格很关键）
}

function summarizeHits(hits: Hit[], total: number): RetrievalStats {
  return {
    total,
    hits: hits.length,
    kw: hits.filter((h) => h.from?.includes('keyword')).length,
    sem: hits.filter((h) => h.from?.includes('semantic')).length,
    pinned: hits.filter((h) => h.pinned).length,
    cases: hits.filter((h) => h.kind === 'case').length,
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
  // 最近一次检索的过程数据（问答页顶部的检索步骤条）
  lastRetrieval: RetrievalStats | null;
  // 个人经验库：案例卡片（含未验证的草稿 —— 列表要显示全部，而检索只吃 verified）
  cases: CaseRecord[];
  loadCases: () => Promise<void>;
  recordCase: (input: CaseInput) => Promise<CaseRecord | null>;
  /** 编辑已有案例（保留 id / createdAt / 来源会话） */
  updateCase: (id: string, input: CaseInput) => Promise<CaseRecord | null>;
  /** 切换「是否参与问答检索」。关掉后案例仍留在库里，只是不会被召回 */
  setCaseVerified: (id: string, verified: boolean) => Promise<void>;
  removeCase: (id: string) => Promise<void>;

  // 「云端调用需确认」：有待确认的调用时存放待发内容的说明，界面据此弹窗
  pendingConfirm: { what: string } | null;
  answerConfirm: (ok: boolean) => void;

  init: () => Promise<void>;
  importFiles: () => Promise<void>;
  removeDoc: (id: string) => Promise<void>;
  renameDoc: (id: string, name: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  updateDocTags: (id: string, tags: string[]) => Promise<void>;
  // 批量版：写 N 条只刷新一次（见实现处的注释）
  batchRemoveDocs: (ids: string[]) => Promise<void>;
  batchTogglePin: (ids: string[], pinned: boolean) => Promise<void>;
  batchAddTags: (ids: string[], tags: string[]) => Promise<void>;
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
  stopGeneration: () => void;
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
  /** 面容 / 指纹通过后解锁。⚠️ 调用方必须已经拿到 biometricAuth() === true ——
   *  store 这边无从验证，所以它是「信任调用方」的接口，只该被锁屏调用。 */
  unlockByBiometric: () => void;
  lock: () => void;
}

/**
 * 把表单输入变成一条完整案例。
 * base 存在 = 编辑（保留 id / createdAt / 溯源字段）；不存在 = 新建。
 */
function materializeCase(input: CaseInput, base?: CaseRecord): CaseRecord {
  return {
    id: base?.id ?? uid(),
    title: (input.title || input.problem || '').trim().slice(0, 80) || base?.title || '（未命名案例）',
    problem: input.problem?.trim() || undefined,
    product: input.product?.trim() || undefined,
    environment: input.environment?.trim() || undefined,
    docIds: input.docIds?.length ? input.docIds : undefined,
    aiAdvice: input.aiAdvice || undefined,
    rootCause: input.rootCause?.trim() || undefined,
    finalFix: input.finalFix.trim(),
    outcome: input.outcome,
    notes: input.notes?.trim() || undefined,
    tags: input.tags?.length ? input.tags : [],
    // 用户亲手填了「最终怎么解决的」→ 默认可信。
    // verified=false 留给两类情形：将来「由 AI 起草、待确认」的路径，
    // 以及用户主动把某条标成「先别参与检索」（记录留着，但不影响回答）。
    verified: input.verified ?? base?.verified ?? true,
    occurredAt: input.occurredAt ?? base?.occurredAt,
    // 编辑时不能把 createdAt 刷成现在 —— 提示词会让模型引用「根据你 08-12 的记录」，
    // 改了它就等于篡改了记录日期。
    createdAt: base?.createdAt ?? new Date().toISOString(),
    convId: input.convId ?? base?.convId,
    msgId: input.msgId ?? base?.msgId,
  };
}

/**
 * 案例落库 + 刷新列表 + 作废检索缓存。三个写入口（新增 / 编辑 / 切 verified）共用，
 * 所以不会有哪条路径漏掉作废。
 *
 * 为什么必须显式作废：检索索引按「块数:总字数」做指纹缓存，它覆盖得了新增与删除，
 * 覆盖不了等长改写（30min → 40min 时指纹一模一样）—— 不显式作废就会出现
 * 「改完了再问，命中的还是旧内容」。
 */
async function commitCase(
  set: (patch: Partial<State>) => void,
  get: () => State,
  rec: CaseRecord
): Promise<CaseRecord | null> {
  try {
    await saveCaseRow(rec);
    set({ cases: sortCases([rec, ...get().cases.filter((c) => c.id !== rec.id)]) });
    invalidateRetrievalIndex();
    return rec;
  } catch (e: any) {
    set({ lastError: e?.message || '案例保存失败' });
    return null;
  }
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  documents: [],
  conversations: [],
  currentConvId: null,
  settings: {
    modelConfig: { source: 'api', provider: 'openai', baseURL: '', apiKey: '', model: 'gpt-4o-mini' },
    dataStrategy: 'local',
    privacy: { lock: false, biometric: true, offlineMode: false, cloudConfirm: false },
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
  lastRetrieval: null,
  cases: [],
  pendingConfirm: null,

  async init() {
    // 把两个隐私开关推给网络层守卫。
    // 必须在任何请求可能发生【之前】挂好 —— 否则「启动后第一次问答」会绕过确认弹窗，
    // 而这类漏网只在特定启动顺序下出现，极难复现。
    setConfirmHook((what) => new Promise<boolean>((resolve) => {
      confirmResolver = resolve;
      set({ pendingConfirm: { what } });
    }));
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
    setPrivacySwitches(settings.privacy);
    set({
      ready: true,
      documents: docs,
      conversations: convs,
      currentConvId: convs[0]?.id ?? null,
      settings,
      nasPassword: nasPw || '',
      passcodeSet: !!pc,
      // 「启动时锁定」这个开关就是在这里生效的：设了密码 + 开关开着，才启动即锁。
      // 以前写的是 `!!pc`（只看有没有密码），等于开关关着也照样锁 —— 开关形同虚设。
      // 而「立即锁定」是用户明确的动作，走 lock() 无条件置 true，不受这个开关约束。
      locked: !!pc && !!settings.privacy.lock,
    });
    void get().refreshEmbeddingStats();
    void get().loadCases();
  },

  // ---- 个人经验库 ----
  async loadCases() {
    try {
      set({ cases: sortCases(await listCases()) });
    } catch (e: any) {
      set({ lastError: e?.message || '经验库读取失败' });
    }
  },

  /**
   * 记一条新案例。经验库的写入口之一（另一个是 updateCase / setCaseVerified）。
   * 三者共用下面的 commitCase，所以「刷新列表 + 作废检索缓存」不会被漏掉 ——
   * 漏掉的症状是「刚改完又问一遍，案例还是旧的」，且看起来像检索写错了。
   */
  async recordCase(input) {
    const bad = validateCaseInput(input);
    if (bad) { set({ lastError: bad }); return null; }
    return commitCase(set, get, materializeCase(input));
  },

  /**
   * 编辑已有案例。
   *
   * 保留 id / createdAt / convId / msgId：这些是「这条记录从哪来」的溯源信息，
   * 表单里没有、也不该让用户去改。createdAt 尤其不能跟着编辑时间走 ——
   * 提示词里会让模型引用「根据你 08-12 的记录」，改了时间就等于篡改了记录日期。
   */
  async updateCase(id, input) {
    const base = get().cases.find((c) => c.id === id);
    if (!base) { set({ lastError: '这条案例已不存在（可能已被删除）' }); return null; }
    const bad = validateCaseInput(input);
    if (bad) { set({ lastError: bad }); return null; }
    const next = materializeCase(input, base);
    // 表单没动的字段（aiAdvice / docIds）沿用原值，避免一编辑就把当初的上下文弄丢
    next.aiAdvice = input.aiAdvice !== undefined ? input.aiAdvice : base.aiAdvice;
    next.docIds = input.docIds !== undefined ? input.docIds : base.docIds;
    return commitCase(set, get, next);
  },

  /** 单独切换「是否参与检索」——列表里一键操作，不必走完整表单 */
  async setCaseVerified(id, verified) {
    const base = get().cases.find((c) => c.id === id);
    if (!base) return;
    await commitCase(set, get, { ...base, verified });
  },

  // 以前这是唯一没有 try/catch 的写操作 —— 删失败会变成未捕获的 rejection，
  // 界面上什么都不发生，用户只会以为「这个删除键坏了」。
  async removeCase(id) {
    try {
      await deleteCaseRow(id);
      set({ cases: get().cases.filter((c) => c.id !== id) });
      invalidateRetrievalIndex();
    } catch (e: any) {
      set({ lastError: e?.message || '删除案例失败' });
    }
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
      let skipped = 0;
      // 已入库的正文指纹。动态往里加 —— 本次选中的几份里如果彼此相同，也该只留一份。
      // 没解析出文本的不参与判重（它本来也进不了索引，留着是让用户看见「这份没解析成功」）。
      const seen = new Set(get().documents.map((d) => d.meta?.hash).filter(Boolean) as string[]);
      for (const a of res.assets) {
        const type = extToType(a.name);
        // 先解析再入库：meta 一次写全，省掉一次补更新
        const out = await parseAsset(a, ctx);
        const hash = out.text ? contentHash(out.text) : '';
        if (hash && seen.has(hash)) { skipped++; continue; }
        if (hash) seen.add(hash);
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
            hash: hash || undefined,
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
      // 「跳过 N 份」不是错误，但界面上没有别的提示位，借 lastError 这条通道告诉用户结果 ——
      // 不说的话，用户会以为导入失败了自己却不知道少了几份。
      const notes: string[] = [];
      if (skipped) notes.push(`已跳过 ${skipped} 份：库里已经有内容完全相同的资料了`);
      if (failed.length) notes.push(`以下文件未索引到内容\n${failed.join('\n')}`);
      set({
        documents: await getDocuments(),
        importing: false,
        lastError: notes.length ? notes.join('\n\n') : null,
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
    await setDocumentTags(id, cleanTags(tags));
    set({ documents: await getDocuments() });
  },

  // ---- 批量操作：写 N 条，只刷新一次 ----
  //
  // 以前界面层是循环调单条 action，而每条 action 内部都 `set({ documents: await getDocuments() })`
  // —— 删 20 份 = 20 次全表 SELECT + 20 次全量 setState（每次都让整个资料库列表重渲染一遍）。
  // 这里改成「循环写 → 最后刷新一次」，单条 action 的行为保持不变（它们还有各自的调用点）。
  // 异常也必须兜住：以前界面是 try/finally 没有 catch，中途一抛错就是未捕获 rejection，
  // 而且 busy 状态虽然 finally 会复位，但用户看不到任何失败提示。
  async batchRemoveDocs(ids) {
    if (!ids.length) return;
    try {
      for (const id of ids) await deleteDocument(id);
      set({ documents: await getDocuments() });
    } catch (e: any) {
      // 可能只删掉了一部分 —— 刷新一次把真实结果摆出来，别让用户以为全成了
      set({ documents: await getDocuments(), lastError: e?.message || '批量删除失败（可能只删掉一部分）' });
    }
  },

  async batchTogglePin(ids, pinned) {
    if (!ids.length) return;
    try {
      for (const id of ids) await setDocumentPinned(id, pinned);
      set({ documents: await getDocuments() });
    } catch (e: any) {
      set({ documents: await getDocuments(), lastError: e?.message || '批量操作失败（可能只改了一部分）' });
    }
  },

  /** 追加式批量加标签：各文档原有标签保留 */
  async batchAddTags(ids, tags) {
    if (!ids.length) return;
    const add = cleanTags(tags);
    if (!add.length) return;
    try {
      for (const id of ids) {
        const doc = get().documents.find((d) => d.id === id);
        await setDocumentTags(id, Array.from(new Set([...(doc?.tags || []), ...add])));
      }
      set({ documents: await getDocuments() });
    } catch (e: any) {
      set({ documents: await getDocuments(), lastError: e?.message || '批量加标签失败（可能只加了一部分）' });
    }
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
    // 生成中拒绝新提问：连发两条的话，两个回答按返回先后追加，
    // 先问的那个可能反而排在后面 —— 界面上看到的就是「答非所问」。
    if (get().thinking) return;
    let convId = get().currentConvId;
    if (!convId) { get().newConversation(); convId = get().currentConvId!; }
    const conv = get().conversations.find((c) => c.id === convId)!;
    const userMsg: Message = { id: uid(), role: 'user', content: text, attachments };
    const updated = { ...conv, messages: [...conv.messages, userMsg] };
    set({ conversations: get().conversations.map((c) => (c.id === convId ? updated : c)), thinking: true, lastError: null });

    const gen = beginGeneration();
    try {
      const hits = await retrieve(text || '', resolveScope(get()));
      set({ lastRetrieval: summarizeHits(hits, get().embeddingTotal) });
      const ctx = buildContext(hits);
      const attText = (attachments || []).filter((a) => a.text).length
        ? '【本次附件文本】\n' + (attachments || []).filter((a) => a.text).map((a) => `《${a.name}》\n${a.text}`).join('\n\n')
        : '';
      // ⚠️ 这段提示词与 cases.ts 的 CASE_HEADER / CASE_SOURCE_LABEL 是【一对】：
      //    那边决定文本长什么样，这边决定模型怎么用。改一侧必须看另一侧 —— 否则会出现
      //    「上下文里明明标着『此路不通』，提示词却只说『以案例为准』」这种自相矛盾的指令。
      const sys = `你是「京美AI助手」，只基于下方【可引用资料】与【本次附件】回答，每条结论尽量标注来源（如"见[来源1]"）。
若资料中没有明确答案，必须说明"资料未提供"，严禁编造数据或参数。

资料里有几种来源，回答时必须分清：
· 【你已验证的经验案例】= 用户本人实操并记录过的做法，优先级最高。引用时带上记录日期，例如"根据你 08-12 的记录"；
· 【你的失败记录（试过，没成）】= 用户试过但没成的做法。绝不能当作解决方案推荐，它的价值是"此路不通"：
  引用时要讲成警示（"你 08-12 试过这个做法，没成"）。同时要说清失败只代表【当时那个条件下】不成立 ——
  若本次场景的条件（材料批次 / 环境温湿度 / 设备 / 用量 / 时间）与那条记录有明显差异，
  要主动指出差异并说明"那次的条件和这次不同，可以再试"；条件基本相同时则明确劝阻，别让他再试一遍。
· 《文档名》= 原始技术资料（TDS / 规格书 / 手册），说明"理论上应当怎么做"。
冲突时：必须明确指出冲突，并以案例为准（例如"手册写 40 min，你的记录是 30 min 即合格，以你的实测为准"）；
但若以失败记录为准，含义是【这条路你试过不行】，不是"照它做"。
几种都没有时，明确说明"资料未提供"，不要用常识补。`;
      const fullContext = `${sys}\n\n【可引用资料】\n${ctx}\n\n${attText}`;
      const history = toChatHistory(updated.messages);
      const messages: ChatMsg[] = [
        { role: 'system', content: fullContext },
        ...history.slice(0, -1), // 去掉刚加的 user（已放最后）
        { role: 'user', content: text && text.trim() ? text : '（见本次附件）' },
      ];
      const aiText = await chat(get().settings.modelConfig, messages, { signal: gen.signal });
      const aiMsg: Message = { id: uid(), role: 'ai', content: aiText, quotes: hitsToQuotes(hits) };
      set({
        conversations: get().conversations.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, aiMsg] } : c)),
        thinking: false,
      });
      void persistConversations(get().conversations);
    } catch (e: any) {
      // 三种结束方式要给人看三句不同的话。都塞进「请求失败」的话，
      // 用户主动点了停止却看到一堆红字，会以为是自己操作错了。
      const content = genStopped
        ? '⏹ 已停止生成。'
        : genTimedOut
          ? `⚠️ 生成超时（超过 ${GEN_TIMEOUT_MS / 1000} 秒还没返回）。可能是网络不通，或模型还在加载 —— 换个网络，或到「我的」里检查一下模型配置。`
          : `⚠️ ${e?.message || '请求失败'}`;
      const errMsg: Message = { id: uid(), role: 'ai', content, quotes: [] };
      set({
        conversations: get().conversations.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, errMsg] } : c)),
        thinking: false,
        lastError: genStopped ? null : (genTimedOut ? content : e?.message || '请求失败'),
      });
      void persistConversations(get().conversations);
    } finally {
      gen.done();
    }
  },

  async runCompliance(text, attachments) {
    if (get().thinking) return; // 同 sendMessage：生成中不接受第二次
    let convId = get().currentConvId;
    if (!convId) { get().newConversation(); convId = get().currentConvId!; }
    const conv = get().conversations.find((c) => c.id === convId)!;
    const userMsg: Message = { id: uid(), role: 'user', content: `【需求符合性检查】${text}`, attachments };
    set({ conversations: get().conversations.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, userMsg] } : c)), thinking: true, lastError: null });

    const gen = beginGeneration();
    try {
      // 逐项核数值比一般问答更吃上下文：少带一段就少判一项，所以下限提到 12。
      // （这个下限原本是「对比」页那条通路单独设的，两路合并后统一到这里）
      const scope = resolveScope(get());
      const hits = await retrieve(text || '', { ...scope, topK: Math.max(scope.topK, 12) });
      set({ lastRetrieval: summarizeHits(hits, get().embeddingTotal) });
      const ctx = buildContext(hits);
      const attText = (attachments || []).filter((a) => a.text).length
        ? '【用户附件】\n' + (attachments || []).filter((a) => a.text).map((a) => `《${a.name}》\n${a.text}`).join('\n\n')
        : '';
      const prompt = compliancePrompt(text + (attText ? '\n\n' + attText : ''), ctx);
      const raw = await chat(
        get().settings.modelConfig,
        [
          { role: 'system', content: '你是树脂材料选型工程师，只输出合规检查结果 JSON。' },
          { role: 'user', content: prompt },
        ],
        { signal: gen.signal }
      );
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
      // 同 sendMessage：停止 / 超时 / 真失败要说三句不同的话
      const content = genStopped
        ? '⏹ 已停止生成。'
        : genTimedOut
          ? `⚠️ 合规检查超时（超过 ${GEN_TIMEOUT_MS / 1000} 秒还没返回）。逐项比对要读的段落更多，比普通提问慢是正常的 —— 可以换个网络再试。`
          : `⚠️ ${e?.message || '合规检查失败'}`;
      const errMsg: Message = { id: uid(), role: 'ai', content, quotes: [] };
      set({
        conversations: get().conversations.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, errMsg] } : c)),
        thinking: false,
        lastError: genStopped ? null : (genTimedOut ? content : e?.message || '合规检查失败'),
      });
      void persistConversations(get().conversations);
    } finally {
      gen.done();
    }
  },

  // 这里以前还有一个 runCompare + clearCompare。它们与 runCompliance 共用同一段提示词、
  // 同一个 system prompt，唯一区别是结果写进独立的 compareResult（撑起「对比」Tab）而不是会话。
  // 两个入口干一件事，于是「对比」降级成助手页的模式切换，这条通路合并进 runCompliance：
  // 结果从此落在会话里，刷新不会丢，导出与会话记录也自动一致。

  /**
   * 停止当前生成。**两条路径都要做**，缺一个就是「点了没反应」：
   *   · 云端 —— abort 掉 fetch（chat() 里已经把它接上了）
   *   · 本地 —— llama.rn 的 completion 不认 AbortSignal，得调它自己的 stopCompletion
   * 这里立刻把 thinking 置回 false：用户点了要有即时反馈，不能等网络回调才解锁界面。
   */
  stopGeneration() {
    genStopped = true;
    genCtl?.abort();
    void stopLocalChat();
    set({ thinking: false });
  },

  async updateSettings(patch) {
    const next: AppSettings = { ...get().settings, ...patch };
    set({ settings: next });
    // 开关一改就立刻生效，不等重启 —— 用户点完「离线模式」马上去提问是常态
    setPrivacySwitches(next.privacy);
    await saveSettings(next);
  },

  /** 用户在「云端调用需确认」弹窗上做了选择 */
  answerConfirm(ok) {
    const r = confirmResolver;
    confirmResolver = null;
    set({ pendingConfirm: null });
    r?.(ok);
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
      let skipped = 0;
      // NAS 同步是最容易撞重复的场景：同一个目录同步两次，以前就得到两份一模一样的资料
      //（每次都新建 uid，既不比名字也不比内容）。按正文指纹判重后，第二次同步是空操作。
      const seen = new Set(get().documents.map((d) => d.meta?.hash).filter(Boolean) as string[]);
      for (const f of files) {
        try {
          const text = await downloadText(conn, pw, f.href);
          if (!text) continue;
          const hash = contentHash(text);
          if (seen.has(hash)) { skipped++; continue; }
          seen.add(hash);
          const type = extToType(f.name);
          const doc: Document = {
            id: uid(), name: f.name, type, folderId: null, tags: ['NAS'],
            status: 'indexing', meta: { size: f.size, source: 'nas', hash }, createdAt: new Date().toISOString(),
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
      // 四种结果要说清，尤其「一份都没新增」要区分「NAS 上没有」和「全都有了」——
      // 后者是正常的，说成「未找到可索引的文档」会让人以为同步坏了。
      let note: string | null = null;
      if (!added && !skipped) note = 'NAS 上未找到可索引的文本文档（仅支持 TXT/MD 拉取，PDF/Word 暂跳过）。';
      else if (!added && skipped) note = `没有新内容：NAS 上这 ${skipped} 份都已经在库里了。`;
      else if (skipped) note = `新增 ${added} 份，跳过 ${skipped} 份（库里已有相同内容）。`;
      set({ documents: await getDocuments(), importing: false, lastError: note });
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
    const c = (code || '').trim();
    // 新设一律 6 位。校验放在这里而不是只放在界面上：设密码有两个入口
    //（首次启动的锁屏、「我的」里的改密码），漏一个就会写进一个 4 位密码。
    if (!/^\d{6}$/.test(c)) throw new Error('密码要 6 位数字');
    currentPasscode = c;
    await secureSet('app_passcode', c);
    set({ passcodeSet: true, locked: false });
  },

  unlock(code) {
    const ok = !!currentPasscode && code === currentPasscode;
    if (ok) set({ locked: false });
    return ok;
  },

  unlockByBiometric() { set({ locked: false }); },

  lock() { set({ locked: true }); },
}));
