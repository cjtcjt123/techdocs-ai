// 全局类型定义 —— 技术资料 AI 助手 MVP-0

export type DocStatus = 'indexing' | 'indexed' | 'partial' | 'failed';
export type DocType = 'pdf' | 'word' | 'md' | 'txt';
export type ChunkType = 'title' | 'para' | 'table' | 'code';
/**
 * 文档类型 —— 资料库「按类型分组」用的维度。
 * other = 认不出来（界面显示「未分类」，仍可由用户手工指定）。
 */
export type DocKind = 'tds' | 'spec' | 'report' | 'sds' | 'other';

export interface DocMeta {
  source?: string;
  model?: string; // 产品型号（如 CY1578）
  kind?: DocKind; // 文档类型（TDS / 规格书 / 检验报告 …），导入时自动识别，可手工改
  /**
   * 我自己的分类（如「拉挤行业」「高压行业」）—— **单选**，值只能来自用户自己建的分类表
   * （`AppSettings.categories`）。
   *
   * 与 tags 的分工：tags 是随手打、可多个、会发散；category 是先建好固定几个、只挑一个，
   * 目的是「两个行业的数据别混」。所以导入时**不自动猜**（行业靠关键词猜不准），
   * 由用户建好后在设置里指定「新导入默认归入」，或事后批量指派。
   *
   * ⚠️ 分类被删除后，已归入的文档**保留这个值**（分组仍按名字显示，不丢信息）——
   * 所以取值一律以 meta.category 为准，不要拿 categories 表去过滤分组。
   */
  category?: string;
  date?: string;
  size?: number;
  // ↓ 解析结果（导入时一次写入，用于资料库/详情页展示与排障）
  parseSource?: 'nas' | 'local' | 'none'; // 文本从哪来
  parseQuality?: number; // 0~1，越高越可信
  pages?: number; // PDF 页数
  chars?: number; // 提取到的字符数（0 = 没提到内容）
  note?: string; // 未提取到 / 质量偏低的原因
  /**
   * 正文指纹（见 store.contentHash）。只用来判「这份是不是已经在库里了」。
   * ⚠️ 按内容比、不按文件名比：NAS 同步会反复拉同名文件，改名也不该算新资料。
   * 老文档没有这个字段 → 第一次去重时会被当成新资料（一次性，可接受）。
   */
  hash?: string;
}

export interface Document {
  id: string;
  name: string;
  type: DocType;
  folderId?: string | null;
  tags: string[];
  pinned?: boolean; // 钉住：每次问答自动带入
  status: DocStatus;
  meta: DocMeta;
  createdAt: string;
}

// 检索范围与条数（问答时使用，可在问答页快速调整）
export interface RetrievalConfig {
  topK: number; // 带几段上下文
  onlyPinned: boolean; // 只用钉住的文档
  tags: string[]; // 限定标签（空 = 全部资料）
  /**
   * 限定「我自己的分类」（空 = 不限）。
   * 它和 onlyPinned / tags 是**同时生效**（取交集），不是互斥 —— 用户要的是
   * 「这次只在拉挤行业里问」，钉住的资料照旧强制带入。
   */
  category?: string;
}

// 全局搜索结果（资料库搜索页：文档名命中 + 原文片段命中 + 经验库案例命中）
export interface SearchResult {
  kind: 'doc' | 'chunk' | 'case';
  docId: string;
  docName: string;
  pageNo?: number;
  snippet: string;
  score: number;
}

export interface Chunk {
  id: string;
  docId: string;
  seq: number;
  content: string;
  pageNo?: number;
  ctype: ChunkType;
}

