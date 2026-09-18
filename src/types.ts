// 全局类型定义 —— 技术资料 AI 助手 MVP-0

export type DocStatus = 'indexing' | 'indexed' | 'partial' | 'failed';
export type DocType = 'pdf' | 'word' | 'md' | 'txt';
export type ChunkType = 'title' | 'para' | 'table' | 'code';

export interface DocMeta {
  source?: string;
  model?: string; // 产品型号（如 CY1578）
  date?: string;
  size?: number;
  // ↓ 解析结果（导入时一次写入，用于资料库/详情页展示与排障）
  parseSource?: 'nas' | 'local' | 'none'; // 文本从哪来
  parseQuality?: number; // 0~1，越高越可信
  pages?: number; // PDF 页数
  chars?: number; // 提取到的字符数（0 = 没提到内容）
  note?: string; // 未提取到 / 质量偏低的原因
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
