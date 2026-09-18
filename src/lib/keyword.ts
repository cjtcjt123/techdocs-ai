/**
 * 关键词检索层：中文友好分词 + BM25 打分
 *
 * 为什么需要它（旧实现的两个硬伤）：
 *   1) 分词：旧代码是 `query.split(/\s+/)` 后逐词 `content.includes(term)`。
 *      中文问句没有空格 → 整句变成一个 term。问「适用期是多长时间」时拿整句去 includes，
 *      正文写的是「适用期」三个字，永远匹配不上，等于搜不到。
 *   2) 打分：旧代码 score = 命中词数。问「树脂的粘度是多少」时，
 *      「的」「是」和「粘度」同权；同时完全忽略「粘度」在语料里很罕见（该重），
 *      以及长段落天然更容易命中（该罚）。
 *
 * 这里做两件事：
 *   · 分词 —— 不需要词库、零依赖的 CJK bigram 切分；拉丁/数字/型号整词保留，
 *     并额外产出「紧凑形式」（CY-1578 → cy1578），让型号书写差异也能对上。
 *   · 打分 —— BM25（IDF 加权 + 文档长度归一化）+ 整串短语加成。
 *
 * 索引侧与查询侧必须用同一套规则产 token，否则对不上：
 *   · 索引侧额外产出 CJK unigram，保证「苯」「胺」这类单字查询也能命中；
 *   · 查询侧只用 bigram（单字查询才退化为 unigram），避免单字噪声灌进打分。
 *   unigram 因 df 高、IDF 低，对排序的自然干扰很小。
 */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const WORD_RE = /[0-9a-z]/i;
// 词内分隔符：型号/单位里常见的连接符号（CY-1578、mPa·s、g/cm3、ISO_3219）
const SEP_SPLIT = /[-_\u00b7\u2010-\u2015\u2027/\\]+/;
const SEP_CHAR_RE = /[-_\u00b7\u2010-\u2015\u2027/\\]/;
// 全角 → 半角（FF01~FF5E 与 21~7E 逐码位对应）。手写映射，不依赖 String.normalize
// （Hermes 对 normalize 的支持不可靠，见 cjk-compat-table.ts 的同类处理）
const toHalfWidth = (s: string) => s.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

export type TokenizeMode = 'index' | 'query';

/** 把一段文本切成检索 token。索引侧与查询侧都用它，靠 mode 区分。 */
export function tokenize(text: string, mode: TokenizeMode = 'query'): string[] {
  if (!text) return [];
  const t = toHalfWidth(String(text).toLowerCase());
  const out: string[] = [];
  const n = t.length;
  let i = 0;

  while (i < n) {
    const ch = t[i];

    if (CJK_RE.test(ch)) {
      let j = i;
      while (j < n && CJK_RE.test(t[j])) j++;
      const run = t.slice(i, j);
      if (mode === 'index') {
        for (let k = 0; k < run.length; k++) out.push(run[k]);
        for (let k = 0; k + 2 <= run.length; k++) out.push(run.slice(k, k + 2));
      } else if (run.length === 1) {
        out.push(run);
      } else {
        for (let k = 0; k + 2 <= run.length; k++) out.push(run.slice(k, k + 2));
      }
      i = j;
      continue;
    }

    if (WORD_RE.test(ch) || SEP_CHAR_RE.test(ch)) {
      let j = i;
      while (j < n && (WORD_RE.test(t[j]) || SEP_CHAR_RE.test(t[j]))) j++;
      const run = t.slice(i, j);
      // 用分隔符切开：CY-1578 → [cy, 1578]；g/cm3 → [g, cm3]
      const parts = run.split(SEP_SPLIT).filter(Boolean);
      if (parts.length === 1) {
        out.push(parts[0]);
      } else if (parts.length > 1) {
        for (const p of parts) out.push(p);
        // 紧凑形式：让「CY-1578」「CY 1578」「CY1578」三种写法等价
        const compact = parts.join('');
        if (compact.length >= 2) out.push(compact);
      }
      i = j;
      continue;
    }

    // 标点、空白、括号等：不作 token
    i++;
  }

  return out;
}

