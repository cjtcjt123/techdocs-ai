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
import {
  getAllChunksForIndex,
  getChunksFingerprint,
  getDocuments,
  getEmbeddings,
  listVerifiedCases,
} from './storage';
import { cosine, embedTexts } from './embedding';
import type { EmbeddingConfig } from './settings';
import {
  caseCorpusRow,
  caseDisplayName,
  caseDocId,
  caseToText,
  isCaseDocId,
  indexableCases,
} from './cases';
import type { CaseRecord } from '../types';
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
// 经验库案例（只含「已验证」的）。刻意【不做跨次缓存】：
// 案例是用户随时会写的活数据，而「记了却搜不到」这个 bug 极难被发现（还以为是自己没写清）。
// 它每次问答只被读两次（建索引 + 回填名字），量级是几十行的小表，代价可忽略。
let cachedCases: CaseRecord[] = [];

/**
 * 指纹的字符口径：Σ(长度 + 1)。
 *
 * 那个 +1 不是笔误 —— 没有它的话「1 块 10 字」和「2 块 9 字」会撞成同一个指纹，
 * 于是改一个字但总字数不变的操作（比如把两行合并成一行）不会触发重建。
 *
 * 抽成一个函数是因为现在有【三个地方】要按这个口径算数：
 * fingerprintOf（真实行）、corpusFingerprint（便宜版）、以及 SQLite 里那条 SQL。
 * 前两个共用它就保证了口径一致；第三个靠注释对齐（见 storage.getChunksFingerprint）。
 */
function charsFingerprint(parts: Array<string | undefined>): number {
  let total = 0;
  for (const p of parts) total += (p || '').length + 1;
  return total;
}

function fingerprintOf(rows: CorpusRow[]): string {
  return `${rows.length}:${charsFingerprint(rows.map((r) => r.content))}`;
}

/** 取语料行（关键词索引与语义路共用同一份缓存） */
async function loadCorpus(): Promise<CorpusRow[]> {
  await getKeywordIndex(); // 顺带保证缓存已就绪
  return cachedRows;
}

/**
 * 取经验库案例（已验证的）。读失败不抛 —— 经验库坏了不该让整个问答不可用。
 * 门禁（draft 不进召回池）在 indexableCases 里落地，只此一处。
 *
 * 导出给 rag：它需要知道每条案例的【结果】才能把「成功经验」与「失败记录」在上下文里
 * 分开标注 —— 只靠 docId 前缀得知「这是案例」，得知不了「这条能不能照做」，而后者才是
 * 决定模型该不该推荐它的依据。
 *
 * 刻意用【异步重读】而不是导出一个同步的缓存读取器：多一次 SELECT 的代价可以忽略，
 * 但同步读缓存会引入「调用时序不对时拿到空数组」的假设 —— 那种情况下 outcome 全是
 * undefined，失败记录会被静默退回「已验证案例」的老样子，正好是这次要修的 bug。
 */
export async function listIndexableCases(): Promise<CaseRecord[]> {
  return loadCaseCorpus();
}

async function loadCaseCorpus(): Promise<CaseRecord[]> {
  try {
    cachedCases = indexableCases(await listVerifiedCases());
  } catch (e) {
    console.warn('[检索] 经验库读取失败，本次问答不含案例：', (e as any)?.message || e);
    cachedCases = [];
  }
  return cachedCases;
}

/**
 * 语料指纹（便宜版）—— 只回一个字符串，不把正文拉回内存。
 *
 * 为什么值得单开一个函数：缓存失效判定只需要「块数:总字数」这两个数字，
 * 而以前为了得到它们，得先把全部 chunk 正文（几 MB）JOIN 出来传一遍再在 JS 里累加 ——
 * 每次提问都付这笔钱，纯粹是为了决定「要不要重建」。
 * 文档部分交给 SQLite 聚合（见 storage.getChunksFingerprint），案例部分本来就在内存里。
 *
 * 口径必须与 fingerprintOf() 完全一致：Σ(长度 + 1)。
 */
