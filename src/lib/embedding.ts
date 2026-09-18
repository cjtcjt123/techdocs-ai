/**
 * 嵌入调用层：文本 → 向量，供「语义检索」那一路使用。
 *
 * 两种服务形状都认，填哪个地址都能用：
 *   · NAS 上的 nas-parse（默认）: POST {base}/embed
 *        body {"texts":[...]}  ->  {"vectors":[[...]], "model":..., "dim":...}
 *   · 云端 / 自托管 OpenAI 兼容: POST {base}/embeddings
 *        body {"model":..., "input":[...]}  ->  {"data":[{"embedding":[...]}]}
 *
 * 探测顺序是「先 NAS 形状、再 OpenAI 形状」，成功后把形状缓存到 endpoint 上，
 * 之后不再重复试错。网络层失败（连不上 / 超时）不切形状 —— 地址是同一个，换形状也一样连不上。
 *
 * 约定：
 *   · 没配置 endpoint → 返回 null（**不抛错**）。调用方据此静默退回纯关键词检索，
 *     与「方案 C」里文档解析「连不上 NAS 就用手机本地」是同一个套路。
 *   · 配置了但调用失败 → 抛错，由调用方决定是否吞掉降级。
 */
import type { EmbeddingConfig } from './settings';
import { assertOnline, confirmExternal } from './net-guard';

export interface EmbedResult {
  vectors: number[][];
  model: string;
  dim: number;
}

export interface EmbedTestResult {
  ok: boolean;
  message: string;
  dim?: number;
  model?: string;
}

export interface EmbedOpts extends EmbeddingConfig {
  /** 每批几条。NAS 上 CPU 推理，批太小浪费往返，太大容易超时 */
  batchSize?: number;
  timeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /** 「测试连接」用：只发一句探测文本、不含资料，故跳过「云端调用需确认」 */
  skipConfirm?: boolean;
}

type Kind = 'nas' | 'openai';

const joinPath = (base: string, path: string) => (base || '').replace(/\/+$/, '') + path;

// 每个 endpoint 上次成功的形状。避免每次调用都先失败一次。
const kindCache = new Map<string, Kind>();

/** 换个地址/模型后清掉形状缓存（设置页保存时调用） */
export function resetEmbeddingProbe() {
  kindCache.clear();
}

function authHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function explain(status: number, body: string): string {
  const brief = (body || '').slice(0, 200);
  switch (status) {
    case 400: return `请求被拒（400）：${brief || '参数格式不对'}`;
    case 401: return '令牌不正确（401）';
    case 403: return '令牌无权访问（403）';
    case 404: return '嵌入接口不存在（404）：确认地址填的是服务根路径（NAS 是 http://<ip>:8787，云端多为 .../v1）';
    case 413: return '单次提交的文本条数过多（413）';
    case 503: return `嵌入模型还没就绪（503）：${brief}`;
    default: return `嵌入服务返回 ${status}：${brief}`;
  }
}

