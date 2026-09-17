// 全局类型定义 —— 技术资料 AI 助手 MVP-0

export type DocStatus = 'indexing' | 'indexed' | 'partial' | 'failed';
export type DocType = 'pdf' | 'word' | 'md' | 'txt';
export type ChunkType = 'title' | 'para' | 'table' | 'code';

export interface DocMeta {
  source?: string;
  model?: string; // 产品型号（如 CY1578）
  date?: string;
  size?: number;
}

export interface Document {
  id: string;
  name: string;
  type: DocType;
  folderId?: string | null;
  tags: string[];
  status: DocStatus;
  meta: DocMeta;
  createdAt: string;
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
}

export type ModelSource = 'official' | 'local' | 'nas';
export type Provider = 'openai' | 'claude' | 'deepseek' | 'tongyi' | 'zhipu' | 'custom';

export interface ModelConfig {
  source: ModelSource;
  provider?: Provider;
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

export type DataStrategy = 'local' | 'local+sync' | 'nas-only';

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
