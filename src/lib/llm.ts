// LLM 调用层：三源路由（官方 API / 手机本地 / NAS 后端）
// 官方与 NAS 均走 OpenAI 兼容 /chat/completions；Claude 走 /v1/messages 分支
import { ModelConfig } from '../types';
import { localAvailability, localChat, loadedModelId } from './local-llm';
import { assertOnline, confirmExternal } from './net-guard';

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface Resolved {
  baseURL: string;
  apiKey: string;
  model: string;
  claude?: boolean;
}

// 拼接 baseURL + 路径，自动去掉 baseURL 结尾多余的斜杠（避免 /v1//chat/completions 这类双斜杠 404）
function joinPath(base: string, path: string): string {
  const b = (base || '').replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : '/' + path;
  return b + p;
}

// 把 ModelConfig 解析成具体请求目标
// 说明：'api' 来源统一覆盖云端厂商与自托管模型（如家里 NAS 上的 Ollama），
// 二者本质都是 OpenAI 兼容 /chat/completions 接口，仅地址不同，无需分成两个来源。
export function resolveTarget(cfg: ModelConfig): Resolved {
  if (cfg.source === 'local') {
    // 本地模型不经过 HTTP：chat()/testModel() 里已经提前分流到 localChat，走不到这里
    return { baseURL: '', apiKey: '', model: '' };
  }
  // source === 'api'（含旧 'official' / 'nas' 存量设置的兜底）
  switch (cfg.provider) {
    case 'openai':
      return { baseURL: 'https://api.openai.com/v1', apiKey: cfg.apiKey || '', model: cfg.model || 'gpt-4o-mini' };
    case 'tongyi':
      return { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: cfg.apiKey || '', model: cfg.model || 'qwen-plus' };
    case 'zhipu':
      return { baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: cfg.apiKey || '', model: cfg.model || 'glm-4-flash' };
    case 'deepseek':
      // 注意：DeepSeek 的接口地址【不带 /v1】，直接 https://api.deepseek.com/chat/completions
      return { baseURL: 'https://api.deepseek.com', apiKey: cfg.apiKey || '', model: cfg.model || 'deepseek-chat' };
    case 'claude':
      return { baseURL: 'https://api.anthropic.com/v1', apiKey: cfg.apiKey || '', model: cfg.model || 'claude-3-5-haiku-latest', claude: true };
    case 'custom':
    default:
      // 自托管（NAS Ollama 等）：直接用自定义地址与模型名
      return { baseURL: cfg.baseURL || '', apiKey: cfg.apiKey || '', model: cfg.model || '' };
  }
}

// 把常见的 HTTP 状态码翻译成人话，用户自己就能定位问题（404 = 地址或模型名，401 = Key）
function explainStatus(status: number): string {
  switch (status) {
    case 400: return '请求被拒（400）：多半是模型名不被该服务支持，或参数格式不对。';
    case 401: return 'API Key 无效或未填写（401）。';
    case 403: return '密钥无权访问该模型，或所在地域受限（403）。';
    case 404: return '接口地址或模型名不对（404）。重点检查：Base URL 是否多写/少写 /v1，模型名是否拼错。';
    case 429: return '额度不足或请求过频（429）。';
    case 500:
    case 502:
    case 503: return `服务端异常（${status}），稍后重试。`;
    default: return `请求被拒（${status}）。`;
  }
}

export interface ConnTestResult {
  ok: boolean;
  ms: number;
  detail: string;
}

