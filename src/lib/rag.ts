// RAG 检索封装：多路召回 + RRF 融合 + 钉住文档强制带入
//
// 召回路（后续路数增加时，只需在 retrieve 里往 lists 里多塞一路，融合逻辑不用动）：
//   · case     —— 个人经验库（已验证案例）。与文档同在一份语料，但独立成路并给更高权重
//   · keyword  —— BM25 + 中文分词（retrieval.ts）。纯本地、零成本、永远在线
//   · semantic —— embedding 向量语义（需配好嵌入服务，连不上则静默缺席）
//
// 为什么要 RRF（Reciprocal Rank Fusion）而不是「加权求和分数」：
//   BM25 分是无上界的，余弦相似度是 0~1，两者量纲不同，硬加权需要拍脑袋定归一化系数，
//   换个语料就得重调。RRF 只依赖【排名】不依赖分数，天然免疫量纲问题，
//   且让「多路都排前面」的结果胜出 —— 这正是混合检索想要的。
import { searchChunks, semanticSearch } from './retrieval';
import { getChunksByDocs } from './storage';
import type { KeywordHit } from './keyword';
import { caseIdOf, isCaseDocId } from './cases';
import type { EmbeddingConfig } from './settings';

export interface Hit {
  docId: string;
  docName: string;
  content: string;
  pageNo?: number;
  score: number;
  pinned?: boolean; // 来自「钉住文档」，每次问答强制带入
  /** 命中该条的路（case / keyword / semantic），多路命中的排更前 */
  from?: string[];
  /** 'case' = 来自个人经验库（你亲手记录并验证过的），'doc' = 原始技术资料 */
  kind?: 'doc' | 'case';
  caseId?: string;
}

// 经验库案例的权重。高于原始资料是刻意的：文档说的是「理论上怎么做」，
// 案例说的是「你这里实际怎么做成功的」—— 后者才是可执行的那一层。
// 代价必须说清：这条权重是在赌「用户亲手填的案例是对的」。所以门禁是「只有 verified 进召回池」，
// 且回答里会显式标注来源性质，让人能一眼看出该不该信。
const CASE_WEIGHT = 2.5;
const DOC_WEIGHT = 1;

const toHit = (h: KeywordHit): Hit => {
  const isCase = isCaseDocId(h.docId);
  return {
    docId: h.docId,
    docName: h.docName,
    content: h.content,
    pageNo: h.pageNo,
    score: h.score,
    kind: isCase ? 'case' : 'doc',
    caseId: isCase ? caseIdOf(h.docId) : undefined,
  };
};

export interface RetrieveOpts {
  topK?: number; // 带几段上下文
  docIds?: string[]; // 限定检索范围（标签分组 / 仅钉住）；空 = 全部资料
  pinnedDocIds?: string[]; // 钉住的文档，无条件带入
  /** 嵌入服务配置；没配就只走关键词路（语义路静默缺席） */
  embedding?: EmbeddingConfig;
}

// RRF 里的平滑常数。原论文推荐 60：作用是压低头部名次的绝对优势，
// 让「在两条路里都排第 3」的结果胜过「只在一路里排第 1」的结果。
const RRF_K = 60;

interface RankedList {
  name: string;
  weight: number;
  hits: Hit[];
}

const hitKey = (h: { docId: string; content: string }) => `${h.docId}::${(h.content || '').slice(0, 80)}`;

/** RRF 融合：多路排名 → 单一排序（score 归一到 0~1，仅用于展示） */
function rrf(lists: RankedList[]): Hit[] {
  const acc = new Map<string, { hit: Hit; score: number; from: Set<string> }>();

  for (const list of lists) {
    list.hits.forEach((h, i) => {
      const k = hitKey(h);
      const add = list.weight / (RRF_K + i + 1);
      const cur = acc.get(k);
      if (cur) {
        cur.score += add;
        cur.from.add(list.name);
      } else {
        acc.set(k, { hit: h, score: add, from: new Set([list.name]) });
      }
    });
  }

  const rows = [...acc.values()].sort((a, b) => b.score - a.score);
  const max = rows[0]?.score || 1;
  return rows.map((r) => ({
    ...r.hit,
    score: Math.round((r.score / max) * 1000) / 1000,
    from: [...r.from],
  }));
}

