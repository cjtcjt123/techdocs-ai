// LLM 调用层：三源路由（官方 API / 手机本地 / NAS 后端）
// 官方与 NAS 均走 OpenAI 兼容 /chat/completions；Claude 走 /v1/messages 分支
import { ModelConfig } from '../types';

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

// 把 ModelConfig 解析成具体请求目标
export function resolveTarget(cfg: ModelConfig): Resolved {
  if (cfg.source === 'nas') {
    return {
      baseURL: cfg.baseURL || 'http://your-nas.local:11434/v1',
      apiKey: cfg.apiKey || '',
      model: cfg.model || 'qwen2.5',
    };
  }
  if (cfg.source === 'official') {
    switch (cfg.provider) {
      case 'openai':
        return { baseURL: 'https://api.openai.com/v1', apiKey: cfg.apiKey || '', model: cfg.model || 'gpt-4o-mini' };
      case 'tongyi':
        return { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: cfg.apiKey || '', model: cfg.model || 'qwen-plus' };
      case 'zhipu':
        return { baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: cfg.apiKey || '', model: cfg.model || 'glm-4-flash' };
      case 'claude':
        return { baseURL: 'https://api.anthropic.com/v1', apiKey: cfg.apiKey || '', model: cfg.model || 'claude-3-5-haiku-latest', claude: true };
      case 'custom':
      default:
        return { baseURL: cfg.baseURL || '', apiKey: cfg.apiKey || '', model: cfg.model || '' };
    }
  }
  // local 尚未接入
  return { baseURL: '', apiKey: '', model: '' };
}

export async function chat(cfg: ModelConfig, messages: ChatMsg[]): Promise<string> {
  if (cfg.source === 'local') {
    throw new Error('手机本地模型尚未接入（MVP 后续迭代）。可切换为官方 API 或 NAS 后端。');
  }
  const t = resolveTarget(cfg);
  if (!t.baseURL || !t.model) {
    throw new Error('模型未正确配置：请前往「我的 → API 与模型」填写 baseURL 与 model。');
  }
  if (t.claude) return chatClaude(t, messages);

  const res = await fetch(`${t.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.apiKey}` },
    body: JSON.stringify({ model: t.model, messages, stream: false, temperature: 0.2 }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`API 错误 ${res.status}：${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('API 返回为空');
  return content;
}

async function chatClaude(t: Resolved, messages: ChatMsg[]): Promise<string> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const msgs = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
  const res = await fetch(`${t.baseURL}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': t.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: t.model, system, messages: msgs, max_tokens: 2000 }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Claude 错误 ${res.status}：${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data?.content || []).map((c: any) => c.text || '').join('');
}
