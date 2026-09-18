/**
 * 个人经验库（案例）离线契约测试
 *
 * 覆盖两件事：
 *   A) cases.ts 纯逻辑层（案例长什么样、怎么变成可检索文本、校验、门禁）
 *   B) 真实 rag.retrieve / retrieval.searchChunks 跑起来时，案例是不是真的进了召回池、
 *      真的排在原始资料前面、真的被标成「案例」，以及草稿是不是真的进不来
 *
 * B 部分用 resolve hook 把 './storage' 换成内存 stub（与 test-rag.mjs 同一手法），
 * 这样脚本里跑的是【真实的】融合与检索代码，而不是另抄一份逻辑。
 *
 * 用法：node --no-warnings scripts/test-cases.mjs
 */
import { register } from 'node:module';

// ---------- 内存版 storage（只实现检索链路用到的那几个函数）----------
const STUB = `
export const __docs = [];
export const __chunks = [];
export const __embs = [];
let __cases = [];
export function __setCases(list) { __cases = list; }
export function __getCases() { return __cases; }
export async function getAllChunksForIndex() { return __chunks; }
// 口径同 retrieval.ts 的 charsFingerprint（Σ(长度 + 1)）
export async function getChunksFingerprint() {
  let chars = 0;
  for (const c of __chunks) chars += (c.content || '').length + 1;
  return { count: __chunks.length, chars };
}
export async function getDocuments() { return __docs; }
export async function getEmbeddings(docIds) {
  if (docIds && docIds.length === 0) return [];
  const allow = docIds && docIds.length ? new Set(docIds) : null;
  return __embs.filter((e) => !allow || allow.has(e.docId));
}
export async function getChunksByDocs(docIds, limit = 12) {
  if (!docIds.length) return [];
  const allow = new Set(docIds);
  const nameById = new Map(__docs.map((d) => [d.id, d.name]));
  return __chunks
    .filter((c) => allow.has(c.docId))
    .slice(0, limit)
    .map((c) => ({ ...c, docName: nameById.get(c.docId) || '?' }));
}
// 检索层入口：门禁（只给已验证）在这一层之外由 indexableCases 强制，这里原样返回全部，
// 正是为了验证「即使 storage 把草稿也交出来，草稿也进不了召回池」。
export async function listVerifiedCases() { return __cases; }
export async function listCases() { return __cases; }
`;
const STUB_URL = 'data:text/javascript,' + encodeURIComponent(STUB);

const EMBED_STUB = `
export function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
export async function embedTexts() { return null; }
`;
const EMBED_URL = 'data:text/javascript,' + encodeURIComponent(EMBED_STUB);

register(
  'data:text/javascript,' +
    encodeURIComponent(`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const STUB_URL = ${JSON.stringify(STUB_URL)};
const EMBED_URL = ${JSON.stringify(EMBED_URL)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === './storage' || specifier === '../lib/storage') {
    return { url: STUB_URL, shortCircuit: true };
  }
  if (specifier === './embedding' || specifier === '../lib/embedding') {
    return { url: EMBED_URL, shortCircuit: true };
  }
  if (specifier.startsWith('.')) {
    const p = fileURLToPath(new URL(specifier, context.parentURL));
    if (!existsSync(p)) {
      for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
        if (existsSync(p + ext)) return nextResolve(specifier + ext, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
`)
);

