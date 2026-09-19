// 本地存储层（web 预览降级）—— 浏览器无 expo-sqlite 原生模块，改用 localStorage 持久化
// 导出的 API 与 storage.ts（expo-sqlite 版）完全一致，由 Metro 按平台自动替换
import { Document, Chunk, DocStatus, CaseRecord } from '../types';

const NS = 'techdocs.v1.db';

interface DBShape {
  documents: Document[];
  chunks: Chunk[];
  kv: Record<string, string>;
  // 语义检索向量，vec 是 base64 后的 float32（比 JSON 数组省 60% 体积，localStorage 只有 5MB）
  embeddings: Array<{ chunkId: string; docId: string; model?: string; dim?: number; vec: string }>;
  // 个人经验库（案例）。老数据没有这个键 → 视为空数组，不需要迁移
  cases: CaseRecord[];
}

let cache: DBShape | null = null;

function load(): DBShape {
  if (cache) return cache;
  let parsed: any = null;
  try {
    const raw = window.localStorage.getItem(NS);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  cache = {
    documents: Array.isArray(parsed?.documents) ? parsed.documents : [],
    chunks: Array.isArray(parsed?.chunks) ? parsed.chunks : [],
    kv: parsed?.kv && typeof parsed.kv === 'object' ? parsed.kv : {},
    embeddings: Array.isArray(parsed?.embeddings) ? parsed.embeddings : [],
    cases: Array.isArray(parsed?.cases) ? parsed.cases : [],
  };
  return cache;
}

function persist() {
  try {
    window.localStorage.setItem(NS, JSON.stringify(load()));
  } catch {
    // 超出配额等异常不应阻断主流程
  }
}

export async function initDB() {
  load();
}

// ---- 设置持久化（非敏感字段存 kv，apiKey 走 secure 层）----
export async function kvGet(k: string): Promise<string | null> {
  const v = load().kv[k];
  return v === undefined ? null : v;
}

export async function kvSet(k: string, v: string): Promise<void> {
  load().kv[k] = v;
  persist();
}

// ---- 文档 ----
export async function insertDocument(doc: Document) {
  const db = load();
  const i = db.documents.findIndex(d => d.id === doc.id);
  if (i >= 0) db.documents[i] = doc;
  else db.documents.push(doc);
  persist();
}

export async function updateDocStatus(id: string, status: DocStatus) {
  const db = load();
  const doc = db.documents.find(d => d.id === id);
  if (doc) doc.status = status;
  persist();
}

export async function getDocuments(): Promise<Document[]> {
  return [...load().documents].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getDocument(id: string): Promise<Document | null> {
  return load().documents.find(d => d.id === id) ?? null;
}

export async function deleteDocument(id: string) {
  const db = load();
  db.documents = db.documents.filter(d => d.id !== id);
  db.chunks = db.chunks.filter(c => c.docId !== id);
  db.embeddings = db.embeddings.filter(e => e.docId !== id); // 向量随文档一起清，别留孤儿
  persist();
}

export async function renameDocument(id: string, name: string) {
  const doc = load().documents.find(d => d.id === id);
  if (doc) doc.name = name;
  persist();
}

// 钉住 / 取消钉住（web 版文档就是普通对象，pinned 直接读写；旧数据无此字段视为 false）
export async function setDocumentPinned(id: string, pinned: boolean) {
  const doc = load().documents.find(d => d.id === id);
  if (doc) doc.pinned = pinned;
  persist();
}

// 覆盖式设置标签
export async function setDocumentTags(id: string, tags: string[]) {
  const doc = load().documents.find(d => d.id === id);
  if (doc) doc.tags = tags;
  persist();
}

// ---- 文本块 ----
export async function insertChunks(chunks: Chunk[]) {
  const db = load();
  for (const c of chunks) {
    const i = db.chunks.findIndex(x => x.id === c.id && x.docId === c.docId);
    if (i >= 0) db.chunks[i] = c;
    else db.chunks.push(c);
  }
  persist();
}

export async function getChunks(docId: string): Promise<Chunk[]> {
  return load().chunks.filter(c => c.docId === docId).sort((a, b) => a.seq - b.seq);
}

// ---- 检索数据源 ----
// 检索层（retrieval.ts）需要全量 chunk 建内存索引（BM25 依赖全量 df / 平均长度统计）
export async function getAllChunksForIndex(): Promise<
  Array<{ id: string; docId: string; content: string; pageNo?: number }>
> {
  return load().chunks.map(c => ({
    id: c.id, docId: c.docId, content: c.content, pageNo: c.pageNo,
  }));
}

// 语料指纹（见 storage.ts 同名函数的注释：口径是 Σ(长度 + 1)）。
// web 端没有 SQL，但同样不必为了两个数字去 map 出一整个新数组。
// 与原生实现同语义：不限定文档 = 全库；限定 = 只数这些文档的块（见 storage.ts 的注释）
export async function countChunks(docIds?: string[]): Promise<number> {
  const cs = load().chunks;
  if (docIds && docIds.length === 0) return 0;
  return docIds ? cs.filter((c) => docIds.includes(c.docId)).length : cs.length;
}

export async function getChunksFingerprint(): Promise<{ count: number; chars: number }> {
  const cs = load().chunks;
  let chars = 0;
  for (const c of cs) chars += (c.content || '').length + 1;
  return { count: cs.length, chars };
}

// 取指定文档的文本块 —— 「钉住文档」自动带入上下文时用
export async function getChunksByDocs(docIds: string[], limit = 12): Promise<any[]> {
  if (!docIds.length) return [];
  const db = load();
  const allow = new Set(docIds);
  const nameById = new Map(db.documents.map(d => [d.id, d.name]));
  return db.chunks
    .filter(c => allow.has(c.docId) && nameById.has(c.docId))
    .sort((a, b) => (a.docId === b.docId ? a.seq - b.seq : a.docId < b.docId ? -1 : 1))
    .slice(0, limit)
    .map(c => ({
      docId: c.docId, content: c.content, pageNo: c.pageNo,
      docName: nameById.get(c.docId) as string,
    }));
}

// ---- 语义检索向量（派生数据：丢了按原文本重算即可）----
// 用 base64(float32) 而不是 JSON 数组：localStorage 只有 5MB，JSON 里每条 float 要 8~10 个字符。
// （真机走 storage.ts 的 sqlite BLOB，没这个限制；这里只是让浏览器预览也能自测）

function f32ToB64(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  let s = '';
  const CH = 8192; // 分块喂给 fromCharCode，避免参数过多爆栈
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode(...(Array.from(bytes.subarray(i, i + CH)) as number[]));
  }
  return btoa(s);
}

function b64ToF32(b64: string): Float32Array {
  try {
    const bin = atob(b64 || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.byteLength % 4 !== 0) return new Float32Array(0);
    return new Float32Array(bytes.buffer);
  } catch {
    return new Float32Array(0);
  }
}

export interface EmbeddingRow {
  chunkId: string;
  docId: string;
  vec: Float32Array;
}

export async function putEmbeddings(
  rows: Array<{ chunkId: string; docId: string }>,
  vectors: number[][],
  model: string
): Promise<void> {
  const db = load();
  for (let i = 0; i < rows.length; i++) {
    const vec = new Float32Array(vectors[i] || []);
    const next = { chunkId: rows[i].chunkId, docId: rows[i].docId, model, dim: vec.length, vec: f32ToB64(vec) };
    const at = db.embeddings.findIndex(e => e.chunkId === rows[i].chunkId);
    if (at >= 0) db.embeddings[at] = next;
    else db.embeddings.push(next);
  }
  persist();
}

export async function getEmbeddings(docIds?: string[]): Promise<EmbeddingRow[]> {
  if (docIds && docIds.length === 0) return [];
  const allow = docIds && docIds.length ? new Set(docIds) : null;
  return load().embeddings
    .filter(e => !allow || allow.has(e.docId))
    .map(e => ({ chunkId: e.chunkId, docId: e.docId, vec: b64ToF32(e.vec) }));
}

export async function embeddingStats(): Promise<{ count: number; model: string | null; dim: number | null }> {
  const list = load().embeddings;
  const first = list[0];
  return { count: list.length, model: first?.model ?? null, dim: first?.dim ?? null };
}

export async function deleteEmbeddingsByDoc(docId: string): Promise<void> {
  const db = load();
  db.embeddings = db.embeddings.filter(e => e.docId !== docId);
  persist();
}

export async function clearEmbeddings(): Promise<void> {
  const db = load();
  db.embeddings = [];
  persist();
}

// ---- 个人经验库（案例）----
// web 版直接把 CaseRecord 存进数组（JSON 天然就是这个形状），不需要 storage.ts 那套列映射。
// 存取都做一次浅拷贝：调用方拿到的对象不该被后续 save 意外改写。
const cloneCase = (c: CaseRecord): CaseRecord => ({
  ...c,
  docIds: [...(c.docIds || [])],
  tags: [...(c.tags || [])],
});

export async function listCases(): Promise<CaseRecord[]> {
  return [...load().cases]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(cloneCase);
}

/** 只取「已验证」的 —— 检索层的唯一入口，门禁（draft 不可见）在这里落地 */
export async function listVerifiedCases(): Promise<CaseRecord[]> {
  return (await listCases()).filter((c) => c.verified && !!c.finalFix);
}

export async function getCase(id: string): Promise<CaseRecord | null> {
  const c = load().cases.find((x) => x.id === id);
  return c ? cloneCase(c) : null;
}

export async function saveCase(c: CaseRecord): Promise<void> {
  const db = load();
  const i = db.cases.findIndex((x) => x.id === c.id);
  const next = cloneCase(c);
  if (i >= 0) db.cases[i] = next;
  else db.cases.push(next);
  persist();
}

export async function deleteCase(id: string): Promise<void> {
  const db = load();
  db.cases = db.cases.filter((x) => x.id !== id);
  persist();
}

export async function countCases(): Promise<{ total: number; verified: number }> {
  const list = load().cases;
  return { total: list.length, verified: list.filter((c) => c.verified).length };
}