async function corpusFingerprint(): Promise<string> {
  const d = await getChunksFingerprint();
  const cases = await loadCaseCorpus();
  // caseToText 的第二个参数刻意不传：caseCorpusRow 建行时也是这么调的，口径要一致
  const caseChars = charsFingerprint(cases.map((c) => caseToText(c)));
  return `${d.count + cases.length}:${d.chars + caseChars}`;
}

/**
 * 取（必要时重建）关键词索引。语料指纹变了就重建。
 *
 * 经验库案例以 `case:<id>` 的虚拟 docId 拼进同一份语料 —— 于是：
 *   · 案例走的是同一套 BM25 与同一套缓存，零新增检索代码
 *   · 案例计入指纹（块数:总字数）→ 记一条新案例会自动触发重建，不需要任何额外的失效调用
 *
 * 命中缓存的路径只读两个数字，不碰正文；只有真要重建时才拉全量。
 */
export async function getKeywordIndex(): Promise<KeywordIndex> {
  if (cachedIndex && cachedFingerprint === (await corpusFingerprint())) return cachedIndex;

  const docRows = (await getAllChunksForIndex()) as CorpusRow[];
  const cases = await loadCaseCorpus();
  const rows: CorpusRow[] = [...docRows, ...cases.map(caseCorpusRow)];
  cachedRows = rows;
  // 落库用【真实行】算出的指纹，而不是上面那个轻量指纹：
  // 轻量指纹与下面这次查询之间语料可能又变了（导入刚完成就是这种时刻），
  // 用轻量值当缓存键的话，缓存会记着一个不属于当前行的值，之后就再也不会失效。
  cachedFingerprint = fingerprintOf(rows);
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
  cachedCases = [];
}

async function getVectorIndex() {
  if (cachedVectors) return cachedVectors;
  cachedVectors = await getEmbeddings();
  return cachedVectors;
}

/** 文档名 / 案例名实时回填。名字刻意不进缓存 —— 改名要立刻生效 */
async function docNameMap(): Promise<Map<string, string>> {
  const docs = await getDocuments();
  const m = new Map(docs.map((d) => [d.id, d.name]));
  for (const c of await loadCaseCorpus()) m.set(caseDocId(c.id), caseDisplayName(c));
  return m;
}

/**
 * 关键词检索（BM25）。签名与旧的 storage.searchChunks 一致，调用方无感。
 *   · query   查询原文，支持中文整句（内部自动分词）
 *   · docIds  限定检索范围；显式传空数组 = 范围为空 = 无结果
 *
 * 范围里会额外并入案例的虚拟 id：「仅钉住文档 / 仅某标签」限制的是【资料】，
 * 而案例是用户自己的实测经验 —— 范围收窄时恰恰最该看到它。
 * 被静默排除的症状是「案例记了却没生效」，非常难查，所以这里显式放开。
 */
export async function searchChunks(
  query: string,
  limit = 8,
  opts?: { docIds?: string[] }
): Promise<KeywordHit[]> {
  if (!(query || '').trim()) return [];
  const idx = await getKeywordIndex();
  const scope = opts?.docIds ? [...opts.docIds, ...cachedCases.map((c) => caseDocId(c.id))] : undefined;
  const hits = idx.search(query, limit, scope);
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

  // 2) 正文片段命中 + 经验库案例命中
  //    案例就在同一份语料里（虚拟 docId = case:<id>），所以这里只需按 id 前缀分个类，
  //    不需要为「搜案例」再写一套检索。
  const chunkHits = await searchChunks(query, limit);
  for (const c of chunkHits) {
    const isCase = isCaseDocId(c.docId);
    out.push({
      kind: isCase ? 'case' : 'chunk',
      docId: c.docId,
      docName: c.docName,
      pageNo: isCase ? undefined : c.pageNo,
      snippet: c.content,
      score: c.score,
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
