/**
 * 检索层：混合检索的两路「召回」都在这
 *   · 关键词路 —— BM25 + 中文分词（keyword.ts）。纯本地、零成本、永远在线
 *   · 语义路   —— 嵌入向量余弦相似度（embedding.ts）。需要配嵌入服务，连不上就静默跳过
 *
 * 分层：keyword.ts 纯函数打分 / 本文件负责 IO 与缓存 / rag.ts 负责多路融合与上下文拼装
 *
 * 缓存策略：BM25 需要全量语料统计（df、avgdl），不能每次问答都重算；
 * 向量同理（读全表 BLOB 也不便宜）。两处都用「内容指纹」判定失效 ——
 * 导入、删除、重新解析这三件会让索引失效的事都会改变指纹，而它们正是全部失效来源。
 * 文档名【刻意不参与缓存】：改名后要立刻生效，所以每次检索实时回填，代价只是一次极轻的 SELECT。
 */
import { KeywordIndex, tokenize } from './keyword';
import type { KeywordHit } from './keyword';
import { getAllChunksForIndex, getDocuments, getEmbeddings } from './storage';
import { cosine, embedTexts } from './embedding';
import type { EmbeddingConfig } from './settings';
import type { SearchResult } from '../types';

interface CorpusRow {
  id: string;
  docId: string;
  content: string;
  pageNo?: number;
}

let cachedIndex: KeywordIndex | null = null;
let cachedRows: CorpusRow[] = [];
let cachedFingerprint = '';
let cachedVectors: Array<{ chunkId: string; docId: string; vec: Float32Array }> | null = null;

function fingerprintOf(rows: CorpusRow[]): string {
  let total = 0;
  for (const r of rows) total += (r.content || '').length + 1;
  return `${rows.length}:${total}`;
}

/** 取语料行（关键词索引与语义路共用同一份缓存） */
async function loadCorpus(): Promise<CorpusRow[]> {
  await getKeywordIndex(); // 顺带保证缓存已就绪
  return cachedRows;
}

/** 取（必要时重建）关键词索引。语料指纹变了就重建。 */
export async function getKeywordIndex(): Promise<KeywordIndex> {
  const rows = (await getAllChunksForIndex()) as CorpusRow[];
  const fp = fingerprintOf(rows);
  if (cachedIndex && cachedFingerprint === fp) return cachedIndex;
  cachedRows = rows;
  cachedFingerprint = fp;
  cachedIndex = new KeywordIndex(
    rows.map((r) => ({
      id: r.id,
      docId: r.docId,
      docName: '', // 由调用方实时回填
      content: r.content || '',
      pageNo: r.pageNo,
    }))
  );
  return cachedIndex;
}

/** 显式作废全部检索缓存（重建语义索引后必须调用） */
export function invalidateRetrievalIndex() {
  cachedIndex = null;
  cachedRows = [];
  cachedFingerprint = '';
  cachedVectors = null;
}

async function getVectorIndex() {
  if (cachedVectors) return cachedVectors;
  cachedVectors = await getEmbeddings();
  return cachedVectors;
}

async function docNameMap(): Promise<Map<string, string>> {
  const docs = await getDocuments();
  return new Map(docs.map((d) => [d.id, d.name]));
}

/**
 * 关键词检索（BM25）。签名与旧的 storage.searchChunks 一致，调用方无感。
 *   · query   查询原文，支持中文整句（内部自动分词）
 *   · docIds  限定检索范围；显式传空数组 = 范围为空 = 无结果
 */
export async function searchChunks(
  query: string,
  limit = 8,
  opts?: { docIds?: string[] }
): Promise<KeywordHit[]> {
  if (!(query || '').trim()) return [];
  const idx = await getKeywordIndex();
  const hits = idx.search(query, limit, opts?.docIds);
  if (!hits.length) return [];
  const names = await docNameMap();
  for (const h of hits) h.docName = names.get(h.docId) || '(已删除)';
  return hits;
}

/**
 * 语义检索：查询向量 vs 已索引 chunk 向量的余弦相似度。
 *
 * 返回 [] 的三种情况（都属正常，调用方据此退回纯关键词）：
 *   1) 没配嵌入服务
 *   2) 还没建向量索引（用户没点过「重建语义索引」）
 *   3) 向量维度对不上（中途换了嵌入模型）—— 逐条跳过，不抛错
 * 嵌入服务调用失败则抛错，由 rag 决定是否吞掉。
 */
export async function semanticSearch(
  query: string,
  limit = 10,
  opts?: { docIds?: string[]; embedding?: EmbeddingConfig }
): Promise<KeywordHit[]> {
  const cfg = opts?.embedding;
  if (!cfg?.endpoint || !(query || '').trim()) return [];
  if (opts?.docIds && opts.docIds.length === 0) return [];

  const vecs = await getVectorIndex();
  if (!vecs.length) return [];

  const out = await embedTexts([query], { ...cfg, batchSize: 1 });
  const qv = out?.vectors?.[0];
  if (!qv?.length) return [];

  await loadCorpus();
  const byId = new Map(cachedRows.map((r) => [r.id, r]));
  const names = await docNameMap();
  const allow = opts?.docIds && opts.docIds.length ? new Set(opts.docIds) : null;

  const scored: KeywordHit[] = [];
  for (const v of vecs) {
    if (v.vec.length !== qv.length) continue; // 换了模型 → 这条向量作废
    if (allow && !allow.has(v.docId)) continue;
    const row = byId.get(v.chunkId);
    if (!row) continue;
    scored.push({
      id: row.id,
      docId: row.docId,
      docName: names.get(row.docId) || '(已删除)',
      content: row.content,
      pageNo: row.pageNo,
      score: cosine(qv, Array.from(v.vec)),
      matched: [],
    });
  }

  scored.sort((a, b) => b.score - a.score);
  // 余弦可能为负（语义相反），截断到 0 以上，避免干扰后面的展示与融合
  return scored.filter((h) => h.score > 0).slice(0, limit);
}

/**
 * 全局搜索：文档名命中 + 正文片段命中，合成一个结果流（不经过模型，秒出）
 * 文档名用「查询词覆盖率」打分 —— 名字很短，套 BM25 的长度归一化没有意义。
 */
export async function searchAll(query: string, limit = 30): Promise<SearchResult[]> {
  const q = (query || '').trim();
  if (!q) return [];
  const terms = [...new Set(tokenize(q, 'query'))];
  if (!terms.length) return [];

  const out: SearchResult[] = [];

  // 1) 文档名命中（搜型号时直接找到那份 TDS）
  const docs = await getDocuments();
  for (const d of docs) {
    const nameTokens = new Set(tokenize(d.name, 'index'));
    const hitCount = terms.filter((t) => nameTokens.has(t)).length;
    if (!hitCount) continue;
    const coverage = hitCount / terms.length;
    out.push({
      kind: 'doc',
      docId: d.id,
      docName: d.name,
      snippet: `${String(d.type || '').toUpperCase()} 文档`,
      score: coverage * 3 + hitCount * 0.2,
    });
  }

  // 2) 正文片段命中
  const chunkHits = await searchChunks(query, limit);
  for (const c of chunkHits) {
    out.push({
      kind: 'chunk',
      docId: c.docId,
      docName: c.docName,
      pageNo: c.pageNo,
      snippet: c.content,
      score: c.score,
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
