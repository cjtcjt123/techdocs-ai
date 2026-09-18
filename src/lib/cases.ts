// 个人经验库（案例）纯逻辑层 —— 无 IO，Node 可直接 import 验证
//
// 为什么单开一个文件（而不是散进 storage / retrieval）：
//   1) 与 keyword.ts / chunk.ts 同一条规矩 —— 纯函数单独成文件，离线脚本才能直接跑真实逻辑，
//      而不是在测试里重抄一遍（重抄的测试永远是通过的）
//   2) 「案例长什么样、怎么变成可检索文本」是这个功能的契约，改它要能被一眼找到
import type { CaseRecord, CaseOutcome, CaseInput } from '../types';

/**
 * 案例在检索语料里的身份。
 *
 * 案例不是文档，但必须和文档共用同一套 BM25 索引 —— 否则「搜得到」这件事要写两遍，
 * 而且两套打分的分数量纲不同、根本无法融合。
 * 做法：给每条案例编一个 `case:<id>` 的虚拟 docId，塞进同一份语料。
 * 附带好处：索引缓存指纹（块数:总字数）会自动把它算进去 → 记一条新案例会自动触发重建，
 * 不需要任何额外的「失效」调用（这正是最容易漏、且症状为「新案例搜不到」的地方）。
 */
export const CASE_PREFIX = 'case:';
export const caseDocId = (id: string) => `${CASE_PREFIX}${id}`;
export const isCaseDocId = (docId?: string) => !!docId && docId.startsWith(CASE_PREFIX);
export const caseIdOf = (docId: string) => (docId || '').slice(CASE_PREFIX.length);

export const OUTCOME_LABEL: Record<CaseOutcome, string> = {
  success: '成功',
  partial: '部分成功',
  fail: '失败',
};

/** 结果 → 语义色档。复用 theme 的 verdictColor，避免各处自己挑颜色 */
export const OUTCOME_VERDICT: Record<CaseOutcome, 'ok' | 'warn' | 'no'> = {
  success: 'ok',
  partial: 'warn',
  fail: 'no',
};
export const VERDICT_TO_OUTCOME: Record<'ok' | 'warn' | 'no', CaseOutcome> = {
  ok: 'success',
  warn: 'partial',
  no: 'fail',
};

export const OUTCOMES: CaseOutcome[] = ['success', 'partial', 'fail'];

/**
 * 案例 → 可检索文本。
 *
 * 三个刻意的选择：
 *   · 字段名（「根因」「最终解决」）原样写进文本 —— 用户问「根因是什么」时也该命中；
 *     只拼值的话，「根因」这个词在语料里根本不存在
 *   · 带上「已验证案例」这四个字 —— 它让模型在上下文里一眼看出这条的来源性质
 *   · 带上记录日期 —— 回答里要能说「根据你 08-12 的记录」，日期必须进上下文
 */
export function caseToText(c: CaseRecord, withMeta = true): string {
  const lines: string[] = [];
  lines.push(`【已验证案例】${c.title || '(未命名)'}`);
  const envBits = [c.product && `产品/型号：${c.product}`, c.environment && `环境：${c.environment}`]
    .filter(Boolean)
    .join('｜');
  if (envBits) lines.push(envBits);
  if (c.problem) lines.push(`现象：${c.problem}`);
  if (c.rootCause) lines.push(`根因：${c.rootCause}`);
  lines.push(`最终解决：${c.finalFix}`);
  lines.push(`结果：${OUTCOME_LABEL[c.outcome] || c.outcome}`);
  if (c.notes) lines.push(`注意：${c.notes}`);
  if (c.tags?.length) lines.push(`标签：${c.tags.join(' ')}`);
  if (withMeta && (c.occurredAt || c.createdAt)) {
    lines.push(`记录时间：${(c.occurredAt || c.createdAt || '').slice(0, 10)}`);
  }
  return lines.join('\n');
}

export interface CaseCorpusRow {
  id: string;
  docId: string;
  content: string;
  pageNo?: number;
}

/**
 * 案例 → 检索语料行。
 * 一条案例就是一行（不切块）：案例本身只有几百字，与 chunk 量级相当；
 * 切成多行会让同一条案例占掉多个召回名额，等于暗中放大它的权重。
 */
export function caseCorpusRow(c: CaseRecord): CaseCorpusRow {
  const docId = caseDocId(c.id);
  return { id: docId, docId, content: caseToText(c), pageNo: undefined };
}

/** 检索命中时显示在来源卡上的名字 */
export function caseDisplayName(c: CaseRecord): string {
  return `案例 · ${c.title || '(未命名)'}`;
}

/** 只把「已验证」的案例交出去建索引 —— 门禁在此处落地，只此一处 */
export function indexableCases(all: CaseRecord[]): CaseRecord[] {
  return (all || []).filter((c) => c && c.verified && !!c.finalFix);
}