/** 压成「只剩字母数字汉字」的紧凑串，用于整串短语命中加成（CY-1578 → cy1578） */
export function flatten(text: string): string {
  if (!text) return '';
  return toHalfWidth(String(text).toLowerCase()).replace(/[^0-9a-z\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, '');
}

// ------------------------------------------------------------------ BM25

export interface KeywordDoc {
  id: string;
  docId: string;
  docName: string;
  content: string;
  pageNo?: number;
}

export interface KeywordHit extends KeywordDoc {
  score: number;
  /** 命中的查询词（按 IDF 从高到低），用于解释「为什么这条被搜出来」 */
  matched: string[];
}

interface IndexedDoc {
  doc: KeywordDoc;
  tf: Map<string, number>;
  len: number;
  flat: string;
}

const K1 = 1.2; // BM25 词频饱和系数（标准值）
const B = 0.75; // BM25 长度归一化强度（标准值）
// 整串短语命中加成。BM25 分通常在 0~10 量级，这里给一个能明显抬升、又不至于
// 压过「多词命中」的固定值；型号/术语类精确查询靠它排到最前。
const PHRASE_BOOST = 2.5;

/**
 * 关键词索引。构建时一次性算好 tf / 长度 / df，之后每次查询只做打分。
 * 语料（手机本地资料库）规模在千级 chunk，全量内存索引完全够用。
 */
export class KeywordIndex {
  private docs: IndexedDoc[] = [];
  private df = new Map<string, number>();

  constructor(docs: KeywordDoc[]) {
    // 同一 chunk 被重复传入时去重（重名 key 会污染 df 统计）
    const seen = new Set<string>();
    const uniq = docs.filter((d) => {
      if (seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });

    this.df.clear();
    this.docs = uniq.map((doc) => {
      const tf = new Map<string, number>();
      const tokens = tokenize(doc.content, 'index');
      for (const tk of tokens) tf.set(tk, (tf.get(tk) || 0) + 1);
      for (const tk of tf.keys()) this.df.set(tk, (this.df.get(tk) || 0) + 1);
      return { doc, tf, len: tokens.length || 1, flat: flatten(doc.content) };
    });
  }

  get size() {
    return this.docs.length;
  }

  private idf(term: string): number {
    const N = this.docs.length;
    const df = this.df.get(term) || 0;
    // 未出现在语料中的词：给一个略高于最大值的常数，避免整条查询被打成 0 分
    if (df === 0) return Math.log(1 + (N + 0.5) / 0.5);
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  }

  /** 检索：返回按 BM25 分降序的命中（score 已归一到 0~1，便于 UI 展示） */
  search(query: string, limit = 10, docIds?: string[]): KeywordHit[] {
    const terms = tokenize(query, 'query');
    if (!terms.length || !this.docs.length) return [];
    // 显式传空数组 = 「限定范围为空」→ 无结果（与 storage.searchChunks 语义一致）
    if (docIds && docIds.length === 0) return [];
    const allow = docIds && docIds.length ? new Set(docIds) : null;

    const avgdl = this.docs.reduce((s, d) => s + d.len, 0) / this.docs.length;
    // 同一 token 在查询里重复出现时只算一次贡献（避免「粘度 粘度」被当成两倍权重）
    const uniqTerms = [...new Set(terms)];
    const termIdf = new Map<string, number>();
    for (const t of uniqTerms) termIdf.set(t, this.idf(t));
    const flatQuery = flatten(query);

    const hits: KeywordHit[] = [];
    for (const d of this.docs) {
      // 注意：过滤要用 docId（文档 id），不是 id（chunk id）—— 用错会让「限定检索范围」永远返回空
      if (allow && !allow.has(d.doc.docId)) continue;
      let score = 0;
      const matched: { t: string; idf: number }[] = [];

      for (const t of uniqTerms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const idf = termIdf.get(t) || 0;
        score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * d.len) / avgdl));
        matched.push({ t, idf });
      }
      if (score <= 0) continue;

      // 整串短语命中：型号（CY1578）、单位（mPa·s）、术语整词被查询原文照抄时加成
      if (flatQuery.length >= 2 && d.flat.includes(flatQuery)) score += PHRASE_BOOST;

      matched.sort((a, b) => b.idf - a.idf);
      hits.push({ ...d.doc, score, matched: matched.slice(0, 6).map((m) => m.t) });
    }

    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, limit);
    // 归一到 0~1（单调，不改变排序）：1 - 1/(1+score)
    for (const h of top) h.score = Math.round((1 - 1 / (1 + h.score)) * 1000) / 1000;
    return top;
  }
}
