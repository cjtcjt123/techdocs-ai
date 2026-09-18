// 本地存储层（expo-sqlite）—— 文档元信息 + 文本块
import * as SQLite from 'expo-sqlite';
import { Document, Chunk, DocStatus, DocMeta, CaseRecord } from '../types';

const db = SQLite.openDatabaseSync('techdocs.db');

export async function initDB() {
  await db.execAsync(`PRAGMA journal_mode = WAL;`);
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      folderId TEXT,
      tags TEXT,
      pinned INTEGER DEFAULT 0,
      status TEXT NOT NULL,
      meta TEXT,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      docId TEXT NOT NULL,
      seq INTEGER NOT NULL,
      content TEXT NOT NULL,
      pageNo INTEGER,
      ctype TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(docId);
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT
    );
    CREATE TABLE IF NOT EXISTS embeddings (
      chunkId TEXT PRIMARY KEY,
      docId TEXT NOT NULL,
      model TEXT,
      dim INTEGER,
      vec BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_emb_doc ON embeddings(docId);
    -- 个人经验库。新表用 CREATE TABLE IF NOT EXISTS 就够：老库没有这张表 → 这里直接建出来，
    -- 不需要 ALTER 迁移（只有「给已有表加列」才必须显式 ALTER）。
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      problem TEXT,
      product TEXT,
      environment TEXT,
      docIds TEXT,
      aiAdvice TEXT,
      rootCause TEXT,
      finalFix TEXT NOT NULL,
      outcome TEXT NOT NULL,
      notes TEXT,
      tags TEXT,
      verified INTEGER DEFAULT 1,
      occurredAt TEXT,
      createdAt TEXT NOT NULL,
      convId TEXT,
      msgId TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cases_created ON cases(createdAt);
  `);
  // 老库升级：已装机用户的 documents 表没有 pinned 列，
  // CREATE TABLE IF NOT EXISTS 不会补列，必须显式 ALTER，否则读取时报 no such column 直接崩。
  // 列已存在时会抛错，吞掉即可（幂等）。
  try {
    await db.execAsync(`ALTER TABLE documents ADD COLUMN pinned INTEGER DEFAULT 0`);
  } catch {
    // 列已存在，无需处理
  }
}

// ---- 设置持久化（非敏感字段存 kv，apiKey 走 secure-store）----
export async function kvGet(k: string): Promise<string | null> {
  const r = await db.getFirstAsync<any>(`SELECT v FROM kv WHERE k=?`, [k]);
  return r?.v ?? null;
}

export async function kvSet(k: string, v: string): Promise<void> {
  await db.runAsync(`INSERT OR REPLACE INTO kv (k,v) VALUES (?,?)`, [k, v]);
}

// ---- 文档 ----
export async function insertDocument(doc: Document) {
  await db.runAsync(
    `INSERT OR REPLACE INTO documents (id,name,type,folderId,tags,pinned,status,meta,createdAt)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [doc.id, doc.name, doc.type, doc.folderId ?? null, JSON.stringify(doc.tags),
     doc.pinned ? 1 : 0, doc.status, JSON.stringify(doc.meta), doc.createdAt]
  );
}

export async function updateDocStatus(id: string, status: DocStatus) {
  await db.runAsync(`UPDATE documents SET status=? WHERE id=?`, [status, id]);
}

export async function getDocuments(): Promise<Document[]> {
  const rows = await db.getAllAsync<any>(`SELECT * FROM documents ORDER BY createdAt DESC`);
  return rows.map(r => ({
    id: r.id, name: r.name, type: r.type, folderId: r.folderId,
    tags: JSON.parse(r.tags || '[]'), pinned: !!r.pinned, status: r.status,
    meta: JSON.parse(r.meta || '{}'), createdAt: r.createdAt,
  }));
}

export async function getDocument(id: string): Promise<Document | null> {
  const r = await db.getFirstAsync<any>(`SELECT * FROM documents WHERE id=?`, [id]);
  if (!r) return null;
  return {
    ...r, tags: JSON.parse(r.tags || '[]'), pinned: !!r.pinned,
    meta: JSON.parse(r.meta || '{}'),
  };
}

// 钉住 / 取消钉住
export async function setDocumentPinned(id: string, pinned: boolean) {
  await db.runAsync(`UPDATE documents SET pinned=? WHERE id=?`, [pinned ? 1 : 0, id]);
}

