/**
 * 问答检索链路（rag.retrieve）的离线契约测试
 *
 * 为什么需要：retrieve() 在问答主路径上，且这次改成了「多路召回 + RRF 融合 + 钉住预留名额」，
 * 逻辑最容易在这里出问题。它本身不碰数据库，但 import 了 storage —— 所以这里用
 * resolve hook 把 './storage' 换成内存 stub，就能在 Node 里直接跑真实的 rag.retrieve。
 *
 * 用法：node --no-warnings scripts/test-rag.mjs
 */
import { register } from 'node:module';

// 内存版 storage：只实现 rag/retrieval 用到的那几个函数
const STUB = `
export const __docs = [];
export const __chunks = [];
export const __embs = [];
export async function getAllChunksForIndex() { return __chunks; }
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
`;
const STUB_URL = 'data:text/javascript,' + encodeURIComponent(STUB);

// 内存版 embedding：不发网络请求，查询向量由 globalThis.__queryVec 指定
const EMBED_STUB = `
export function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
export async function embedTexts(texts, opts) {
  const v = globalThis.__queryVec;
  if (!opts?.endpoint || !v) return null;
  return { vectors: texts.map(() => v), model: 'stub-embed', dim: v.length };
}
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

const storage = await import(STUB_URL);
const { retrieve, buildContext } = await import('../src/lib/rag.ts');
const { invalidateRetrievalIndex } = await import('../src/lib/retrieval.ts');

// ---- 语料：一页 TDS 拆成逻辑行 + 一份不相关的文档 ----
storage.__docs.push(
  { id: 'd1', name: 'Araldite CY1578 TDS', type: 'pdf', tags: [], status: 'indexed', meta: {}, createdAt: '1' },
  { id: 'd2', name: 'HY1578 固化剂说明书', type: 'pdf', tags: [], status: 'indexed', meta: {}, createdAt: '2' }
);
storage.__chunks.push(
  { id: 'd1c1', docId: 'd1', seq: 0, content: '混合粘度（25°C） mPa·s 1200 ISO 3219' },
  { id: 'd1c2', docId: 'd1', seq: 1, content: '弯曲强度 MPa 118 ISO 178' },
  { id: 'd1c3', docId: 'd1', seq: 2, content: '储存条件：原包装密封，存放于 5-25°C 阴凉干燥处。保质期自生产日期起 24 个月。' },
  { id: 'd2c1', docId: 'd2', seq: 0, content: '固化剂 HY1578 的推荐用量为树脂重量的 80 份。' },
  { id: 'd2c2', docId: 'd2', seq: 1, content: '混合时请充分搅拌 3 分钟，注意放热。' }
);

const results = [];
const check = (name, ok, extra = '') => {
  results.push([name, ok, extra]);
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `　${extra}` : ''}`);
};

console.log('\n──────── 1) 基本召回：中文整句提问 ────────');
{
  const hits = await retrieve('这个树脂的粘度是多少', { topK: 3 });
  console.log(hits.map((h) => `  [${h.score}] ${h.content}`).join('\n'));
  check('整句中文能召回', hits.length > 0);
  check('top1 命中粘度那一行', (hits[0]?.content || '').includes('混合粘度'), `← ${hits[0]?.content?.slice(0, 30)}`);
  check('命中的块带 docName（用于引用卡）', !!hits[0]?.docName);
  check('非相关文档不出现', !hits.some((h) => h.docId === 'd2' && !h.content.includes('固化')));
}

console.log('\n──────── 2) 钉住文档：查询不相关也必须出现 ────────');
{
  const hits = await retrieve('弯曲强度', { topK: 4, pinnedDocIds: ['d2'] });
  console.log(hits.map((h) => `  [${h.score}]${h.pinned ? ' 📌' : ''} ${h.content}`).join('\n'));
  check('钉住的文档进入了结果', hits.some((h) => h.docId === 'd2' && h.pinned));
  check('钉住块被标记 pinned', hits.filter((h) => h.pinned).length > 0);
  check('查询命中的块同时保留', hits.some((h) => h.content.includes('弯曲强度')));
}

