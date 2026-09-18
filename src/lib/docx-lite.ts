/**
 * 轻量 Word(.docx) 文本提取（纯 JS，零新依赖）
 *
 * ── 为什么自己写，而不用 mammoth ──
 * mammoth 的主入口是 Node 版（依赖 fs），浏览器版 `mammoth.browser.js` 是 UMD 打包产物，
 * 在 Metro 下解析行为不确定；而 .docx 本身只是「ZIP + XML」，
 * 解压用项目里已有的 pako 即可，自己实现反而更小、更可控、零打包风险。
 *
 * ── 覆盖范围 ──
 *   ✓ 正文段落（<w:p>），保留 <w:br>/<w:tab>
 *   ✓ 表格（<w:tbl>）：按行输出，单元格之间用空格分隔（TDS 参数表的关键）
 *   ✓ ZIP 的 store / deflate 两种压缩方式
 * ── 不覆盖 ──
 *   ✗ 老式二进制 .doc（需另用转换工具，界面会明确提示）
 *   ✗ 页眉页脚、批注、文本框内的文字
 */
import { inflateRaw } from 'pako';

export interface DocxExtractResult {
  text: string;
  hasText: boolean;
  quality: number;
  note?: string;
}

// ---- ZIP 解析 ----

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** 从尾部定位 EOCD（End of Central Directory） */
function findEOCD(b: Uint8Array): number {
  const min = Math.max(0, b.length - 65557);
  for (let i = b.length - 22; i >= min; i--) {
    if (u32(b, i) === 0x06054b50) return i;
  }
  return -1;
}

/** 读出 ZIP 中指定名称的条目内容（未压缩数据）；不存在返回 null */
function readZipEntry(zip: Uint8Array, wanted: string): Uint8Array | null {
  const eocd = findEOCD(zip);
  if (eocd < 0) return null;

  const count = u16(zip, eocd + 10);
  let p = u32(zip, eocd + 16); // 中央目录起始偏移

  for (let i = 0; i < count; i++) {
    if (u32(zip, p) !== 0x02014b50) break;
    const method = u16(zip, p + 10);
    const compSize = u32(zip, p + 20);
    const nameLen = u16(zip, p + 28);
    const extraLen = u16(zip, p + 30);
    const commentLen = u16(zip, p + 32);
    const localOff = u32(zip, p + 42);
    const name = new TextDecoder('utf-8').decode(zip.subarray(p + 46, p + 46 + nameLen));

    if (name === wanted) {
      // 本地头的 extra 长度可能与中央目录不同，必须以本地头为准
      if (u32(zip, localOff) !== 0x04034b50) return null;
      const lNameLen = u16(zip, localOff + 26);
      const lExtraLen = u16(zip, localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(dataStart, dataStart + compSize);
      if (method === 0) return data; // 未压缩
      if (method === 8) {
        try { return inflateRaw(data); } catch { return null; }
      }
      return null; // 其他压缩方式（如 deflate64）不支持
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// ---- XML 文本提取 ----

const XML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return isNaN(code) ? whole : String.fromCharCode(code);
    }
    return XML_ENTITIES[body] !== undefined ? XML_ENTITIES[body] : whole;
  });
}

/** 取出片段里所有 <w:t> 文本，并把 <w:br>/<w:tab> 转成换行/空格 */
function inlineText(frag: string): string {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/>|<w:tab\s*\/>|<w:cr\s*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(frag))) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else if (m[0].startsWith('<w:br') || m[0].startsWith('<w:cr')) out += '\n';
    else out += ' ';
  }
  return out;
}

/** 表格：每行（<w:tr>）输出为一行，单元格用空格分隔 —— 保住 TDS 参数表的行列语义 */
function tableText(frag: string): string {
  const rows: string[] = [];
  const rowRe = /<w:tr\b[\s\S]*?<\/w:tr>/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(frag))) {
    const cells: string[] = [];
    const cellRe = /<w:tc\b[\s\S]*?<\/w:tc>/g;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(r[0]))) {
      // 单元格内可能有多段，合并成一行
      const t = inlineText(c[0]).replace(/\s*\n\s*/g, ' ').trim();
      if (t) cells.push(t);
    }
    if (cells.length) rows.push(cells.join(' '));
  }
  return rows.join('\n');
}

/** 解析 word/document.xml → 纯文本 */
function parseDocumentXml(xml: string): string {
  const parts: string[] = [];
  // 先整体识别表格，避免把表格内部的段落当成顶层段落
  const re = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const frag = m[0];
    if (frag.startsWith('<w:tbl')) {
      const t = tableText(frag);
      if (t) parts.push(t);
    } else {
      const t = inlineText(frag).trim();
      if (t) parts.push(t);
    }
  }
  // 段落之间空行：让上层的 chunkText() 按段切分
  return parts.join('\n\n');
}

// ---- 对外入口 ----

/** 提取 .docx 文本。纯函数，iOS / Web / Node 三端通用。 */
export function docxExtractText(bytes: Uint8Array): DocxExtractResult {
  try {
    // .docx 的正文在 word/document.xml；部分文档主文档名不同，做个兜底
    let xmlBytes = readZipEntry(bytes, 'word/document.xml');
    if (!xmlBytes) {
      const eocd = findEOCD(bytes);
      if (eocd < 0) {
        return { text: '', hasText: false, quality: 0, note: '不是有效的 .docx（ZIP 结构异常）' };
      }
      return { text: '', hasText: false, quality: 0, note: 'ZIP 内未找到 word/document.xml（可能是老式 .doc 或已损坏）' };
    }

    const xml = new TextDecoder('utf-8').decode(xmlBytes);
    const text = parseDocumentXml(xml);

    const printable = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffefA-Za-z0-9\p{P}\s]/gu) || []).length;
    const ratio = text.length ? printable / text.length : 0;
    const hasText = text.length >= 10;

    return {
      text,
      hasText,
      quality: Math.round(Math.min(1, ratio) * (hasText ? 1 : 0) * 100) / 100,
      note: hasText ? undefined : '文档正文为空',
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { text: '', hasText: false, quality: 0, note: `解析异常：${msg}` };
  }
}

/** 便捷判断：是否为 .docx（老式 .doc 是二进制格式，本模块不支持） */
export const isDocxName = (name: string) => /\.docx$/i.test(name);
export const isLegacyDocName = (name: string) => /\.doc$/i.test(name);
