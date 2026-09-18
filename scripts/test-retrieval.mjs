/**
 * 检索质量离线对比：旧实现（整句 includes）vs 新实现（BM25 + 中文分词 + 逻辑行切块）
 *
 * 用法：
 *   node scripts/test-retrieval.mjs /tmp/nas-out.json
 *   node scripts/test-retrieval.mjs /tmp/left.txt
 *
 * 目的是拿真实 TDS 文本回答两个问题：
 *   1) 修复后「中文整句提问」能不能搜到？
 *   2) 哪些问法仍然搜不到？—— 那些就是必须上向量语义层的证据。
 *
 * 注意：这里用的是 src/lib 下【真实的】chunkText / KeywordIndex，
 * 不在脚本里另抄一份逻辑，否则测的和跑的不是同一套。
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

// Node 默认不认「无扩展名导入」，按 Metro 的约定补全（.ts / .tsx / index）
register(
  'data:text/javascript,' +
    encodeURIComponent(`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, nextResolve) {
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

const { chunkText } = await import('../src/lib/chunk.ts');
const { KeywordIndex, tokenize } = await import('../src/lib/keyword.ts');

const FILE = process.argv[2] || '/tmp/nas-out.json';

function loadText(path) {
  const raw = readFileSync(path, 'utf8');
  if (path.endsWith('.json')) return JSON.parse(raw).text || '';
  return raw;
}

const text = loadText(FILE);
if (!text) {
  console.error(`没能从 ${FILE} 读到文本`);
  process.exit(1);
}

// 真实切块（与 App 导入时走的是同一个函数）
const chunks = chunkText(text).map((c) => ({
  id: c.id, docId: 'd1', docName: 'TDS', content: c.content,
}));

// ---------- 旧实现：query.split(/\s+/) 后逐词 includes，score = 命中词数 ----------
function legacySearch(query, limit = 3) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return [];
  return chunks
    .map((c) => {
      const t = c.content.toLowerCase();
      let s = 0;
      for (const x of terms) if (t.includes(x)) s++;
      return { c, s };
    })
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((r) => r.c);
}

// ---------- 新实现：BM25 + 中文 bigram ----------
const idx = new KeywordIndex(chunks);
const newSearch = (query, limit = 3) => idx.search(query, limit);

// ---------- 测试问句：模拟真实问法（不照抄原文措辞）----------
const QUERIES = [
  ['适用期是多长时间', '原文写「适用期」，问句是整句中文'],
  ['这个树脂的粘度是多少', '口语化长问句'],
  ['固化剂配比是多少', '部分字面命中'],
  ['弯曲强度能到多少', '原文有「弯曲强度」'],
  ['混合比例', '原词照抄（基线，应当排最前）'],
  ['ISO 3219', '标准号（含数字）'],
  ['CY1578', '产品型号（无分隔符写法）'],
  ['CY-1578 的粘度', '型号 + 术语混排'],
  ['保质期', '字面命中（原文有「保质期」）'],
  ['有效期是多久', '★ 换说法：原文无「有效期」三字'],
  ['存放条件有什么要求', '★ 换说法：原文写「储存条件」'],
  ['这个材料耐不耐化学腐蚀', '★ 换说法：原文写「耐化学腐蚀性能」'],
];

const cut = (s, n = 64) => (s || '').replace(/\n/g, ' / ').slice(0, n);

console.log(`\n语料：${FILE}`);
console.log(`切块：${chunks.length} 块（共 ${text.length} 字）`);
console.log('\n切块结果预览：');
chunks.forEach((c, i) => console.log(`  [${i}] ${cut(c.content, 50)}`));

console.log('\n分词示例：');
for (const q of ['适用期是多长时间', 'CY-1578 的粘度', 'ISO 3219']) {
  console.log(`  「${q}」→ ${JSON.stringify(tokenize(q, 'query'))}`);
}

let legacyFail = 0;
let newFail = 0;
const semanticOnly = [];

for (const [q, note] of QUERIES) {
  const oldHits = legacySearch(q);
  const newHits = newSearch(q);
  if (!oldHits.length) legacyFail++;
  if (!newHits.length) {
    newFail++;
    semanticOnly.push(q);
  }

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`问：「${q}」   （${note}）`);
  console.log(`  旧实现：${oldHits.length ? `${oldHits.length} 条命中` : '❌ 0 条 —— 搜不到'}`);
  if (oldHits.length) console.log(`          top1: ${cut(oldHits[0].content)}`);
  console.log(`  新实现：${newHits.length ? `${newHits.length} 条命中` : '❌ 0 条 —— 搜不到'}`);
  if (newHits.length) {
    console.log(`          top1: [分 ${newHits[0].score}] 命中词 ${JSON.stringify(newHits[0].matched)}`);
    console.log(`                ${cut(newHits[0].content)}`);
  }
}

console.log(`\n══════════════════════════════════════════════`);
console.log(`旧实现搜不到：${legacyFail}/${QUERIES.length}`);
console.log(`新实现搜不到：${newFail}/${QUERIES.length}`);
if (semanticOnly.length) {
  console.log(`\n仍搜不到 → 需要向量语义层兜底：`);
  for (const q of semanticOnly) console.log(`  · ${q}`);
}