// 测试连接：真实发一次最小请求，一次性验证「接口地址 / 密钥 / 模型名」三者是否对得上。
// 与 chat() 的区别是只要求回两个字，成本几乎为零，且错误信息回显实际 URL 与状态码含义。
export async function testModel(cfg: ModelConfig): Promise<ConnTestResult> {
  const t0 = Date.now();
  if (cfg.source === 'local') {
    // 本地模型没有「连接」可测，改测「真能出字」——这才是用户关心的
    const av = localAvailability();
    if (!av.available) return { ok: false, ms: 0, detail: av.reason };
    if (!loadedModelId()) {
      return { ok: false, ms: 0, detail: '本地模型还没有加载。到「我的 → 模型管理」里加载一个再测。' };
    }
    try {
      const reply = await localChat([{ role: 'user', content: '只回复两个字：可用' }], { maxTokens: 24 });
      const ms = Date.now() - t0;
      return {
        ok: true,
        ms,
        detail: `本地模型正常（回：${reply.trim().slice(0, 20)}），首字耗时 ${ms}ms。本地推理速度取决于机型，通常明显慢于云端。`,
      };
    } catch (e: any) {
      return { ok: false, ms: Date.now() - t0, detail: `本地模型调用失败：${e?.message || e}` };
    }
  }
  const t = resolveTarget(cfg);
  if (!t.baseURL) return { ok: false, ms: 0, detail: '还没填接口地址：选「自定义」时必须填 Base URL。' };
  if (!t.model) return { ok: false, ms: 0, detail: '还没填模型名。' };
  // 离线模式下直接给出原因。测试连接只发两个字的探测问句、不带任何资料，
  // 所以这里【不】走「云端确认」—— 为一次不带资料的探测弹窗，只会把确认弹窗变成噪音。
  try {
    assertOnline('测试连接');
  } catch (e: any) {
    return { ok: false, ms: 0, detail: e?.message || '离线模式下无法测试连接。' };
  }

  const url = joinPath(t.baseURL, t.claude ? '/messages' : '/chat/completions');
  // 不传 max_tokens（部分新模型已改用 max_completion_tokens，传了反而 400）；Claude 则必须传
  const body = t.claude
    ? { model: t.model, max_tokens: 16, messages: [{ role: 'user', content: '只回复两个字：可用' }] }
    : { model: t.model, messages: [{ role: 'user', content: '只回复两个字：可用' }], stream: false };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: t.claude
        ? { 'Content-Type': 'application/json', 'x-api-key': t.apiKey, 'anthropic-version': '2023-06-01' }
        : { 'Content-Type': 'application/json', Authorization: `Bearer ${t.apiKey}` },
      body: JSON.stringify(body),
    });
    const ms = Date.now() - t0;
    const txt = await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, ms, detail: `${explainStatus(res.status)}\n请求地址：${url}\n原文：${txt.slice(0, 240)}` };
    }
    let reply = '';
    try {
      const data = JSON.parse(txt);
      reply = t.claude
        ? (data?.content || []).map((c: any) => c.text || '').join('')
        : (data?.choices?.[0]?.message?.content || '');
    } catch {
      // 状态码 200 已足够说明连通，返回体解析失败不视为错误
    }
    return {
      ok: true,
      ms,
      detail: `连接成功：${t.model} 正常响应${reply ? `（回：${reply.slice(0, 20).trim()}）` : ''}，耗时 ${ms}ms。`,
    };
  } catch (e: any) {
    return {
      ok: false,
      ms: Date.now() - t0,
      detail: `没连上（网络层失败）：${e?.message || e}\n请求地址：${url}\n若是自签 HTTPS 证书或纯 http 地址，iOS 会直接拒绝连接；局域网地址需与手机同一 WiFi。`,
    };
  }
}

/**
 * 中断信号。两条来源的中断方式不同，别指望一个 signal 通吃：
 *   · 云端 —— fetch 认 `signal`，abort 立刻断连接
 *   · 本地 —— llama.rn 的 completion 不认 signal，得调 `stopLocalChat()`
 * 所以 store 里的「停止生成」是**两个一起做**的（见 store.stopGeneration 的注释）。
 */
export interface ChatOpts {
  signal?: AbortSignal;
}

export async function chat(cfg: ModelConfig, messages: ChatMsg[], opts?: ChatOpts): Promise<string> {
  if (cfg.source === 'local') {
    // 已经开始前就取消的话直接退出，别再白白跑一遍（生成中的中断由 stopLocalChat 负责）
    if (opts?.signal?.aborted) throw new Error('已取消');
    // 手机本地：走 llama.cpp（llama.rn）。三道门各自给出可直接照做的提示，
    // 而不是笼统一句「不可用」——这三种失败原因用户要做的事完全不同。
    const av = localAvailability();
    if (!av.available) throw new Error(av.reason);
    if (!loadedModelId()) {
      throw new Error('还没有加载本地模型。请到「我的 → 模型管理」里选一个加载（第一次要先下载）。');
    }
    return localChat(messages);
  }
  const t = resolveTarget(cfg);
  assertOnline('调用云端模型');
  if (!t.baseURL || !t.model) {
    throw new Error('模型未正确配置：请前往「我的 → API 与模型」填写 baseURL 与 model。');
  }
  // 这一步才是「云端调用需确认」真正要保护的动作：把检索到的资料正文发出去。
  // 内网自托管（NAS 上的 Ollama）地址会被判为私有、不弹窗 —— 资料没出用户的网络。
  const allowed = await confirmExternal(
    `即将把本次问答检索到的资料正文发送给模型「${t.model}」以生成回答。`,
    t.baseURL
  );
  if (!allowed) {
    throw new Error('已取消本次云端调用（资料未发出）。不想每次都确认，可到「我的 → 隐私与安全」关掉「云端调用需确认」。');
  }
  if (t.claude) return chatClaude(t, messages, opts?.signal);

  const url = joinPath(t.baseURL, '/chat/completions');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.apiKey}` },
    body: JSON.stringify({ model: t.model, messages, stream: false, temperature: 0.2 }),
    signal: opts?.signal,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`API 错误 ${res.status} @ ${url}：${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('API 返回为空');
  return content;
}

async function chatClaude(t: Resolved, messages: ChatMsg[], signal?: AbortSignal): Promise<string> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const msgs = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
  const url = joinPath(t.baseURL, '/messages');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': t.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: t.model, system, messages: msgs, max_tokens: 2000 }),
    signal,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Claude 错误 ${res.status} @ ${url}：${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data?.content || []).map((c: any) => c.text || '').join('');
}
