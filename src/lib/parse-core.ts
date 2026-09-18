// 解析纯函数（与平台无关）—— 原生 parser.ts 与 web parser.web.ts 共用，避免逻辑分叉
import type { DocType } from '../types';
import { pdfExtractText } from './pdf-lite';
import { docxExtractText } from './docx-lite';
import { parseViaNas } from './nas-parse';

export function extToType(name: string): DocType {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'doc' || ext === 'docx') return 'word';
  if (ext === 'md' || ext === 'markdown') return 'md';
  return 'txt';
}

// 切块逻辑在 chunk.ts —— 纯函数单独成文件，便于离线脚本直接跑（切块粒度是检索精度的地基）
export { chunkText } from './chunk';

// ---------------------------------------------------------------- 统一解析入口

/** 文本来源：NAS 高精度解析 / 手机本地解析 / 未能提取 */
export type ParseSource = 'nas' | 'local' | 'none';

export interface ParseOutcome {
  /** 提取出的文本；null 表示没能提取到内容 */
  text: string | null;
  source: ParseSource;
  /** 0~1，越高越可信 */
  quality: number;
  pages?: number;
  /** 给用户看的原因说明（为什么没提取到 / 为何质量偏低） */
  note?: string;
}

export interface ParseContext {
  /** NAS 解析服务地址（如 http://192.168.0.109:8787）；为空则只用手机本地解析 */
  nasEndpoint?: string;
  nasToken?: string;
}

const utf8Decode = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');

// 手机内存有限：超大文件直接放弃解析，别把 App 拖崩
const MAX_PARSE_BYTES = 48 * 1024 * 1024;

/**
 * 统一的文档文本提取入口 —— 方案 C 的调度核心。
 *
 * 优先级设计：
 *   · txt / md  —— 直接解码，无需解析器
 *   · .docx     —— 手机本地解析（ZIP+XML，纯 JS，质量已够用，且离线可用）
 *   · .pdf      —— 优先 NAS（PyMuPDF 质量最好、能处理复杂 PDF），
 *                  NAS 不可达或失败时退回手机本地轻量解析（pdf-lite）。
 *                  本地同时识别「扫面件无文本层」，给出明确提示。
 *   · .doc      —— 老式二进制格式，明确不支持并给出可行建议
 *
 * 本函数是纯逻辑（只依赖 fetch），iOS / Web / Node 通用。
 */
export async function parseDocument(
  bytes: Uint8Array,
  name: string,
  ctx: ParseContext = {}
): Promise<ParseOutcome> {
  if (bytes.length > MAX_PARSE_BYTES) {
    return {
      text: null, source: 'none', quality: 0,
      note: `文件过大（${(bytes.length / 1048576).toFixed(1)} MB），为避免手机内存不足已跳过解析。`,
    };
  }

  // txt / md
  if (/\.(txt|md|markdown)$/i.test(name)) {
    const text = utf8Decode(bytes).trim();
    return { text: text || null, source: text ? 'local' : 'none', quality: text ? 1 : 0 };
  }

  // 老式 .doc：二进制复合文档，本模块不解析
  if (/\.doc$/i.test(name)) {
    return {
      text: null, source: 'none', quality: 0,
      note: '老式 .doc 为二进制格式，暂不支持解析。请在 Word 中另存为 .docx 或导出 PDF 后重新导入。',
    };
  }

  // .docx
  if (/\.docx$/i.test(name)) {
    const r = docxExtractText(bytes);
    return { text: r.hasText ? r.text : null, source: r.hasText ? 'local' : 'none', quality: r.quality, note: r.note };
  }

  // .pdf
  if (/\.pdf$/i.test(name)) {
    let nasNote: string | undefined;
    if (ctx.nasEndpoint) {
      try {
        const r = await parseViaNas(bytes, name, ctx.nasEndpoint, ctx.nasToken);
        if (r.text && r.text.length >= 20) {
          return { text: r.text, source: 'nas', quality: r.quality, pages: r.pages };
        }
        nasNote = 'NAS 解析服务返回内容为空，已改用手机本地解析';
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        nasNote = `NAS 解析服务不可用（${msg}），已改用手机本地解析`;
      }
    }

    const r = pdfExtractText(bytes);
    return {
      text: r.hasTextLayer ? r.text : null,
      source: r.hasTextLayer ? 'local' : 'none',
      quality: r.quality,
      pages: r.pageCount,
      // 扫描件/加密：本地已能说明原因就用它。解析成功时只在质量偏低才提「NAS 没走通」
      note: r.note ?? (r.quality < 0.9 ? nasNote : undefined),
    };
  }

  // 其他类型：尽力当文本读
  const text = utf8Decode(bytes).trim();
  return { text: text || null, source: text ? 'local' : 'none', quality: text ? 0.5 : 0 };
}
