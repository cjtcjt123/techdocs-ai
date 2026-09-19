// 模型文件存储层（web）
//
// 浏览器里既没有原生推理模块，也不该往 localStorage 里塞 GB 级文件。
// 所以这一层只做一件事：**把界面能看到的「已装模型」状态维护起来**，
// 让模型管理页在浏览器预览里可以完整打开、逐屏看、点得动。
//
// 明确标注：这条数据是演示数据，不代表真实安装过的模型。
// 原生端由 model-store.ts 通过 Metro 平台后缀自动替换。
import type { CatalogModel, GgufInfo, LocalModelRecord } from './local-models';
import type { ChatMsg } from './llm';

export interface DownloadProgress {
  downloaded: number;
  total: number;
  ratio: number | null;
}

export type ProgressFn = (p: DownloadProgress) => void;

// 与原生版同签名：web 上下载本来就不成立（见 WEB_REASON），所以「取消」恒为无事可做。
// 必须与原生版成对导出 —— 界面 import 的名字两边都得有，否则 web bundle 直接编译不过。
export const DOWNLOAD_CANCELLED = 'DOWNLOAD_CANCELLED';
export function isDownloading(): boolean {
  return false;
}
export function cancelActiveDownload(): boolean {
  return false;
}

// v2：演示集加了「无来源记录」一条。改版本号是为了让浏览器里缓存的旧演示数据失效重写
const KEY = 'techdocs.localModels.demo.v2';
const MiB = 1024 ** 2;

const WEB_REASON = '浏览器预览不能把模型存到手机上。请在构建安装的手机版里操作。';

// 演示数据：体积与量化都取自真实清单（不是编的），只是文件并不存在
const DEMO: LocalModelRecord[] = [
  {
    id: 'qwen2.5-1.5b-q4km',
    name: 'Qwen2.5-1.5B-Instruct',
    uri: 'demo://models/qwen2.5-1.5b-q4km.gguf',
    bytes: 940 * MiB,
    quant: 'Q4_K_M',
    ctxFromFile: 32768,
    ctxUse: 4096,
    source: 'catalog',
    importedAt: Date.now() - 86400000,
  },
  {
    id: 'qwen2.5-0.5b-q4km',
    name: 'Qwen2.5-0.5B-Instruct',
    uri: 'demo://models/qwen2.5-0.5b-q4km.gguf',
    bytes: 379 * MiB,
    quant: 'Q4_K_M',
    ctxFromFile: 32768,
    ctxUse: 4096,
    source: 'catalog',
    importedAt: Date.now() - 3600000,
  },
  {
    // 演示「读不出量化信息」这种状态：文件在，但头部信息不完整
    id: 'unknown-model',
    name: 'unknown-model',
    uri: 'demo://models/unknown-model.gguf',
    bytes: 1234 * MiB,
    ctxUse: 4096,
    source: 'file',
    importedAt: Date.now() - 600000,
  },
  {
    // 演示「没有来源记录」：用户自己用「文件」App 塞进沙盒的模型不会有侧车记录，
    // 这时界面不显示来源徽章，而不是编一个出来
    id: 'hand-placed',
    name: 'hand-placed-model',
    uri: 'demo://models/hand-placed-model.gguf',
    bytes: 700 * MiB,
    quant: 'Q4_K_M',
    ctxFromFile: 32768,
    ctxUse: 4096,
    importedAt: Date.now() - 120000,
  },
];

function read(): LocalModelRecord[] {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw) return JSON.parse(raw) as LocalModelRecord[];
  } catch {
    // 读不出来就当空
  }
  write(DEMO);
  return DEMO;
}

function write(list: LocalModelRecord[]): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(list));
  } catch {
    // 存不下也不影响本次会话
  }
}

export async function freeSpace(): Promise<number> {
  // 浏览器拿不到「手机剩余空间」，返回 0 表示未知（调用方会跳过空间预检）
  return 0;
}

export async function readGgufHead(): Promise<GgufInfo> {
  return { ok: false, error: WEB_REASON };
}

export async function listLocalModels(): Promise<LocalModelRecord[]> {
  return read().sort((a, b) => b.importedAt - a.importedAt);
}

export async function downloadCatalogModel(_model: CatalogModel): Promise<LocalModelRecord> {
  throw new Error(WEB_REASON);
}

export async function downloadFromUrl(): Promise<LocalModelRecord> {
  throw new Error(`${WEB_REASON} 在手机上这一项可以直接填 NAS 地址拉取，比在线下载快得多。`);
}

export async function importModelFromFiles(): Promise<LocalModelRecord | null> {
  throw new Error(`${WEB_REASON} 手机上可以从「文件」App 选一个 .gguf 导入。`);
}

export async function deleteLocalModel(rec: LocalModelRecord): Promise<void> {
  const rest = read().filter((r) => r.id !== rec.id);
  write(rest);
}

export type { ChatMsg };
