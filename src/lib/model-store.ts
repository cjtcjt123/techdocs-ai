// 模型文件存储层（原生）
//
// 模型一律**后置下载**，绝不打包进 App：
//  ① IPA 不该为了一个可选的离线能力膨胀 1 GB；
//  ② 苹果审核明确不接受 App 包体里塞大模型权重（虽然我们是自用不上架，但习惯要正）。
// 存放位置：应用沙盒的 document/models/ —— document 目录不会被系统自动清理。
//
// web 端由 model-store.web.ts 通过 Metro 平台后缀自动替换。
import { Directory, File, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import { assertOnline } from './net-guard';
import {
  formatBytes,
  parseGgufHeader,
  type CatalogModel,
  type GgufInfo,
  type LocalModelRecord,
  type ModelSource,
} from './local-models';
import type { ChatMsg } from './llm';

const DIR_NAME = 'models';
/** 读文件头时读多少：GGUF 的关键字段都在最前面，512 KB 绰绰有余 */
const HEAD_BYTES = 512 * 1024;
/**
 * 来源侧车文件。GGUF 文件本身不存「从哪来的」，而列表每次都是重新扫目录读出来的，
 * 所以来源必须单独记 —— 否则重启后所有模型都会显示成同一种来源，那是错的。
 */
const SOURCES_FILE = 'sources.json';

export interface DownloadProgress {
  /** 已下载字节（拿不到就是 0） */
  downloaded: number;
  /** 预期总字节（清单里有，或服务器 content-length） */
  total: number;
  /** 0~1；拿不到总量时为 null（界面显示不确定进度） */
  ratio: number | null;
}

export type ProgressFn = (p: DownloadProgress) => void;

function modelsDir(): Directory {
  const d = new Directory(Paths.document, DIR_NAME);
  try {
    if (!(d as any).exists) d.create();
  } catch {
    // 已存在时 create 会抛错，忽略即可
  }
  return d;
}

/** 手机剩余空间。下载前必须查 —— 手机上空间不够是比内存不够更常见的失败 */
export async function freeSpace(): Promise<number> {
  try {
    return Number(Paths.availableDiskSpace) || 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- 来源侧车

function sourcesMap(): Record<string, ModelSource> {
  try {
    const f = new File(modelsDir(), SOURCES_FILE);
    if (!(f as any).exists) return {};
    const txt = (f as any).textSync ? (f as any).textSync() : null;
    if (!txt) return {};
    const parsed = JSON.parse(txt);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSources(map: Record<string, ModelSource>): void {
  try {
    const f = new File(modelsDir(), SOURCES_FILE);
    if (!(f as any).exists) f.create();
    (f as any).write(JSON.stringify(map));
  } catch {
    // 记不住来源不影响主流程：顶多不显示来源徽章
  }
}

function rememberSource(id: string, source: ModelSource): void {
  const map = sourcesMap();
  map[id] = source;
  writeSources(map);
}

function forgetSource(id: string): void {
  const map = sourcesMap();
  delete map[id];
  writeSources(map);
}

/** 只读文件头，反推量化等级与真实上下文长度 */
export async function readGgufHead(file: File): Promise<GgufInfo> {
  try {
    const buf = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
    return parseGgufHeader(buf);
  } catch (e: any) {
    return { ok: false, error: `读取文件头失败：${e?.message || e}` };
  }
}

function fileToRecord(file: File, info: GgufInfo, source: ModelSource | undefined, fallbackName?: string, fallbackBytes?: number): LocalModelRecord {
  const bytes = Number((file as any).size) || fallbackBytes || 0;
  const baseName = file.name.replace(/\.gguf$/i, '');
  return {
    id: baseName,
    name: info.name || fallbackName || baseName,
    uri: file.uri,
    bytes,
    quant: info.quant,
    ctxFromFile: info.contextLength,
    ctxUse: Math.min(info.contextLength || 4096, 4096),
    source,
    importedAt: Date.now(),
  };
}

/** 列出已装模型：扫描目录，逐个读文件头。列表规模很小（个位数），不值得维护额外索引文件 */
export async function listLocalModels(): Promise<LocalModelRecord[]> {
  const out: LocalModelRecord[] = [];
  let entries: (File | Directory)[] = [];
  try {
    entries = modelsDir().list();
  } catch {
    return out;
  }
  const sources = sourcesMap();
  for (const e of entries) {
    const f = e as File;
    const name = typeof f.name === 'string' ? f.name : '';
    if (!/\.gguf$/i.test(name)) continue;
    const info = await readGgufHead(f);
    // 来源从侧车查；查不到就留空（用户自己塞进沙盒的文件没有记录），不猜
    out.push(fileToRecord(f, info, sources[name]));
  }
  return out.sort((a, b) => b.importedAt - a.importedAt);
}

/** 用下载目标文件的实时大小当进度 —— expo-file-system 的下载接口没有进度回调，
 *  但目标文件是边下边落盘的，轮询它的大小就是真实进度（不是假动画）。 */
async function downloadTo(url: string, fileName: string, totalHint: number, onProgress?: ProgressFn): Promise<File> {
  // 模型下载是纯外网拉取、不含资料，所以只受「离线模式」拦，不接「云端确认」
  assertOnline('下载本地模型');
  const dest = new File(modelsDir(), fileName);

  // 空间预检：留 300 MB 余量，避免下到 99% 时写失败
  const free = await freeSpace();
  if (free > 0 && totalHint > 0 && free < totalHint + 300 * 1024 ** 2) {
    throw new Error(
      `手机剩余空间不足：需要约 ${formatBytes(totalHint)}，当前只剩 ${formatBytes(free)}。请先删掉不用的模型或腾出空间。`
    );
  }

  let poll: ReturnType<typeof setInterval> | null = null;
  const tick = () => {
    try {
      const done = Number((dest as any).size) || 0;
      onProgress?.({ downloaded: done, total: totalHint, ratio: totalHint > 0 ? Math.min(1, done / totalHint) : null });
    } catch {
      // 文件还没落盘时会抛错，忽略
    }
  };
  onProgress?.({ downloaded: 0, total: totalHint, ratio: totalHint > 0 ? 0 : null });
  poll = setInterval(tick, 600);

  try {
    await File.downloadFileAsync(url, dest, { idempotent: true });
  } catch (e: any) {
    const msg = String(e?.message || e);
    throw new Error(
      `下载失败：${msg}\n请检查网络（国内直连 HuggingFace 常不通，界面里可切镜像源），或改用「NAS 拉取」。`
    );
  } finally {
    if (poll) clearInterval(poll);
  }

  // 下完立刻验真身：不校验的话，把 404 页面或 HTML 当成模型存下来，
  // 直到加载时才崩，且错误信息完全对不上（这是最坑的一类问题）
  const info = await readGgufHead(dest);
  if (!info.ok) {
    try {
      dest.delete();
    } catch {
      // 删不掉也要把错误抛出去，让用户知道文件是坏的
    }
    throw new Error(`下载到的文件不是有效的 GGUF，已删除。${info.error || ''}`);
  }
  return dest;
}

/** 从内置清单下载 */
export async function downloadCatalogModel(model: CatalogModel, useMirror: boolean, onProgress?: ProgressFn): Promise<LocalModelRecord> {
  const url = useMirror ? model.mirrorUrl : model.hfUrl;
  const fileName = `${model.id}.gguf`;
  const dest = await downloadTo(url, fileName, model.bytes, onProgress);
  const info = await readGgufHead(dest);
  const rec = fileToRecord(dest, info, 'catalog', model.name, model.bytes);
  rec.id = model.id;
  rec.ctxUse = Math.min(info.contextLength || model.ctx, model.ctx);
  rememberSource(fileName, 'catalog');
  return rec;
}

/** 从任意 URL 拉取（NAS 局域网、自建静态服务等） */
export async function downloadFromUrl(url: string, fileName: string, totalHint: number, onProgress?: ProgressFn): Promise<LocalModelRecord> {
  if (!/^https?:\/\//i.test(url)) throw new Error('地址要以 http:// 或 https:// 开头（NAS 局域网地址形如 http://192.168.0.x:8788/xxx.gguf）。');
  const safeName = /\.gguf$/i.test(fileName) ? fileName : `${fileName}.gguf`;
  const dest = await downloadTo(url, safeName, totalHint, onProgress);
  const info = await readGgufHead(dest);
  rememberSource(safeName, 'nas');
  return fileToRecord(dest, info, 'nas');
}

/** 从「文件」App 选一个 .gguf 导入（AirDrop / 微信 / iCloud 传进来的都走这里） */
export async function importModelFromFiles(): Promise<LocalModelRecord | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: ['*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (res.canceled || !res.assets?.length) return null;

  const asset = res.assets[0];
  const src = new File(asset.uri);

  // 先在源文件上验真身，不合格就不往沙盒里搬 —— 别把垃圾留在 document 里
  const info = await readGgufHead(src);
  if (!info.ok) throw new Error(info.error || '这不是有效的 GGUF 文件');

  const dest = new File(modelsDir(), asset.name || 'imported.gguf');
  if ((dest as any).exists) {
    throw new Error(`已经有一个叫「${asset.name}」的模型了。要替换的话请先删掉旧的。`);
  }

  // 搬家优先用 move（同容器内是 O(1)，不复制字节）；跨卷失败再退回 copy
  try {
    (src as any).move(dest);
  } catch {
    try {
      (src as any).copy(dest);
    } catch (e: any) {
      throw new Error(`把文件放进 App 沙盒失败：${e?.message || e}。若文件很大，可改用「NAS 拉取」。`);
    }
  }

  const moved = await readGgufHead(dest);
  rememberSource(asset.name || 'imported.gguf', 'file');
  return fileToRecord(dest, moved, 'file', asset.name);
}

/** 删除模型。调用方必须先做二次确认（数据不可逆） */
export async function deleteLocalModel(rec: LocalModelRecord): Promise<void> {
  const f = new File(rec.uri);
  try {
    if ((f as any).exists) f.delete();
  } catch (e: any) {
    throw new Error(`删除失败：${e?.message || e}`);
  }
  forgetSource(f.name || `${rec.id}.gguf`);
}

/** 兜底：把本地模型当第四个来源接进对话链路时用 */
export type { ChatMsg };