export interface Quote {
  docId: string;
  docName: string;
  pageNo?: number;
  snippet: string;
  score?: number; // 融合后的归一得分（0~1）
  from?: string[]; // 命中该条的路：case / keyword / semantic / pinned
  pinned?: boolean; // 来自「钉住文档」，不是检索命中的
  // ↓ 来源是「个人经验库」的案例，不是技术文档。UI 据此换徽章、正文据此提示「以你实测为准」
  kind?: 'doc' | 'case';
  caseId?: string;
  /**
   * 仅案例有：结果。来源卡据此把失败记录单独标出来 ——
   * 它是「用户实测事实」没错，但含义相反：不是「照这个做」，是「这条路你试过，没成」。
   * 两者共用一个徽章，用户看到 AI 引用它时会以为这是被推荐的做法。
   */
  outcome?: CaseOutcome;
}

// ============ 个人经验库（案例卡片）============
// 定位：原始文档说「理论上怎么做」，经验库说「你这里实际怎么做成功的」。
// 因此它比文档更有价值，也更危险 —— 一条错的案例会以最高优先级污染后续所有问答。
export type CaseOutcome = 'success' | 'partial' | 'fail';

export interface CaseRecord {
  id: string;
  title: string; // 问题/现象（一句话）
  problem?: string; // 详细现象
  product?: string; // 产品 / 型号
  environment?: string; // 环境、设备型号、固件 / 软件版本
  docIds?: string[]; // 关联的原始文档
  aiAdvice?: string; // 当时 AI 给的方案（记录用，不参与检索打分）
  rootCause?: string; // 根因
  finalFix: string; // 必填：最终真正有效的操作
  outcome: CaseOutcome; // 必填：结果
  notes?: string; // 注意事项 / 坑 / 适用范围
  tags: string[];
  // 门禁：只有「已验证」才进检索池。草稿（如将来由 AI 起草的）对检索完全不可见 ——
  // 否则模型的一次幻觉会戴上「你亲手记录的成功案例」的帽子进入下一次问答。
  verified: boolean;
  occurredAt?: string; // 发生时间
  createdAt: string; // 记录时间
  convId?: string; // 来源会话（可回溯当时的上下文）
  msgId?: string; // 来源消息
}

// 记录表单的输入（UI → store）。id / createdAt 由 store 生成，避免界面自己造时间戳
export interface CaseInput {
  title?: string;
  problem?: string;
  product?: string;
  environment?: string;
  docIds?: string[];
  aiAdvice?: string;
  rootCause?: string;
  finalFix: string;
  outcome: CaseOutcome;
  notes?: string;
  tags?: string[];
  occurredAt?: string;
  convId?: string;
  msgId?: string;
  /**
   * 是否参与问答检索。
   * 用户亲手填的案例一律为 true；编辑时可以手动关掉（相当于存成「草稿 / 先别用这条」）。
   * 这个开关就是检索的门禁 —— 关掉后案例仍留在库里可查，但不会被召回。
   */
  verified?: boolean;
}

export type ModelSource = 'api' | 'local';
export type Provider = 'openai' | 'claude' | 'deepseek' | 'tongyi' | 'zhipu' | 'custom';

export interface ModelConfig {
  source: ModelSource;
  provider?: Provider;
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

export type DataStrategy = 'local' | 'local+sync' | 'nas-only';

// NAS 连接配置（密码单独存 secure 层，不在此结构里）
export interface NasConnection {
  protocol: 'webdav' | 'smb';
  host: string;
  port: string; // 如 '5005'
  path: string; // 基路径，如 '/' 或 '/webdav'
  secure: boolean; // 是否 https
  user: string;
}


export interface Attachment {
  name: string;
  uri?: string;
  text?: string; // 解析出的文本（用于即时比对）
  type: string;
}

export interface Message {
  id: string;
  role: 'user' | 'ai';
  content: string;
  quotes?: Quote[];
  compliance?: ComplianceResult;
  attachments?: Attachment[];
}

export interface Conversation {
  id: string;
  title?: string;
  messages: Message[];
}

export interface ComplianceItem {
  item: string;
  required: string;
  actual: string;
  verdict: 'ok' | 'no' | 'warn';
  source?: string;
}

export interface ComplianceResult {
  model: string;
  items: ComplianceItem[];
  conclusion: string;
}
