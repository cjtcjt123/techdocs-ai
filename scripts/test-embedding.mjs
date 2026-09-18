/**
 * 嵌入客户端（src/lib/embedding.ts）的契约测试
 *
 * 起一个本地 stub HTTP 服务，同时模拟两种真实存在的服务形状：
 *   · 本项目的 nas-parse：POST {base}/embed       {"texts":[...]} -> {"vectors":[[...]],"model","dim"}
 *   · OpenAI 兼容（云端 / Ollama）：POST {base}/embeddings  {"model","input"} -> {"data":[{"embedding":[...]}]}
 *
 * 验的是「探测与解析」这层逻辑，不是模型精度：
 *   1) 两种形状都能自动认出来，并把结果缓存（第二次不再试错）
 *   2) 没配地址 → 返回 null（静默降级，不抛错）
 *   3) 鉴权失败 → 抛错，且不再白试另一种形状
 *   4) 分批时维度不一致 → 抛错（防止中途换模型导致向量混用）
 *   5) 余弦相似度
 *
 * 用法：node --no-warnings scripts/test-embedding.mjs
 */
import { createServer } from 'node:http';
import { register } from 'node:module';

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

const { embedTexts, testEmbedding, cosine } = await import('../src/lib/embedding.ts');

// ---------------- stub 服务 ----------------
const hits = { nas: 0, openai: 0, bad: 0 };
// 依次弹出的维度，空了回落到 8。用来制造「同一服务前后两批维度不同」
// （注意不能用「全局固定一个别的维度」——那样每批都一样，反而验不出中途变化）
let dimQueue = [];
const nextDim = () => (dimQueue.length ? dimQueue.shift() : 8);

const vec = (n, seed) => Array.from({ length: n }, (_, i) => Math.round((seed + i) * 0.01 * 1000) / 1000);

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const url = req.url || '';

    if (url.startsWith('/nas/embed')) {
      hits.nas++;
      const texts = (JSON.parse(body || '{}').texts) || [];
      const dim = nextDim();
      return send(200, { vectors: texts.map((_, i) => vec(dim, i)), model: 'stub-bge-small-zh', dim });
    }

    if (url.startsWith('/openai/embeddings')) {
      hits.openai++;
      const parsed = JSON.parse(body || '{}');
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
      const dim = nextDim();
      return send(200, {
        model: parsed.model || 'stub-openai',
        data: inputs.map((_, i) => ({ embedding: vec(dim, i) })),
      });
    }

    if (url.startsWith('/auth/embed')) {
      hits.bad++;
      if ((req.headers.authorization || '') !== 'Bearer good') return send(401, { detail: '令牌不正确' });
      return send(200, { vectors: [vec(8, 1)], model: 'stub-auth', dim: 8 });
    }

    // /nothing/* ：两种形状都不存在
    send(404, { detail: 'not found' });
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const at = (p) => `http://127.0.0.1:${PORT}${p}`;

const results = [];
const check = (name, ok, extra = '') => {
  results.push([name, ok]);
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `　${extra}` : ''}`);
};

try {
  console.log('\n──────── 1) NAS 形状（{texts} -> {vectors}）────────');
  {
    const out = await embedTexts(['甲', '乙'], { endpoint: at('/nas') });
    check('返回向量', Array.isArray(out?.vectors) && out.vectors.length === 2, `${out?.vectors.length} 条`);
    check('维度解析正确', out?.dim === 8, String(out?.dim));
    check('模型名解析正确', out?.model === 'stub-bge-small-zh', out?.model);
    check('只打了一次请求（首次探测即命中）', hits.nas === 1, `nas 命中 ${hits.nas} 次`);

    const before = hits.nas;
    await embedTexts(['丙'], { endpoint: at('/nas') });
    check('形状已缓存，后续只走一条路径', hits.nas === before + 1 && hits.openai === 0, `nas=${hits.nas} openai=${hits.openai}`);
  }

  console.log('\n──────── 2) OpenAI 形状（{input} -> {data[].embedding}）────────');
  {
    const out = await embedTexts(['甲', '乙', '丙'], { endpoint: at('/openai'), model: 'stub-model' });
    check('返回向量', out?.vectors.length === 3, `${out?.vectors?.length} 条`);
    check('模型名回显', out?.model === 'stub-model', out?.model);
    check('自动探测到 openai 形状（先试 /embed 404 后成功）', hits.openai === 1, `openai=${hits.openai}`);
  }

  console.log('\n──────── 3) 静默降级与错误 ────────');
  {
    const none = await embedTexts(['甲'], { endpoint: '' });
    check('未配置地址 → 返回 null（不抛错）', none === null);

    const empty = await embedTexts([], { endpoint: at('/nas') });
    check('空文本 → 返回 null', empty === null);

    let threw = '';
    try {
      await embedTexts(['甲'], { endpoint: at('/nothing') });
    } catch (e) {
      threw = e.message;
    }
    check('两种形状都不存在 → 抛错并说明原因', /404|无法识别|不可用/.test(threw), threw.slice(0, 60));

    let authErr = '';
    try {
      await embedTexts(['甲'], { endpoint: at('/auth') });
    } catch (e) {
      authErr = e.message;
    }
    check('令牌错误 → 抛错（且不再白试另一种形状）', /401/.test(authErr), authErr.slice(0, 40));

    let okAuth = null;
    try {
      okAuth = await embedTexts(['甲'], { endpoint: at('/auth'), token: 'good' });
    } catch (e) {
      okAuth = { err: e.message };
    }
    check('正确令牌 → 成功', Array.isArray(okAuth?.vectors), okAuth?.err || '');
  }

  console.log('\n──────── 4) 分批与维度一致性 ────────');
  {
    const out = await embedTexts(['a', 'b', 'c', 'd', 'e'], { endpoint: at('/nas'), batchSize: 2 });
    check('分批后条数正确', out?.vectors.length === 5, `${out?.vectors?.length} 条`);

    dimQueue = [8, 4]; // 第一批 8 维，第二批 4 维 → 必须报错
    let dimErr = '';
    try {
      await embedTexts(['a', 'b', 'c', 'd'], { endpoint: at('/nas'), batchSize: 2 });
    } catch (e) {
      dimErr = e.message;
    }
    dimQueue = [];
    check('维度中途变化 → 抛错（防止混用模型）', /维度不一致/.test(dimErr), dimErr.slice(0, 50));
  }

  console.log('\n──────── 5) 余弦相似度 ────────');
  {
    check('同向 = 1', Math.abs(cosine([1, 0], [2, 0]) - 1) < 1e-9);
    check('正交 = 0', Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
    check('反向 = -1', Math.abs(cosine([1, 0], [-1, 0]) + 1) < 1e-9);
    check('零向量不炸（返回 0）', cosine([0, 0], [1, 1]) === 0);
    check('长度不等时按短的对齐（不炸）', typeof cosine([1, 2, 3], [1, 2]) === 'number');
  }

  console.log('\n──────── 6) 测试连接 ────────');
  {
    const ok = await testEmbedding({ endpoint: at('/nas') });
    check('testEmbedding 成功时报维度', ok.ok && ok.dim === 8, ok.message);
    const bad = await testEmbedding({ endpoint: '' });
    check('testEmbedding 未填地址时给出提示', !bad.ok && /没填/.test(bad.message), bad.message);
  }
} finally {
  server.close();
}

console.log('\n══════════════════════════════════════════════');
const failed = results.filter(([, ok]) => !ok).length;
console.log(`通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
