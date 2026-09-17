// 文件解析层（web 预览降级）—— 浏览器无 expo-file-system，改用 fetch / File API
import { DocType } from '../types';

export { extToType, chunkText } from './parse-core';

// web 端 DocumentPicker 返回的 uri 是 data:/blob: URL，可直接 fetch 出文本
export async function extractText(uri: string, type: DocType): Promise<string | null> {
  if (type !== 'txt' && type !== 'md') return null; // PDF/Word 仍走 partial 占位
  if (!uri) return null;
  try {
    const res = await fetch(uri);
    const text = await res.text();
    return text || null;
  } catch {
    return null;
  }
}

// 统一入口：web 端 picker 会给原始 File 对象，优先用它（省去 data URL 解码）
export async function readAssetText(asset: any, type: DocType): Promise<string | null> {
  if (type !== 'txt' && type !== 'md') return null;
  try {
    if (asset?.file && typeof asset.file.text === 'function') {
      const text = await asset.file.text();
      return text || null;
    }
  } catch {
    // 落到 uri 分支
  }
  return extractText(asset?.uri, type);
}
