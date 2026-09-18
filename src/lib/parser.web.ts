// 文件解析层（web 预览降级）—— 浏览器无 expo-file-system，改用 File API / fetch
import { parseDocument, extToType, chunkText } from './parse-core';
import type { ParseContext, ParseOutcome } from './parse-core';

export { extToType, chunkText };
export type { ParseContext, ParseOutcome };

async function readBytes(asset: any): Promise<Uint8Array | null> {
  try {
    // picker 直接给原始 File 对象时优先用它（省去 data URL 解码）
    if (asset?.file && typeof asset.file.arrayBuffer === 'function') {
      return new Uint8Array(await asset.file.arrayBuffer());
    }
    if (asset?.uri) {
      const res = await fetch(asset.uri);
      return new Uint8Array(await res.arrayBuffer());
    }
  } catch {
    // 落到 null
  }
  return null;
}

/** 解析一个 picker 资产 → 文本 + 来源 + 质量。 */
export async function parseAsset(asset: any, ctx: ParseContext = {}): Promise<ParseOutcome> {
  const name = asset?.name || '';
  if (!name) return { text: null, source: 'none', quality: 0, note: '无法识别文件名' };
  const bytes = await readBytes(asset);
  if (!bytes) return { text: null, source: 'none', quality: 0, note: '读取文件失败' };
  return parseDocument(bytes, name, ctx);
}