const casesLib = await import('../src/lib/cases.ts');
const storage = await import(STUB_URL);
const retrieval = await import('../src/lib/retrieval.ts');
const rag = await import('../src/lib/rag.ts');

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fails.push(name + (extra ? `  → ${extra}` : ''));
}
function eq(name, got, want) {
  ok(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

const {
  CASE_PREFIX, caseDocId, isCaseDocId, caseIdOf, caseToText, caseCorpusRow,
  caseDisplayName, indexableCases, sortCases, caseStats, parseTags,
  validateCaseInput, draftFromTurn, OUTCOME_LABEL, OUTCOME_VERDICT,
  caseHeader, caseSourceLabel, finalFixLabel, casesToMarkdown,
} = casesLib;

// ---------- A) 纯逻辑层 ----------
ok('A1 虚拟 id 前缀', CASE_PREFIX === 'case:');
ok('A2 虚拟 id 往返', caseIdOf(caseDocId('abc')) === 'abc' && isCaseDocId(caseDocId('abc')));
ok('A3 普通文档 id 不被误判为案例', !isCaseDocId('d1') && !isCaseDocId(undefined));

const base = {
  id: 'c1',
  title: 'CY1578 混合料气泡',
  problem: '真空搅拌后浇注出现气泡',
  product: 'CY1578 / HY1578',
  environment: '25℃ 常温，真空度 -0.095MPa',
  finalFix: '升温 60℃ 抽真空 30 min，静置 5 min 后浇注',
  rootCause: '脱泡时间不足',
  outcome: 'success',
  notes: '脱泡少于 20 min 会复发',
  tags: ['气泡', '工艺'],
  verified: true,
  occurredAt: '2025-08-12T09:05:00.000Z',
  createdAt: '2025-08-12T10:00:00.000Z',
};

const text = caseToText(base);
ok('A4 文本带来源性质标记（成功档）', text.startsWith('【已验证案例 · 成功】'));
ok('A5 文本带字段名（问「根因」也该命中）', text.includes('根因：脱泡时间不足'));
ok('A6 文本带最终解决与结果', text.includes('最终解决：升温 60℃') && text.includes('结果：成功'));
ok('A7 文本带记录日期（回答要说「你 08-12 的记录」）', text.includes('记录时间：2025-08-12'));
ok('A8 空字段不产生空行', !/：\s*$/m.test(caseToText({ ...base, rootCause: undefined, notes: undefined })));

const row = caseCorpusRow(base);
eq('A9 语料行 id', row.id, 'case:c1');
eq('A10 语料行 docId', row.docId, 'case:c1');
ok('A11 语料行内容 = 可检索文本', row.content === text);
eq('A12 来源卡显示名', caseDisplayName(base), '案例 · CY1578 混合料气泡');

// 门禁：只有 verified 且填了最终解决才进召回池
const draft = { ...base, id: 'c2', verified: false };
const emptyFix = { ...base, id: 'c3', finalFix: '' };
const pool = indexableCases([base, draft, emptyFix]);
eq('A13 门禁：草稿与无方案记录被挡住', pool.length, 1);
eq('A14 门禁放行的是已验证那条', pool[0].id, 'c1');
eq('A15 门禁对空数组安全', indexableCases(undefined).length, 0);

eq('A16 校验：缺最终解决', validateCaseInput({ outcome: 'success' }), '请填写「最终怎么解决的」—— 这是案例最重要的字段');
eq('A17 校验：缺结果', validateCaseInput({ finalFix: 'x' }), '请选择结果（成功 / 部分成功 / 失败）');
eq('A18 校验：合法输入通过', validateCaseInput({ finalFix: 'x', outcome: 'fail' }), null);

const tags = parseTags('气泡、工艺, CY1578  气泡');
eq('A19 标签拆分与去重', tags.join('|'), '气泡|工艺|CY1578');

const sorted = sortCases([
  { ...base, id: 'old', occurredAt: '2025-01-01T00:00:00.000Z' },
  { ...base, id: 'new', occurredAt: '2026-01-01T00:00:00.000Z' },
  { ...base, id: 'mid', occurredAt: undefined, createdAt: '2025-06-01T00:00:00.000Z' },
]);
eq('A20 排序：按发生时间倒序', sorted.map((c) => c.id).join(','), 'new,mid,old');

const st = caseStats([base, { ...base, outcome: 'fail' }, { ...base, outcome: 'partial' }, draft]);
ok('A21 统计', st.total === 4 && st.success === 2 && st.fail === 1 && st.partial === 1, JSON.stringify(st));

const d = draftFromTurn('CY5192 混合料气泡怎么解决？', 'A'.repeat(2000));
eq('A22 草稿标题来自问题', d.title, 'CY5192 混合料气泡怎么解决？');
ok('A23 草稿的 AI 建议被截断', d.aiAdvice.length === 1201 && d.aiAdvice.endsWith('…'));
eq('A24 结果标签', OUTCOME_LABEL.fail, '失败');
eq('A25 结果 → 语义色档', OUTCOME_VERDICT.partial, 'warn');

// ---------- B) 真实检索链路 ----------
storage.__docs.push({ id: 'd1', name: 'HY1578 TDS' });
storage.__chunks.push({
  id: 'k1', docId: 'd1', seq: 0, ctype: 'para',
  content: '真空脱泡：建议 40 min，温度 60℃，静置后浇注可减少气泡。',
});
storage.__chunks.push({
  id: 'k2', docId: 'd1', seq: 1, ctype: 'para',
  content: '储存条件：密封避光，保质期自生产日期起 24 个月。',
});

const verifiedCase = { ...base };                       // 已验证
const failCase = { ...base, id: 'c9', title: '低温 15℃ 下同样操作失败', outcome: 'fail' };
const draftCase = { ...base, id: 'cDraft', title: '还没验证的气泡做法', verified: false };
storage.__setCases([verifiedCase, failCase, draftCase]);
retrieval.invalidateRetrievalIndex();

const idx = await retrieval.getKeywordIndex();
ok('B1 案例已进入关键词索引语料', idx.docs.length === 4, `docs=${idx.docs.length}（2 chunk + 2 已验证案例）`);

const hits = await retrieval.searchChunks('真空脱泡 气泡', 20);
const caseHits = hits.filter((h) => isCaseDocId(h.docId));
ok('B2 中文问句能命中经验库案例', caseHits.length >= 1, `hits=${JSON.stringify(hits.map((h) => h.docId))}`);
ok('B3 命中案例携带可读名字', caseHits.some((h) => (h.docName || '').startsWith('案例 · ')));
ok('B4 草稿（未验证）搜不到', !hits.some((h) => h.docId === caseDocId('cDraft')));

// 作用域例外：限定资料范围时案例仍应参与（「仅钉住文档」不该把经验库一起关掉）
const scoped = await retrieval.searchChunks('真空脱泡 气泡', 20, { docIds: ['d1'] });
ok('B5 限定资料范围时案例仍在', scoped.some((h) => isCaseDocId(h.docId)));

const merged = await rag.retrieve('真空脱泡 气泡', { topK: 8, docIds: ['d1'] });
const first = merged[0];
ok('B6 融合结果非空', merged.length > 0);
eq('B7 已验证案例排在原始资料之前', first?.kind, 'case');
ok('B8 案例带 case 路由标记', !!first?.from?.includes('case'));
eq('B9 案例命中携带 caseId', first?.caseId, 'c1');
ok('B10 原始资料也在结果里（案例不该挤掉文档）', merged.some((h) => h.kind === 'doc'));

const ctx = rag.buildContext(merged);
ok('B11 上下文把案例标成「你已验证的经验案例」', ctx.includes('【你已验证的经验案例】'));
ok('B12 上下文里文档仍是《》标注', ctx.includes('《HY1578 TDS》'));
ok('B13 上下文不带重复的「案例 · 」前缀', !ctx.includes('】案例 · '));

const quotes = rag.hitsToQuotes(merged);
const cq = quotes.find((q) => q.kind === 'case');
ok('B14 引用卡带 kind=case 与 caseId', !!cq && cq.caseId === 'c1');
ok('B15 引用卡片段来自案例正文', !!cq && cq.snippet.includes('最终解决'));

const all = await retrieval.searchAll('真空脱泡', 30);
ok('B16 全局搜索能搜到案例', all.some((r) => r.kind === 'case'));

// 无关查询不该把案例硬塞进来
const none = await rag.retrieve('保质期 多久', { topK: 8 });
ok('B17 无关查询不会把气泡案例塞进来', !none.some((h) => h.caseId === 'c1'));

// 兜底：经验库读崩了也不能让问答挂掉
storage.__setCases(undefined);
retrieval.invalidateRetrievalIndex();
let survived = true;
try {
  await rag.retrieve('真空脱泡', { topK: 4 });
} catch {
  survived = false;
}
ok('B18 经验库数据异常时问答不抛错', survived);

// ---------- C) 失败记录的分档标注 ----------
//
// 这一组是针对一个【真实存在过的缺陷】的回归：原来不管什么结果，caseToText 第一行
// 一律是「【已验证案例】」，而提示词又写着「案例优先级最高、两者冲突时以案例为准」——
// 于是一条「试过没成」的记录会戴着「你亲手验证过、以此为准」的身份进入之后的每一次问答，
// 模型把一条已被证伪的做法当成权威结论推荐出去。用户看不到提示词，只会觉得
// 「AI 怎么又让我照这个做，我明明记过它不行」。
const failOnly = { ...base, id: 'cF', title: '低温 15℃ 下同样操作失败', outcome: 'fail' };
const successText = caseToText(base);
const partialText = caseToText({ ...base, outcome: 'partial' });
const failText = caseToText(failOnly);

ok('C1 成功档头部', successText.startsWith('【已验证案例 · 成功】'));
ok('C2 部分成功单独一档', partialText.startsWith('【已验证案例 · 部分成功】'));
ok('C3 失败档头部写明「此路不通，不要照做」', failText.startsWith('【已验证案例 · 失败 · 此路不通，不要照做】'));
ok('C4 失败档不再与成功档共用头部', !failText.startsWith('【已验证案例】') && failText !== successText);
ok('C5 失败案例的字段名不是「最终解决」', !failText.includes('最终解决') && failText.includes('试过的做法（未成功）：'));
ok('C6 成功 / 部分成功仍用「最终解决」', successText.includes('最终解决：') && partialText.includes('最终解决：'));
ok('C7 结果字段照旧进文本（检索仍要能按结果命中）', failText.includes('结果：失败'));
ok('C8 outcome 缺失时退回中性头部，不误标失败', caseToText({ ...base, outcome: undefined }).startsWith('【已验证案例】'));

eq('C9 来源标签：成功', caseSourceLabel('success'), '你已验证的经验案例');
eq('C10 来源标签：部分成功', caseSourceLabel('partial'), '你已验证的经验案例（部分成功）');
eq('C11 来源标签：失败', caseSourceLabel('fail'), '你的失败记录（试过，没成）');
eq('C12 来源标签：outcome 缺失时不误标失败', caseSourceLabel(undefined), '你已验证的经验案例');
eq('C13 caseHeader 兜底', caseHeader(undefined), '【已验证案例】');

// 上下文拼装：成败两条同时出现时必须各标各的 —— 这是模型唯一能看到的依据
const ctxMix = rag.buildContext([
  { docId: caseDocId('c1'), docName: '案例 · CY1578 混合料气泡', content: successText, score: 1, kind: 'case', caseId: 'c1', outcome: 'success' },
  { docId: caseDocId('cF'), docName: '案例 · 低温 15℃ 下同样操作失败', content: failText, score: 1, kind: 'case', caseId: 'cF', outcome: 'fail' },
  { docId: 'd1', docName: 'HY1578 TDS', content: '真空脱泡：建议 40 min', score: 1, kind: 'doc' },
]);
ok('C14 上下文里成功案例标成「你已验证的经验案例」', ctxMix.includes('【你已验证的经验案例】'));
ok('C15 上下文里失败案例标成「你的失败记录（试过，没成）」', ctxMix.includes('【你的失败记录（试过，没成）】'));
ok('C16 成功标签只出现一次（没有串档）', (ctxMix.match(/【你已验证的经验案例】/g) || []).length === 1);
ok('C17 文档仍是《》标注，未被案例标签污染', ctxMix.includes('《HY1578 TDS》'));

// 真实链路：hit 必须带 outcome —— buildContext 的分档全靠它，掉了就静默退回老样子
storage.__setCases([base, failOnly]);
retrieval.invalidateRetrievalIndex();
const hits2 = await rag.retrieve('真空脱泡 气泡', { topK: 8, docIds: ['d1'] });
const hSucc = hits2.find((h) => h.caseId === 'c1');
const hFail = hits2.find((h) => h.caseId === 'cF');
ok('C18 真实召回里成功案例带 outcome=success', hSucc?.outcome === 'success', `got=${hSucc?.outcome}`);
ok('C19 真实召回里失败案例带 outcome=fail', hFail?.outcome === 'fail', `got=${hFail?.outcome}`);
ok('C20 真实召回的上下文里失败案例被标成「你的失败记录」', rag.buildContext(hits2).includes('【你的失败记录（试过，没成）】'));
ok(
  'C21 文档 hit 不带 outcome（只有案例有）',
  hits2.some((h) => h.kind === 'doc') && hits2.filter((h) => h.kind === 'doc').every((h) => h.outcome === undefined)
);

// 同一个字段名在【四个渲染点】必须一致：语料 / 导出档案 / 详情弹层 / 表单。
// 抽了 finalFixLabel() 就是为了别让它们分叉，这里把纯函数能覆盖的两个点钉住。
eq('C22 finalFixLabel 三档', [finalFixLabel('fail'), finalFixLabel('success'), finalFixLabel(undefined)].join('|'),
  '试过的做法（未成功）|最终解决|最终解决');
const mdFail = casesToMarkdown([failOnly]);
const mdOk = casesToMarkdown([base]);
ok('C23 导出档案里失败案例也不叫「最终解决」', mdFail.includes('- 试过的做法（未成功）：') && !mdFail.includes('- 最终解决：'));
ok('C24 导出档案里成功案例仍是「最终解决」', mdOk.includes('- 最终解决：'));
eq('C25 校验提示按结果分档（失败档不说「怎么解决的」）', validateCaseInput({ outcome: 'fail' }),
  '请填写「试过什么、后来怎样」—— 失败记录也有用，它拦住的是一次重复的失败');

// 引用卡：来源卡上的徽章据此换成「失败案例」，否则用户看不出 AI 引的是失败记录
const qAll = rag.hitsToQuotes(hits2);
const qFail = qAll.find((x) => x.caseId === 'cF');
ok('C26 引用卡带上 outcome（来源卡据此标「失败案例」）', qFail?.outcome === 'fail', `got=${qFail?.outcome}`);
ok('C27 引用卡里的文档条目不带 outcome', qAll.filter((x) => x.kind === 'doc').every((x) => x.outcome === undefined));

// ---------- 汇总 ----------
const total = pass + fails.length;
console.log(`\n经验库契约测试：${pass}/${total}`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过 ✅');
