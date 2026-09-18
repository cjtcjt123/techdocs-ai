// 文件解析层（原生）—— 统一走 parse-core 的 parseDocument（方案 C：PDF 优先 NAS，失败本地兜底）
// web 端由 parser.web.ts 通过 Metro 平台后缀自动替换
// SDK54 起 expo-file-system 改为 File/Directory 类 API（无 readAsStringAsync/EncodingType）
import { File } from 'expo-file-system';
import { parseDocument, extToType, chunkText } from './parse-core';
import type { ParseContext, ParseOutcome } from './parse-core';

export { extToType, chunkText };
export type { ParseContext, ParseOutcome };

// DocumentPicker / ImagePicker 给的 uri 是 cache 里的副本，直接按字节读
async function readBytes(asset: any): Promise<Uint8Array | null> {
  if (!asset?.uri) return null;
  try {
    return new Uint8Array(await new File(asset.uri).arrayBuffer());
  } catch {
    return null;
  }
}

/** 解析一个 picker 资产 → 文本 + 来源 + 质量。PDF 会先试 NAS 解析服务，失败退回本地。 */
export async function parseAsset(asset: any, ctx: ParseContext = {}): Promise<ParseOutcome> {
  const name = asset?.name || '';
  if (!name) return { text: null, source: 'none', quality: 0, note: '无法识别文件名' };
  const bytes = await readBytes(asset);
  if (!bytes) return { text: null, source: 'none', quality: 0, note: '读取文件失败（可能已被系统清理缓存）' };
  return parseDocument(bytes, name, ctx);
}