// 覆盖式设置标签
export async function setDocumentTags(id: string, tags: string[]) {
  await db.runAsync(`UPDATE documents SET tags=? WHERE id=?`, [JSON.stringify(tags), id]);
}

export async function deleteDocument(id: string) {
  await db.runAsync(`DELETE FROM chunks WHERE docId=?`, [id]);
  await db.runAsync(`DELETE FROM embeddings WHERE docId=?`, [id]); // 向量随文档一起清，别留孤儿
  await db.runAsync(`DELETE FROM documents WHERE id=?`, [id]);
}

export async function renameDocument(id: string, name: string) {
  await db.runAsync(`UPDATE documents SET name=? WHERE id=?`, [name, id]);
}

// ---- 文本块 ----
export async function insertChunks(chunks: Chunk[]) {
  for (const c of chunks) {
    await db.runAsync(
      `INSERT OR REPLACE INTO chunks (id,docId,seq,content,pageNo,ctype) VALUES (?,?,?,?,?,?)`,
      [c.id, c.docId, c.seq, c.content, c.pageNo ?? null, c.ctype]
    );
  }
}

export async function getChunks(docId: string): Promise<Chunk[]> {
  return db.getAllAsync<Chunk>(`SELECT * FROM chunks WHERE docId=? ORDER BY seq`, [docId]);
}

// ---- 检索数据源 ----
// 检索层（retrieval.ts）需要全量 chunk 来建内存索引：BM25 依赖全量语料统计
// （df / 平均长度），只取 top-N 是无法正确算 IDF 的。索引层按「内容指纹」缓存，
// 所以这里可以放心全量拉取。
export async function getAllChunksForIndex(): Promise<
  Array<{ id: string; docId: string; content: string; pageNo?: number }>
> {
  return db.getAllAsync<any>(
    `SELECT c.id, c.docId, c.content, c.pageNo
     FROM chunks c JOIN documents d ON d.id = c.docId
     ORDER BY c.docId, c.seq`
  );
}

// 取指定文档的文本块 —— 「钉住文档」每次问答自动带入时用
export async function getChunksByDocs(docIds: string[], limit = 12): Promise<any[]> {
  if (!docIds.length) return [];
  return db.getAllAsync<any>(
    `SELECT c.docId, c.content, c.pageNo, d.name as docName
     FROM chunks c JOIN documents d ON d.id=c.docId
     WHERE c.docId IN (${docIds.map(() => '?').join(',')})
     ORDER BY c.docId, c.seq LIMIT ?`,
    [...docIds, limit]
  );
}

// ---- 语义检索向量（派生数据：丢了按原文本重算即可，故无需迁移与备份）----
// float32 存 BLOB：512 维 = 2KB/块，一千块也就 2MB，比 JSON 省一半以上。

export interface EmbeddingRow {
  chunkId: string;
  docId: string;
  vec: Float32Array;
}

const f32ToBlob = (v: Float32Array) =>
  new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));

const blobToF32 = (b: any): Float32Array => {
  const u8: Uint8Array = b instanceof Uint8Array ? b : new Uint8Array(b || []);
  // 拷一份再包成 Float32Array：sqlite 返回的 buffer 可能不是 4 字节对齐的
  const copy = u8.slice();
  if (copy.byteLength % 4 !== 0) return new Float32Array(0);
  return new Float32Array(copy.buffer);
};

export async function putEmbeddings(
  rows: Array<{ chunkId: string; docId: string }>,
  vectors: number[][],
  model: string
): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    const vec = new Float32Array(vectors[i] || []);
    await db.runAsync(
      `INSERT OR REPLACE INTO embeddings (chunkId,docId,model,dim,vec) VALUES (?,?,?,?,?)`,
      [rows[i].chunkId, rows[i].docId, model, vec.length, f32ToBlob(vec)]
    );
  }
}

/** 取向量。不传 docIds 则取全部（建内存索引用）。 */
export async function getEmbeddings(docIds?: string[]): Promise<EmbeddingRow[]> {
  if (docIds && docIds.length === 0) return [];
  const where = docIds && docIds.length ? ` WHERE docId IN (${docIds.map(() => '?').join(',')})` : '';
  const rows = await db.getAllAsync<any>(
    `SELECT chunkId, docId, vec FROM embeddings${where}`,
    docIds && docIds.length ? docIds : []
  );
  return rows.map((r) => ({ chunkId: r.chunkId, docId: r.docId, vec: blobToF32(r.vec) }));
}

