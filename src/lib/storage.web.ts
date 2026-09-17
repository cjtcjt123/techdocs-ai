// 本地存储层（web 预览降级）—— 浏览器无 expo-sqlite 原生模块，改用 localStorage 持久化
// 导出的 API 与 storage.ts（expo-sqlite 版）完全一致，由 Metro 按平台自动替换
import { Document, Chunk, DocStatus } from '../types';

const NS = 'techdocs.v1.db';

interface DBShape {
  documents: Document[];
  chunks: Chunk[];
  kv: Record<string, string>;
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
  persist();
}

export async function renameDocument(id: string, name: string) {
  const doc = load().documents.find(d => d.id === id);
  if (doc) doc.name = name;
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

// ---- 全文检索（MVP 用关键词，向量检索后置；打分逻辑与原生版一致）----
export async function searchChunks(query: string, limit = 8): Promise<any[]> {
  const db = load();
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return [];
  const nameById = new Map(db.documents.map(d => [d.id, d.name]));
  const scored = db.chunks
    .filter(c => nameById.has(c.docId))
    .map(c => {
      const text = (c.content || '').toLowerCase();
      let score = 0;
      for (const t of terms) if (text.includes(t)) score++;
      return {
        docId: c.docId,
        content: c.content,
        pageNo: c.pageNo,
        docName: nameById.get(c.docId) as string,
        score,
      };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}