console.log('\n──────── 3) 检索范围限定 ────────');
{
  const only2 = await retrieve('粘度 固化剂', { topK: 4, docIds: ['d2'] });
  console.log(only2.map((h) => `  [${h.score}] ${h.content}`).join('\n'));
  check('限定 d2 时结果只来自 d2', only2.length > 0 && only2.every((h) => h.docId === 'd2'));

  const none = await retrieve('粘度', { topK: 4, docIds: [] });
  check('范围显式为空 → 无结果（「只用钉住的」且没钉的语义）', none.length === 0);

  const pinnedOnly = await retrieve('粘度', { topK: 4, docIds: [], pinnedDocIds: ['d1'] });
  check('范围为空但有钉住 → 只出钉住内容', pinnedOnly.length > 0 && pinnedOnly.every((h) => h.pinned));
}

console.log('\n──────── 4) 边界 ────────');
{
  const empty = await retrieve('', { topK: 4 });
  check('空查询不崩、不返回关键词结果', empty.length === 0);

  const noHit = await retrieve('完全不存在的词xyzzy', { topK: 4 });
  check('无命中时返回空数组（不抛错）', Array.isArray(noHit) && noHit.length === 0);

  const limited = await retrieve('固化 粘度 混合 强度', { topK: 2 });
  check('topK 生效', limited.length <= 2, `实际 ${limited.length} 条`);

  const ctx = buildContext(await retrieve('粘度', { topK: 2 }));
  check('buildContext 产出带编号的引用上下文', ctx.includes('[来源1]'));
}

console.log('\n──────── 5) 语义路 + RRF 融合 ────────');
{
  // 「有效期是多久」在语料里零字面重叠（原文写「保质期」）—— 这正是关键词层搜不到的那句，
  // 语义路存在的唯一理由。这里用假向量把「语义相近」这件事固定下来，验融合逻辑而非模型精度。
  storage.__embs.push(
    { chunkId: 'd1c1', docId: 'd1', vec: Float32Array.from([0, 1, 0]) },
    { chunkId: 'd1c2', docId: 'd1', vec: Float32Array.from([0, 1, 0]) },
    { chunkId: 'd1c3', docId: 'd1', vec: Float32Array.from([0.99, 0.1, 0]) },
    { chunkId: 'd2c1', docId: 'd2', vec: Float32Array.from([0, 1, 0]) },
    { chunkId: 'd2c2', docId: 'd2', vec: Float32Array.from([1, 0]) } // 2 维脏向量：模拟换过模型
  );
  globalThis.__queryVec = [1, 0, 0];
  invalidateRetrievalIndex();

  const kwOnly = await retrieve('有效期是多久', { topK: 4 });
  check('未配嵌入时这句话捞不到（向量层的存在理由）', kwOnly.length === 0, `实际 ${kwOnly.length} 条`);

  const hy = await retrieve('有效期是多久', { topK: 4, embedding: { endpoint: 'http://stub-embed' } });
  console.log(hy.map((h) => `  [${h.score}] ${h.from?.join('+')} ${h.content.slice(0, 28)}`).join('\n'));
  check('配上嵌入后捞到了（语义路生效）', hy.length > 0, `${hy.length} 条`);
  check('top1 正是讲保质期那条', (hy[0]?.content || '').includes('保质期'), hy[0]?.content?.slice(0, 20));
  check('结果标注了来源 semantic', hy.some((h) => h.from?.includes('semantic')));
  check('维度对不上的脏向量被跳过（不崩、不入选）', !hy.some((h) => h.id === 'd2c2'));

  // 两路都命中时，同一块应被两路共同加分（RRF 的融合点）
  globalThis.__queryVec = [0, 1, 0];
  const both = await retrieve('弯曲强度', { topK: 4, embedding: { endpoint: 'http://stub-embed' } });
  console.log(both.map((h) => `  [${h.score}] ${h.from?.join('+')} ${h.content.slice(0, 28)}`).join('\n'));
  check('两路都命中时 top1 来自两路（RRF 融合）', (both[0]?.from?.length || 0) >= 2, both[0]?.from?.join('+'));

  // 嵌入服务挂掉不能拖垮问答：状态标志关掉后，语义路失败应被吞掉
  globalThis.__queryVec = null;
  const soft = await retrieve('弯曲强度', { topK: 4, embedding: { endpoint: 'http://stub-embed' } });
  check('嵌入服务异常时静默退回纯关键词', soft.length > 0 && soft[0]?.from?.includes('keyword'), soft[0]?.from?.join('+'));
}

console.log('\n══════════════════════════════════════════════');
const bad = results.filter(([, ok]) => !ok).length;
console.log(`通过 ${results.length - bad}/${results.length}`);
process.exit(bad ? 1 : 0);
