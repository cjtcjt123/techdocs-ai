// 文件解析层（原生）—— MVP 先支持 TXT/MD 全文提取；PDF/Word 接口预留（标记 partial）
// web 端由 parser.web.ts 通过 Metro 平台后缀自动替换
// SDK54 起 expo-file-system 改为 File/Directory 类 API（无 readAsStringAsync/EncodingType）
import { File } from 'expo-file-system';
import { DocType } from '../types';

export { extToType, chunkText } from './parse-core';

// 返回提取的文本；PDF/Word 暂返回 null（上层标记 partial，后续接入解析引擎）
export async function extractText(uri: string, type: DocType): Promise<string | null> {
  if (type === 'txt' || type === 'md') {
    try {
      const buf = await new File(uri).arrayBuffer();
      return new TextDecoder('utf-8').decode(buf);
    } catch {
      return null;
    }
  }
  // PDF / Word：MVP 占位，后续接 pdf-parse / mammoth 等
  return null;
}

// 统一入口：从 DocumentPicker 资产取文本（原生直接用 uri）
export async function readAssetText(asset: any, type: DocType): Promise<string | null> {
  if (!asset?.uri) return null;
  return extractText(asset.uri, type);
}
