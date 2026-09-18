// 本地推理适配层（web）
//
// 浏览器里没有原生推理模块，所以这里一律回报「不可用」，并且**不抛异常**。
// 目的是让同一套界面在浏览器预览里也能完整打开、逐屏看：
// 本地模型那一项显示成灰的并说明原因，其余三个模型来源照常工作。
//
// 原生端由 local-llm.ts 通过 Metro 平台后缀自动替换。
import type { ChatMsg } from './llm';

export interface LocalAvailability {
  available: boolean;
  reason: string;
}

const WEB_REASON =
  '浏览器预览没有原生推理模块。本地模型要在自己构建安装的手机版里用（Expo Go 也不支持），其余模型来源不受影响。';

export function localAvailability(): LocalAvailability {
  return { available: false, reason: WEB_REASON };
}

export function loadedModelId(): string | null {
  return null;
}

export async function loadLocalModel(): Promise<void> {
  throw new Error(WEB_REASON);
}

export async function unloadLocalModel(): Promise<void> {
  // 本来就是空的，无需处理
}

export interface LocalChatOptions {
  maxTokens?: number;
  temperature?: number;
  onDelta?: (text: string) => void;
}

export async function localChat(_messages: ChatMsg[], _opts: LocalChatOptions = {}): Promise<string> {
  throw new Error(WEB_REASON);
}

export async function stopLocalChat(): Promise<void> {
  // no-op
}

export async function localEmbed(_texts: string[]): Promise<number[][] | null> {
  return null;
}

export async function localEmbedSupported(): Promise<boolean> {
  return false;
}
