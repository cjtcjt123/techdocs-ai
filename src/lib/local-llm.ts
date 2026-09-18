// 本地推理适配层（原生）
//
// 一条铁律：**llama.rn 只能按需加载**。
// 它是含原生代码的库，Expo Go 里没有对应实现，一旦在模块顶层 import 就会在
// Expo Go 启动瞬间抛错、整个 App 白屏。所以这里用 require + try/catch 包住，
// 加载失败就退化成「当前环境不支持」——浏览器预览、Expo Go 都能照常用其余三个模型来源。
//
// web 端由 local-llm.web.ts 通过 Metro 平台后缀自动替换。
import type { ChatMsg } from './llm';

export interface LocalAvailability {
  available: boolean;
  /** 不可用时的原因，要能直接显示给用户 */
  reason: string;
}

type LlamaRN = typeof import('llama.rn');

let mod: LlamaRN | null = null;
let modError: string | null = null;

function engine(): LlamaRN {
  if (mod) return mod;
  if (modError) throw new Error(modError);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('llama.rn') as LlamaRN;
    return mod;
  } catch (e: any) {
    modError =
      '当前 App 里没有本地推理模块。本地模型需要自己构建安装的版本（Expo Go 与浏览器预览都不支持），' +
      '其余模型来源不受影响。';
    throw new Error(modError);
  }
}

export function localAvailability(): LocalAvailability {
  try {
    engine();
    return { available: true, reason: '' };
  } catch (e: any) {
    return { available: false, reason: e?.message || String(e) };
  }
}

// ---------------------------------------------------------------- 上下文单例
//
// 同一时刻只保留一个已加载的模型：手机上 GB 级的权重不可能同时装两个，
// 而且 llama.cpp 的上下文本身就吃大块内存。切模型 = 释放旧的再加载新的。

type Ctx = Awaited<ReturnType<LlamaRN['initLlama']>>;

let ctx: Ctx | null = null;
let ctxModelId: string | null = null;

export function loadedModelId(): string | null {
  return ctxModelId;
}

export interface LoadOptions {
  id: string;
  uri: string;
  /** 上下文长度：取「文件上限」与「我们愿意开的」的较小值 */
  ctx: number;
  /** GPU 层数：99 = 尽量都放 Metal。iOS 上 Metal 加速是速度的关键 */
  gpuLayers?: number;
}

export type LoadProgress = (p: { ratio: number | null; note: string }) => void;

export async function loadLocalModel(opts: LoadOptions, onProgress?: LoadProgress): Promise<void> {
  const { initLlama } = engine();
  if (ctxModelId === opts.id && ctx) return; // 已经是它，不重复加载

  await unloadLocalModel();
  onProgress?.({ ratio: null, note: '正在读取模型文件…' });

  try {
    ctx = await initLlama(
      {
        model: opts.uri,
        n_ctx: opts.ctx,
        n_gpu_layers: opts.gpuLayers ?? 99,
        // use_mlock 在手机上不要开：会把权重锁死在物理内存里，4 GB 机器直接触发 jetsam
        use_mlock: false,
        // embedding 模式要单独加载一个上下文（见 localEmbed），这里只做对话
        embedding: false,
      },
      (progress: number) => {
        // llama.rn 给的 progress 是 0~1
        const r = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : null;
        onProgress?.({ ratio: r, note: '正在加载到内存…' });
      }
    );
    ctxModelId = opts.id;
    onProgress?.({ ratio: 1, note: '已就绪' });
  } catch (e: any) {
    ctx = null;
    ctxModelId = null;
    const msg = String(e?.message || e);
    // 内存不足是最常见的失败，直说原因与解法，别让用户对着 "error" 发懵
    if (/memory|alloc|oom/i.test(msg)) {
      throw new Error(`内存不足，加载失败。换小一号的模型，或把上下文长度调小。原始信息：${msg}`);
    }
    throw new Error(`加载模型失败：${msg}`);
  }
}

export async function unloadLocalModel(): Promise<void> {
  if (!ctx) return;
  try {
    await ctx.release();
  } catch {
    // 释放失败不影响后续：反正引用已经丢掉，交给系统回收
  }
  ctx = null;
  ctxModelId = null;
}

// ---------------------------------------------------------------- 对话

export interface LocalChatOptions {
  maxTokens?: number;
  temperature?: number;
  onDelta?: (text: string) => void;
}

export async function localChat(messages: ChatMsg[], opts: LocalChatOptions = {}): Promise<string> {
  const c = ctx;
  if (!c) throw new Error('还没有加载本地模型。请到「模型管理」里选一个并加载。');

  const stopWords = ['</s>', '<|im_end|>', '<|endoftext|>', '<|eot_id|>'];
  const res = await c.completion(
    {
      messages: messages as any,
      n_predict: opts.maxTokens ?? 512,
      temperature: opts.temperature ?? 0.2,
      stop: stopWords,
    },
    (data) => {
      if (data?.token) opts.onDelta?.(data.token);
    }
  );

  const text = (res as any)?.text || '';
  if (!text.trim()) throw new Error('本地模型没有返回内容（可能上下文被塞满，或模型不适合这个问法）。');
  return text;
}

/** 中断正在进行的生成（切换模型、离开页面时用） */
export async function stopLocalChat(): Promise<void> {
  try {
    await ctx?.stopCompletion();
  } catch {
    // 没有正在进行的生成时会抛错，忽略
  }
}

// ---------------------------------------------------------------- 向量（后续迭代）
//
// 同一个引擎的 embedding 模式可以给「手机本地语义检索」用，
// 但它要求用 embedding 上下文重新加载一次模型（当前对话上下文就没法留着了）。
// 这一步留到真机验过对话质量后再做，先如实返回 null，不要假装支持。
export async function localEmbed(_texts: string[]): Promise<number[][] | null> {
  return null;
}

export async function localEmbedSupported(): Promise<boolean> {
  return false;
}