// 给定查询，返回本地资料库中最相关的文本片段
export async function retrieve(query: string, opts?: RetrieveOpts): Promise<Hit[]> {
  const topK = opts?.topK && opts.topK > 0 ? opts.topK : 8;
  const pinnedIds = opts?.pinnedDocIds ?? [];
  const out: Hit[] = [];
  const seen = new Set<string>();

  const push = (h: Hit) => {
    const k = hitKey(h);
    if (seen.has(k)) return false;
    seen.add(k);
    out.push(h);
    return true;
  };

  // 1) 钉住文档：语义上是「必须出现」而非「相关」，所以不参与打分竞争，
  //    直接预留名额（约 1/3，至少 2 段），保证每次问答都带上
  let pinnedUsed = 0;
  if (pinnedIds.length) {
    const budget = Math.max(2, Math.ceil(topK / 3));
    const rows = await getChunksByDocs(pinnedIds, budget);
    for (const r of rows) {
      const ok = push({
        docId: r.docId, docName: r.docName, content: r.content,
        pageNo: r.pageNo, score: 1, pinned: true, from: ['pinned'],
      });
      if (ok) pinnedUsed++;
    }
  }

  // 2) 相关路召回。多取一些候选：RRF 是「先各自排名、再融合」，候选池太浅会
  //    让某一路的次优结果无辜出局
  const lists: RankedList[] = [];
  if ((query || '').trim()) {
    const kw = await searchChunks(query, Math.max(topK * 3, 20), { docIds: opts?.docIds });
    // 案例与文档来自同一次关键词召回（同一份语料），这里按虚拟 id 前缀拆成两路分别给权重。
    // 拆路的另一个好处：即便某条案例在整体 BM25 里排在第 30 位，它在「案例路」里的名次
    // 仍可能靠前 —— 等于让经验库内部先自己比一轮，再和文档比。
    const caseHits = kw.filter((h) => isCaseDocId(h.docId));
    const docHits = kw.filter((h) => !isCaseDocId(h.docId));
    if (caseHits.length) lists.push({ name: 'case', weight: CASE_WEIGHT, hits: caseHits.map(toHit) });
    if (docHits.length) lists.push({ name: 'keyword', weight: DOC_WEIGHT, hits: docHits.map(toHit) });
    // 语义路：换个说法也能搜到（「有效期」↔「保质期」这类字面无重叠的问法）
    // 三种情况会静默缺席，只走关键词：没配嵌入服务 / 还没建向量索引 / 服务调用失败。
    // 「检索挂了不该让问答失败」—— 所以这里吞异常，在控制台留一行便于排查。
    if (opts?.embedding?.endpoint) {
      try {
        const sem = await semanticSearch(query, Math.max(topK * 3, 20), {
          docIds: opts.docIds,
          embedding: opts.embedding,
        });
        if (sem.length) lists.push({ name: 'semantic', weight: DOC_WEIGHT, hits: sem.map(toHit) });
      } catch (e) {
        console.warn('[检索] 语义路不可用，本次只用关键词：', (e as any)?.message || e);
      }
    }
  }

  // 3) 融合后填满剩余名额（单路时等价于该路原顺序）
  const limit = topK + pinnedUsed;
  for (const h of rrf(lists)) {
    if (out.length >= limit) break;
    push(h);
  }

  return out;
}

// 把检索结果拼成带编号的上下文，供 LLM 引用
// 案例与资料必须长得不一样：模型要能一眼看出「这条是用户自己实测过的」，
// 才有可能在两者冲突时以案例为准（提示词里另有明文要求）。
export function buildContext(hits: Hit[]): string {
  if (hits.length === 0) return '（资料库暂无相关内容）';
  return hits
    .map((h, i) => {
      if (h.kind === 'case') {
        const title = (h.docName || '').replace(/^案例 · /, '');
        return `[来源${i + 1}] 【你已验证的经验案例】${title}\n${h.content}`;
      }
      return `[来源${i + 1}] 《${h.docName}》${h.pageNo ? `第${h.pageNo}页` : ''}${h.pinned ? '（钉住资料）' : ''}\n${h.content}`;
    })
    .join('\n\n');
}

// 把命中转成引用卡
export function hitsToQuotes(hits: Hit[]) {
  return hits.map((h) => ({
    docId: h.docId,
    docName: h.docName,
    pageNo: h.pageNo,
    snippet: h.content.slice(0, 160),
    // 命中路与分数要一起留痕：来源卡上标 案例 / KW / SEM 徽章 + 分数，
    // 才能回答「为什么是这条」—— 尤其是关键词没命中、靠语义兜住的那条。
    score: Math.round(h.score * 100) / 100,
    from: h.from,
    pinned: h.pinned,
    // 来源性质：来源卡据此换徽章，用户据此决定要不要直接照做
    kind: h.kind ?? 'doc',
    caseId: h.caseId,
  }));
}