/** 排序：先按发生时间、再看记录时间，新的在前（经验库列表与召回池共用） */
export function sortCases(all: CaseRecord[]): CaseRecord[] {
  return [...(all || [])].sort((a, b) => {
    const ka = (a.occurredAt || a.createdAt || '').slice(0, 19);
    const kb = (b.occurredAt || b.createdAt || '').slice(0, 19);
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
}

export function caseStats(all: CaseRecord[]): { total: number; success: number; partial: number; fail: number } {
  const r = { total: 0, success: 0, partial: 0, fail: 0 };
  for (const c of all || []) {
    r.total++;
    if (c.outcome === 'success') r.success++;
    else if (c.outcome === 'partial') r.partial++;
    else if (c.outcome === 'fail') r.fail++;
  }
  return r;
}

/** 标签统计（经验库筛选条用） */
export function caseTagCounts(all: CaseRecord[]): Array<{ tag: string; n: number }> {
  const m = new Map<string, number>();
  for (const c of all || []) for (const t of c.tags || []) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || (a.tag < b.tag ? -1 : 1));
}

export interface CaseFilter {
  /** 按结果筛；'all' 或省略 = 不筛 */
  outcome?: CaseOutcome | 'all';
  /** 只看「未参与检索」的那些（草稿 / 已被手动停用的） */
  onlyUnverified?: boolean;
  /** 关键词：标题 / 现象 / 根因 / 最终解决 / 标签，任一命中即可 */
  q?: string;
}

/**
 * 经验库列表的筛选。抽成纯函数是为了能离线测 —— 它决定「用户以为筛掉了、其实还在」，
 * 而这种错误在界面上完全看不出来（列表看着变短了，但你不知道少的是哪条）。
 */
export function filterCases(all: CaseRecord[], f: CaseFilter): CaseRecord[] {
  const q = (f?.q || '').trim().toLowerCase();
  return (all || []).filter((c) => {
    if (f?.outcome && f.outcome !== 'all' && c.outcome !== f.outcome) return false;
    if (f?.onlyUnverified && c.verified) return false;
    if (!q) return true;
    const hay = [c.title, c.problem, c.rootCause, c.finalFix, c.product, c.environment, c.notes, (c.tags || []).join(' ')]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

/**
 * 经验库整库导出为 Markdown。
 *
 * 与 caseToText 的区别：那个是喂给检索的语料（去掉空行、字段顺序按召回效果排），
 * 这个是给人看的档案 —— 保留空行与列表结构，且带上「未参与检索」的标记，
 * 否则导出后根本分不清哪条是自己已经在用的。
 */
export function casesToMarkdown(list: CaseRecord[]): string {
  const lines: string[] = [`# 经验库（${(list || []).length} 条）`, '', `> 导出时间：${new Date().toLocaleString()}`, ''];
  (list || []).forEach((c, i) => {
    lines.push(`## ${i + 1}. ${c.title || '（未命名案例）'}`);
    lines.push('');
    lines.push(`- 结果：${OUTCOME_LABEL[c.outcome] || c.outcome}${c.verified ? '' : '（未参与检索）'}`);
    if (c.product) lines.push(`- 产品 / 型号：${c.product}`);
    if (c.environment) lines.push(`- 环境：${c.environment}`);
    if (c.problem) lines.push(`- 问题 / 现象：${c.problem}`);
    if (c.rootCause) lines.push(`- 根因：${c.rootCause}`);
    lines.push(`- 最终解决：${c.finalFix}`);
    if (c.notes) lines.push(`- 注意：${c.notes}`);
    if (c.tags?.length) lines.push(`- 标签：${c.tags.join('、')}`);
    lines.push(`- 记录时间：${(c.occurredAt || c.createdAt || '').slice(0, 10)}`);
    lines.push('');
  });
  return lines.join('\n');
}

/** 把逗号/顿号/空格分隔的标签串拆成数组（表单里就是一个输入框） */
export function parseTags(s: string): string[] {
  return [...new Set((s || '').split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean))];
}

/** 校验记录表单。返回第一条错误（null = 通过）。必填只有两项：最终解决 + 结果 */
export function validateCaseInput(input: Partial<CaseInput>): string | null {
  if (!(input.finalFix || '').trim()) return '请填写「最终怎么解决的」—— 这是案例最重要的字段';
  if (!input.outcome) return '请选择结果（成功 / 部分成功 / 失败）';
  if (!OUTCOMES.includes(input.outcome)) return '结果取值不合法';
  if ((input.finalFix || '').length > 8000) return '「最终解决」过长（上限 8000 字）';
  return null;
}

/**
 * 从一轮问答里生成记录草稿（纯规则拼装，不调模型）。
 *
 * 为什么不调模型起草：唯一真正有价值的字段是「最终怎么解决的」—— 那是用户在车间里干的事，
 * 模型编不出来；而问题与 AI 建议本来就在手上，直接拿即可。
 * 让模型写草稿只会让用户多读一段需要改的文字，还多花一次调用。
 */
export function draftFromTurn(question: string, aiAnswer: string): { title: string; problem: string; aiAdvice: string } {
  const q = (question || '').replace(/^【需求符合性检查】/, '').trim();
  const a = (aiAnswer || '').trim();
  return {
    title: q ? (q.length > 30 ? q.slice(0, 30) + '…' : q) : '（未填写问题）',
    problem: q,
    aiAdvice: a.length > 1200 ? a.slice(0, 1200) + '…' : a,
  };
}