/** 已索引的向量条数 + 用的模型（用于界面显示「语义已索引 N/M」与模型不一致检测） */
export async function embeddingStats(): Promise<{ count: number; model: string | null; dim: number | null }> {
  const r = await db.getFirstAsync<any>(`SELECT COUNT(*) AS n FROM embeddings`);
  const m = await db.getFirstAsync<any>(`SELECT model, dim FROM embeddings LIMIT 1`);
  return { count: r?.n || 0, model: m?.model ?? null, dim: m?.dim ?? null };
}

export async function deleteEmbeddingsByDoc(docId: string): Promise<void> {
  await db.runAsync(`DELETE FROM embeddings WHERE docId=?`, [docId]);
}

export async function clearEmbeddings(): Promise<void> {
  await db.runAsync(`DELETE FROM embeddings`);
}

// ---- 个人经验库（案例）----
// 与 documents/chunks 并列的独立表：案例不是文档（没有文件、没有分块、没有页码），
// 硬塞进 documents 会让「资料库列表」「解析状态」这些既有逻辑到处长 case 分支。
const CASE_COLS =
  'id,title,problem,product,environment,docIds,aiAdvice,rootCause,finalFix,outcome,notes,tags,verified,occurredAt,createdAt,convId,msgId';

function rowToCase(r: any): CaseRecord {
  return {
    id: r.id,
    title: r.title || '',
    problem: r.problem || undefined,
    product: r.product || undefined,
    environment: r.environment || undefined,
    docIds: JSON.parse(r.docIds || '[]'),
    aiAdvice: r.aiAdvice || undefined,
    rootCause: r.rootCause || undefined,
    finalFix: r.finalFix || '',
    outcome: r.outcome,
    notes: r.notes || undefined,
    tags: JSON.parse(r.tags || '[]'),
    // 老行没有该列时按「已验证」处理：能写进来的案例都是用户亲手填的
    verified: r.verified == null ? true : !!r.verified,
    occurredAt: r.occurredAt || undefined,
    createdAt: r.createdAt,
    convId: r.convId || undefined,
    msgId: r.msgId || undefined,
  };
}

export async function listCases(): Promise<CaseRecord[]> {
  const rows = await db.getAllAsync<any>(`SELECT ${CASE_COLS} FROM cases ORDER BY createdAt DESC`);
  return rows.map(rowToCase);
}

/** 只取「已验证」的 —— 检索层的唯一入口，门禁（draft 不可见）在这里落地 */
export async function listVerifiedCases(): Promise<CaseRecord[]> {
  const rows = await db.getAllAsync<any>(
    `SELECT ${CASE_COLS} FROM cases WHERE verified=1 AND finalFix <> '' ORDER BY createdAt DESC`
  );
  return rows.map(rowToCase);
}

export async function getCase(id: string): Promise<CaseRecord | null> {
  const r = await db.getFirstAsync<any>(`SELECT ${CASE_COLS} FROM cases WHERE id=?`, [id]);
  return r ? rowToCase(r) : null;
}

export async function saveCase(c: CaseRecord): Promise<void> {
  await db.runAsync(
    `INSERT OR REPLACE INTO cases (${CASE_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      c.id, c.title || '', c.problem ?? null, c.product ?? null, c.environment ?? null,
      JSON.stringify(c.docIds || []), c.aiAdvice ?? null, c.rootCause ?? null, c.finalFix,
      c.outcome, c.notes ?? null, JSON.stringify(c.tags || []), c.verified ? 1 : 0,
      c.occurredAt ?? null, c.createdAt, c.convId ?? null, c.msgId ?? null,
    ]
  );
}

export async function deleteCase(id: string): Promise<void> {
  await db.runAsync(`DELETE FROM cases WHERE id=?`, [id]);
}

export async function countCases(): Promise<{ total: number; verified: number }> {
  const r = await db.getFirstAsync<any>(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN verified=1 THEN 1 ELSE 0 END) AS verified FROM cases`
  );
  return { total: r?.total || 0, verified: r?.verified || 0 };
}
