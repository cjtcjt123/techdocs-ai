// 本地存储层（expo-sqlite）—— 文档元信息 + 文本块
import * as SQLite from 'expo-sqlite';
import { Document, Chunk, DocStatus, DocMeta } from '../types';

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
  `);
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
    `INSERT OR REPLACE INTO documents (id,name,type,folderId,tags,status,meta,createdAt)
     VALUES (?,?,?,?,?,?,?,?)`,
    [doc.id, doc.name, doc.type, doc.folderId ?? null, JSON.stringify(doc.tags),
     doc.status, JSON.stringify(doc.meta), doc.createdAt]
  );
}

export async function updateDocStatus(id: string, status: DocStatus) {
  await db.runAsync(`UPDATE documents SET status=? WHERE id=?`, [status, id]);
}

export async function getDocuments(): Promise<Document[]> {
  const rows = await db.getAllAsync<any>(`SELECT * FROM documents ORDER BY createdAt DESC`);
  return rows.map(r => ({
    id: r.id, name: r.name, type: r.type, folderId: r.folderId,
    tags: JSON.parse(r.tags || '[]'), status: r.status,
    meta: JSON.parse(r.meta || '{}'), createdAt: r.createdAt,
  }));
}

export async function getDocument(id: string): Promise<Document | null> {
  const r = await db.getFirstAsync<any>(`SELECT * FROM documents WHERE id=?`, [id]);
  if (!r) return null;
  return { ...r, tags: JSON.parse(r.tags || '[]'), meta: JSON.parse(r.meta || '{}') };
}

export async function deleteDocument(id: string) {
  await db.runAsync(`DELETE FROM chunks WHERE docId=?`, [id]);
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

// ---- 全文检索（MVP 用关键词，向量检索后置）----
export async function searchChunks(query: string, limit = 8): Promise<any[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return [];
  const rows = await db.getAllAsync<any>(
    `SELECT c.docId, c.content, c.pageNo, d.name as docName
     FROM chunks c JOIN documents d ON d.id=c.docId`
  );
  const scored = rows.map(r => {
    const text = (r.content || '').toLowerCase();
    let score = 0;
    for (const t of terms) if (text.includes(t)) score++;
    return { ...r, score };
  }).filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}