async function postJson(url: string, body: unknown, token: string | undefined, timeoutMs: number, outer?: AbortSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  outer?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    return { res, text };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

function parseNasShape(text: string): EmbedResult | null {
  try {
    const d = JSON.parse(text);
    const vectors = d?.vectors;
    if (Array.isArray(vectors) && vectors.length && Array.isArray(vectors[0])) {
      return { vectors, model: String(d?.model || 'nas-parse'), dim: Number(d?.dim) || vectors[0].length };
    }
  } catch {
    /* 形状不符，交给下一种 */
  }
  return null;
}

function parseOpenAIShape(text: string, fallbackModel: string): EmbedResult | null {
  try {
    const d = JSON.parse(text);
    const data = d?.data;
    if (Array.isArray(data) && data.length && data.every((x: any) => Array.isArray(x?.embedding))) {
      const vectors = data.map((x: any) => x.embedding as number[]);
      return { vectors, model: String(d?.model || fallbackModel), dim: vectors[0].length };
    }
  } catch {
    /* 同上 */
  }
  return null;
}

/** 单批请求（内部用） */
async function embedBatch(
  texts: string[],
  cfg: EmbeddingConfig,
  endpoint: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<EmbedResult> {
  const cached = kindCache.get(endpoint);
  const order: Kind[] = cached ? [cached] : ['nas', 'openai'];
  let lastErr = '';

  for (const kind of order) {
    if (kind === 'openai' && !cfg.model) {
      // 没填模型名就走不了 OpenAI 形状（除非是从缓存里挑出来的）
      lastErr = lastErr || '云端嵌入需要填模型名（如 text-embedding-3-small）';
      continue;
    }

    let res: Response;
    let text: string;
    try {
      const r = await postJson(
        joinPath(endpoint, kind === 'nas' ? '/embed' : '/embeddings'),
        kind === 'nas' ? { texts } : { model: cfg.model, input: texts },
        cfg.token,
        timeoutMs,
        signal
      );
      res = r.res;
      text = r.text;
    } catch (e: any) {
      // 网络层失败：地址就一个，换形状也一样连不上 → 直接抛
      if (e?.name === 'AbortError') throw new Error(`嵌入请求超时（${Math.round(timeoutMs / 1000)}s）`);
      throw new Error(`连不上嵌入服务：${e?.message || e}`);
    }

    if (!res.ok) {
      lastErr = explain(res.status, text);
      // 鉴权问题换形状也没用
      if (res.status === 401 || res.status === 403) throw new Error(lastErr);
      continue;
    }

    const out = kind === 'nas' ? parseNasShape(text) : parseOpenAIShape(text, String(cfg.model));
    if (out) {
      kindCache.set(endpoint, kind);
      return out;
    }
    lastErr = '嵌入服务返回了无法识别的结构（既不是 vectors 也不是 data[].embedding）';
  }

  throw new Error(lastErr || '嵌入服务不可用');
}

/**
 * 批量把文本转成向量。内部自动分批，按批回报进度。
 * @returns 未配置 endpoint 时返回 null；配置了但失败则抛错
 */
export async function embedTexts(texts: string[], opts: EmbedOpts): Promise<EmbedResult | null> {
  const endpoint = (opts?.endpoint || '').trim();
  const list = (texts || []).filter((t) => typeof t === 'string' && t.trim().length > 0);
  if (!endpoint || !list.length) return null;

  // 守卫放在这里，而不是 postJson 里：embedTexts 内部按批循环，
  // 放 postJson 会变成「每批弹一次确认窗」——一批 32 条、几百块资料能弹到你放弃。
  assertOnline('语义检索（生成向量）');
  if (!opts.skipConfirm) {
    const allowed = await confirmExternal(
      `即将把 ${list.length} 段资料正文发送给嵌入服务以生成向量（语义检索用）。`,
      endpoint
    );
    if (!allowed) {
      throw new Error('已取消本次嵌入调用（资料未发出）。不想每次都确认，可到「我的 → 隐私与安全」关掉「云端调用需确认」。');
    }
  }

  const batchSize = Math.max(1, opts.batchSize ?? 32);
  const timeoutMs = opts.timeoutMs ?? 60000;
  const vectors: number[][] = [];
  let model = '';
  let dim = 0;

  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    const out = await embedBatch(batch, opts, endpoint, timeoutMs, opts.signal);
    if (vectors.length && out.dim !== dim) {
      throw new Error(`向量维度不一致（先 ${dim} 后 ${out.dim}）：嵌入模型中途换了？请重建语义索引。`);
    }
    vectors.push(...out.vectors);
    model = out.model;
    dim = out.dim;
    opts.onProgress?.(Math.min(i + batch.length, list.length), list.length);
  }

  return { vectors, model, dim };
}

/** 测试连接：发一条短文本，把「地址 / 令牌 / 模型」三件事一次验完 */
export async function testEmbedding(cfg: EmbeddingConfig, timeoutMs = 20000): Promise<EmbedTestResult> {
  const endpoint = (cfg?.endpoint || '').trim();
  if (!endpoint) return { ok: false, message: '还没填嵌入服务地址。' };
  const t0 = Date.now();
  try {
    // skipConfirm：探测只发一句固定文本、不含任何资料，不值得打断用户
    const out = await embedTexts(['这是嵌入服务的连通性测试'], { ...cfg, timeoutMs, batchSize: 1, skipConfirm: true });
    if (!out) return { ok: false, message: '还没填嵌入服务地址。' };
    return {
      ok: true,
      message: `连接成功：${out.model}　${out.dim} 维　耗时 ${Date.now() - t0}ms`,
      dim: out.dim,
      model: out.model,
    };
  } catch (e: any) {
    return { ok: false, message: `${e?.message || e}` };
  }
}

/** 余弦相似度。两边模长都算，不假设服务端已归一化 */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
