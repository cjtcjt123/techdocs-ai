/**
 * 轻量 PDF 文本提取（纯 JS，零原生依赖）
 *
 * ── 为什么自己写，而不用 pdfjs-dist ──
 * pdfjs-dist 的解析路径依赖 Canvas / DOMMatrix / Web Worker，React Native(Hermes) 没有这些 API
 * （Hermes 直到 RN 0.84 才支持 WebAssembly）。社区结论一致：设备端跑不动，
 * 除非引入 Skia 这类重量级原生依赖 —— 那会拖垮 IPA 出包流水线。
 *
 * ── 在本项目中的定位（方案 C）──
 * PDF 优先走 NAS 高精度解析（PyMuPDF）；NAS 不可达时用本模块兜底。
 * 因此这里的目标是「够用、稳、不崩」，而非像素级还原排版。
 *
 * ── 覆盖范围 ──
 *   ✓ FlateDecode 内容流
 *   ✓ Type0/Identity-H (CID) 字体 + ToUnicode CMap → 中文正确解码
 *   ✓ TrueType / Type1 简单字体（WinAnsi/MacRoman 直读）
 *   ✓ Tj / TJ / ' / " 四种文本操作符
 *   ✓ 页面树 /Kids 递归，保证页序正确
 * ── 明确不覆盖（返回低质量标记，由上层提示用户走 NAS 或 OCR）──
 *   ✗ 纯扫描件（无文本层）
 *   ✗ LZW / 加密 / 自定义 CMap / 部分 LZW+xref-stream 的老 PDF
 */
import { inflate } from 'pako';
import { normalizeCjkCompat } from './cjk-compat-table';

export interface PdfExtractResult {
  text: string;
  pageCount: number;
  /** 是否有可用文本层。false = 大概率是扫描件，需要 OCR */
  hasTextLayer: boolean;
  /** 0~1，越高越可信。低分时上层应提示「建议启用 NAS 解析」 */
  quality: number;
  note?: string;
}

interface PdfObject {
  num: number;
  dict: string;
  stream: Uint8Array | null;
}

interface FontInfo {
  /** Type0 复合字体：字符串按 2 字节读 */
  twoByte: boolean;
  /** 代码 → Unicode 映射（来自 ToUnicode CMap） */
  cmap: Map<number, string> | null;
}

// ---------------------------------------------------------------- 字节工具

/** 字节 → latin1 字符串（1 字节 = 1 字符，索引与字节下标严格对齐，便于切片） */
function toLatin1(bytes: Uint8Array): string {
  const CHUNK = 8192; // 避免 apply 参数过多爆栈
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))) as unknown as number[]
    );
  }
  return out;
}

const bytesFromLatin1 = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

// ---------------------------------------------------------------- 流解码

/** 按 /Filter 解码流内容；不支持的类型返回 null（调用方跳过） */
function decodeStream(dict: string, raw: Uint8Array): Uint8Array | null {
  // 图像类滤镜直接跳过（DCTDecode/JPXDecode/CCITTFaxDecode）
  if (/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)/.test(dict)) return null;

  if (/\/FlateDecode/.test(dict)) {
    try {
      // 有 predictor 的流（常见于 xref stream / 图像）我们不做还原，仍尝试裸解压
      return inflate(raw);
    } catch {
      return null;
    }
  }
  if (/\/ASCIIHexDecode/.test(dict)) {
    const s = toLatin1(raw).replace(/\s/g, '').replace(/>.*$/, '');
    const out: number[] = [];
    for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
    return out.some((n) => isNaN(n)) ? null : new Uint8Array(out);
  }
  if (!/\/Filter/.test(dict)) return raw; // 未压缩
  return null;
}

// ---------------------------------------------------------------- 对象扫描

/**
 * 暴力扫描所有 "N G obj ... endobj"。
 * 不解析 xref：现代 PDF 大量使用 xref stream（PDF 1.5+），实现成本远高于收益，
 * 而对象头扫描对绝大多数文档都成立。
 */
function scanObjects(src: string, bytes: Uint8Array): Map<number, PdfObject> {
  const objs = new Map<number, PdfObject>();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src))) {
    const num = parseInt(m[1], 10);
    const bodyStart = m.index + m[0].length;
    const endIdx = src.indexOf('endobj', bodyStart);
    if (endIdx < 0) continue;

    const streamIdx = src.indexOf('stream', bodyStart);
    // stream 必须出现在 endobj 之前
    if (streamIdx < 0 || streamIdx > endIdx) {
      objs.set(num, { num, dict: src.slice(bodyStart, endIdx), stream: null });
      continue;
    }

    const dict = src.slice(bodyStart, streamIdx);
    // stream 关键字后紧跟 CRLF 或 LF，数据从其后开始
    let dataStart = streamIdx + 'stream'.length;
    if (src[dataStart] === '\r') dataStart++;
    if (src[dataStart] === '\n') dataStart++;

    // 优先信 /Length（直接数字）；间接引用或缺失时退回搜索 endstream
    let dataEnd = -1;
    const lenMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    if (lenMatch) {
      const len = parseInt(lenMatch[1], 10);
      if (len > 0 && dataStart + len <= bytes.length) dataEnd = dataStart + len;
    }
    if (dataEnd < 0) {
      const es = src.indexOf('endstream', dataStart);
      dataEnd = es < 0 ? endIdx : es;
      // 去掉 endstream 前的换行
      while (dataEnd > dataStart && (src[dataEnd - 1] === '\n' || src[dataEnd - 1] === '\r')) dataEnd--;
    }

    const raw = bytes.subarray(dataStart, dataEnd);
    objs.set(num, { num, dict, stream: decodeStream(dict, raw) });
  }
  return objs;
}

/** 从 pos 处读取一个平衡的 << ... >> 字典；返回 null 表示此处不是字典 */
function readDict(src: string, pos: number): { text: string; end: number } | null {
  let i = pos;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== '<' || src[i + 1] !== '<') return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '<' && src[j + 1] === '<') { depth++; j++; }
    else if (src[j] === '>' && src[j + 1] === '>') {
      depth--; j++;
      if (depth === 0) return { text: src.slice(i, j + 1), end: j + 1 };
    }
  }
  return null;
}

/**
 * 取某一项（如 /Resources /Font）的值：可能是内联字典、也可能是 "N 0 R" 引用。
 * 返回解析后的字典文本（引用会顺着对象表解开）。
 */
function resolveDictValue(src: string, dict: string, key: string, objs: Map<number, PdfObject>): string | null {
  const k = dict.indexOf(key);
  if (k < 0) return null;
  const after = k + key.length;
  const inline = readDict(dict, after);
  if (inline) return inline.text;
  // 引用形式：/Font 12 0 R
  const ref = /^\s*(\d+)\s+\d+\s+R/.exec(dict.slice(after));
  if (ref) return objs.get(parseInt(ref[1], 10))?.dict ?? null;
  return null;
}

// ---------------------------------------------------------------- ToUnicode CMap

/** UTF-16BE 十六进制串 → 字符串 */
function hexToUnicode(hex: string): string {
  let out = '';
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const code = parseInt(hex.substr(i, 4), 16);
    if (!isNaN(code) && code !== 0) out += String.fromCharCode(code);
  }
  return out;
}

/**
 * 解析 ToUnicode CMap。
 * 支持 beginbfchar（逐条）与 beginbfrange（区间），这是 Word/Acrobat 导出 PDF 的标准形态。
 */
function parseCMap(cmap: string): Map<number, string> {
  const map = new Map<number, string>();

  for (const block of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block))) map.set(parseInt(m[1], 16), hexToUnicode(m[2]));
  }

  for (const block of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    // 形式一：<lo> <hi> [<d1> <d2> ...]
    const listRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
    let handled = new Set<number>();
    let m: RegExpExecArray | null;
    while ((m = listRe.exec(block))) {
      const lo = parseInt(m[1], 16);
      const items: string[] = m[3].match(/<([0-9A-Fa-f]*)>/g) || [];
      items.forEach((it, idx) => {
        map.set(lo + idx, hexToUnicode(it.replace(/[<>]/g, '')));
      });
      handled.add(lo);
    }
    // 形式二：<lo> <hi> <dst>（连续递增）
    const rangeRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    while ((m = rangeRe.exec(block))) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (handled.has(lo)) continue;
      const base = parseInt(m[3], 16);
      const span = Math.min(hi - lo, 65535);
      for (let i = 0; i <= span; i++) {
        if (base + i > 0) map.set(lo + i, String.fromCharCode(base + i));
      }
    }
  }
  return map;
}

/** 收集某页面可用的字体（名称 → 解码信息） */
function collectFonts(
  src: string,
  dict: string,
  objs: Map<number, PdfObject>
): Map<string, FontInfo> {
  const fonts = new Map<string, FontInfo>();
  const resDict = resolveDictValue(src, dict, '/Resources', objs);
  if (!resDict) return fonts;
  const fontDict = resolveDictValue(src, resDict, '/Font', objs);
  if (!fontDict) return fonts;

  // /F1 13 0 R /F2 14 0 R ...
  const re = /\/([^\s/\[\]<>(){}]+)\s+(\d+)\s+\d+\s+R/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fontDict))) {
    const name = m[1];
    const obj = objs.get(parseInt(m[2], 10));
    if (!obj) continue;

    const twoByte = /\/Subtype\s*\/Type0/.test(obj.dict);
    let cmap: Map<number, string> | null = null;

    const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(obj.dict);
    if (tu) {
      const cmapObj = objs.get(parseInt(tu[1], 10));
      if (cmapObj?.stream) cmap = parseCMap(toLatin1(cmapObj.stream));
    }
    fonts.set(name, { twoByte, cmap });
  }
  return fonts;
}

// ---------------------------------------------------------------- 内容流解析

/** 读取 (...) 字面量字符串，处理转义；返回原始字节串（每字符 = 1 字节代码） */
function readLiteralString(s: string, start: number): { raw: string; next: number } | null {
  let depth = 0;
  let out = '';
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === 'n') { out += '\n'; i++; }
      else if (n === 'r') { out += '\r'; i++; }
      else if (n === 't') { out += '\t'; i++; }
      else if (n === 'b') { out += '\b'; i++; }
      else if (n === 'f') { out += '\f'; i++; }
      else if (n === '\n' || n === '\r') { i++; } // 续行
      else if (n >= '0' && n <= '7') {
        // 最多三位八进制
        let oct = '';
        let j = i + 1;
        while (j < s.length && oct.length < 3 && s[j] >= '0' && s[j] <= '7') oct += s[j++];
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        i = j - 1;
      } else { out += n; i++; }
      continue;
    }
    if (c === '(') { depth++; out += c; continue; }
    if (c === ')') {
      depth--;
      if (depth === 0) return { raw: out, next: i + 1 };
      out += c;
      continue;
    }
    out += c;
  }
  return null; // 未闭合
}

/** 读取 <hex> 字符串 */
function readHexString(s: string, start: number): { raw: string; next: number } | null {
  const end = s.indexOf('>', start);
  if (end < 0) return null;
  const hex = s.slice(start + 1, end).replace(/\s/g, '');
  return { raw: hex, next: end + 1 };
}

/** 把（已解出字节代码的）字符串按当前字体解码为 Unicode */
function decodeText(raw: string, font: FontInfo | undefined, isHex: boolean): string {
  // 十六进制：先还原成字节串
  let bytes = raw;
  if (isHex) {
    let s = '';
    for (let i = 0; i + 1 < raw.length; i += 2) s += String.fromCharCode(parseInt(raw.substr(i, 2), 16));
    bytes = s;
  }

  const cmap = font?.cmap;
  let out = '';

  if (cmap && cmap.size) {
    if (font?.twoByte) {
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const code = (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1);
        const u = cmap.get(code);
        out += u !== undefined ? u : '';
      }
    } else {
      for (let i = 0; i < bytes.length; i++) {
        const u = cmap.get(bytes.charCodeAt(i));
        out += u !== undefined ? u : '';
      }
    }
  } else if (font?.twoByte) {
    // Type0 但缺 ToUnicode：Identity-H 下大部分是 UTF-16BE，尽力直读
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1);
      if (code >= 0x20 && code !== 0xfffd) out += String.fromCharCode(code);
    }
  } else {
    // 简单字体：按 Latin-1 直读（WinAnsi/MacRoman 的 ASCII 区一致）
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes.charCodeAt(i);
      if (c === 0) continue;
      out += c >= 0x20 ? String.fromCharCode(c) : ' ';
    }
  }

  // 注意：Chrome/Skia 子集字体会产生一个「空白字形」（CID 0x03 → U+0020），
  // 它既可能承载真实空格（"Araldite CY1578"），也可能只是字体切换处的零宽占位
  // （"适用_于"）。所以这里一律保留，由 locate() 依据它是否真的占宽度来决定去留。
  return out;
}

/**
 * 估算一段文本的视觉宽度（em 倍数 × 字号）。
 * 用于判断「上一次绘制结束的位置」与「下一次绘制开始的位置」之间是否真的有空隙 ——
 * 这是决定要不要补空格的关键，不能只比较两个起点的距离（那会把 "Technical"
 * 误判成 "T echnical"）。
 * 估算刻意偏大：偏大只会漏补空格（退化为粘连），偏小会误插空格把单词拆开（更有害）。
 */
function estimateWidth(s: string, fontSize: number): number {
  let em = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c === 0x20) em += 0.28;
    else if (c >= 0x4e00 && c <= 0x9fff) em += 1.0; // CJK 统一汉字
    else if (c >= 0x3000 && c <= 0x303f) em += 1.0; // CJK 标点
    else if (c >= 0xff00 && c <= 0xff60) em += 1.0; // 全角
    else if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) em += 0.6;
    else em += 0.35;
  }
  return em * fontSize;
}

/**
 * 解析内容流 → 文本。
 *
 * 行/段判定基于纵向位移 dy 与字号的比值：
 *   dy < 0.5×字号  → 同一行
 *   dy < 1.9×字号  → 换行
 *   dy ≥ 1.9×字号  → 换段
 * 同一行内若两段绘制之间存在明显空隙（如表格的并列单元格），补一个空格。
 *
 * 注意：BT 只重置文本矩阵，**不作为换行信号** —— 实测 Chrome 导出的 PDF 会把
 * 表格同一行的多个单元格各放进一个 BT 块（y 相同），以 BT 换行会把一行拆散。
 */
function extractContentText(content: string, fonts: Map<string, FontInfo>): string {
  let out = '';
  let curFont: FontInfo | undefined;
  let fontSize = 11;
  let curY = 0;
  let curX = 0;
  let lastY: number | null = null;
  let drawX = 0; // 当前绘制片段的起始 x
  let drawW = 0; // 当前片段累计的估算宽度
  let pendingName: string | null = null;
  const nums: number[] = [];
  let i = 0;
  const N = content.length;

  const brk = () => {
    if (!out) return;
    out = out.replace(/[ \t]+$/, '');
    if (!out.endsWith('\n')) out += '\n';
  };
  const para = () => {
    if (!out) return;
    brk();
    if (!out.endsWith('\n\n')) out += '\n';
  };
  // 输出一段解码后的文本，顺带清理「中文之间的伪空格」。
  // 实测 Chrome/Skia 子集字体会产生一个空白字形（CID 0x03），推进量仅 0.05em，
  // 夹在两个汉字之间时纯属噪声（「适用于」→「适用 于」、「测试方法」→「测试方 法」），
  // 但它同时承载着真实的分隔（"Araldite CY1578"、"固化剂 80"：两侧至少有一侧是
  // 拉丁字母/数字）。所以只在「空格前后两侧都是 CJK」时才删除，其余一律保留。
  const CJK_RE = /[\u2e80-\u2fff\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
  const emit = (t: string) => {
    if (!t) return;
    if (out.endsWith(' ') && CJK_RE.test(t[0]) && CJK_RE.test(out.replace(/ +$/, '').slice(-1))) {
      out = out.replace(/ +$/, '');
    }
    out += t;
    drawW += estimateWidth(t, fontSize);
  };

  // 定位到 (x,y)，并结算「上一段文本」与本次定位之间的行/段/栏位关系
  const locate = (x: number, y: number) => {
    if (lastY === null) { lastY = y; drawX = x; drawW = 0; return; }
    const dy = Math.abs(y - lastY);
    const gap = x - (drawX + drawW); // 上一段绘制结束处 → 本次起点 的真实空隙
    if (dy >= fontSize * 1.9) para();
    else if (dy >= fontSize * 0.5) brk();
    // 阈值 0.45em 来自实测：真实表格列间隙约 0.65em，而字间距一律 ≤0.28em，
    // 中间是空的，取中点最稳。阈值偏高只会漏补空格（退化为粘连），
    // 偏低则会误插空格把单词/词切碎（更有害）。
    else if (gap > fontSize * 0.45 && out && !/\s$/.test(out)) out += ' ';
    lastY = y;
    drawX = x;
    drawW = 0;
  };

  while (i < N) {
    const c = content[i];

    // 内联图像 BI ... EI：整体跳过，避免二进制污染文本
    if (c === 'B' && content[i + 1] === 'I' && !/[A-Za-z]/.test(content[i + 2] || '')) {
      const ei = content.indexOf('EI', i + 2);
      i = ei < 0 ? i + 2 : ei + 2;
      continue;
    }

    if (c === '(') {
      const r = readLiteralString(content, i);
      if (r) {
        emit(decodeText(r.raw, curFont, false));
        i = r.next;
        continue;
      }
      i++;
      continue;
    }
    if (c === '<' && content[i + 1] !== '<') {
      const r = readHexString(content, i);
      if (r) {
        emit(decodeText(r.raw, curFont, true));
        i = r.next;
        continue;
      }
      i++;
      continue;
    }
    if (c === '<') {
      const d = readDict(content, i);
      i = d ? d.end : i + 1;
      continue;
    }
    if (c === '/') {
      const m = /^\/([^\s/\[\]<>(){}]+)/.exec(content.slice(i));
      if (m) { pendingName = m[1]; i += m[0].length; continue; }
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '*') {
      // ' 和 " 隐含换行显示；* 是 T* 的星号
      brk();
      nums.length = 0;
      i++;
      continue;
    }
    if (/[+\-\d.]/.test(c)) {
      const m = /^[+\-]?\d*\.?\d+/.exec(content.slice(i));
      if (m) { nums.push(parseFloat(m[0])); i += m[0].length; continue; }
      i++;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      const m = /^[A-Za-z'"*]+/.exec(content.slice(i));
      if (!m) { i++; continue; }
      const op = m[0];
      i += m[0].length;

      if (op === 'Tf') {
        if (pendingName) {
          const f = fonts.get(pendingName);
          if (f) curFont = f;
          pendingName = null;
        }
        const fs = nums[nums.length - 1];
        if (typeof fs === 'number' && fs > 0 && fs < 200) fontSize = fs;
      } else if (op === 'BT') {
        // BT 把文本矩阵重置为原点，此后 Tm/Td 给出的是该块内的坐标。
        // 这里刻意【不】强制换行：实测 Chrome 导出的 PDF 会把表格同一行的多个
        // 单元格各放进一个 BT 块（y 相同），强制换行会把一行拆成好几行。
        // 同时【不】重置 lastY —— 保留上一块的 y，紧跟的 Tm 才能算出真实行距/段距。
        curY = 0;
        curX = 0;
      } else if (op === 'Td' || op === 'TD') {
        // Td 的两参数是 tx ty
        curY += nums[nums.length - 1] || 0;
        curX += nums[nums.length - 2] || 0;
        locate(curX, curY);
      } else if (op === 'Tm') {
        // Matrix 六参数 a b c d e f —— e 为横向位移、f 为纵向位移
        const ny = nums[nums.length - 1];
        const nx = nums[nums.length - 2];
        if (typeof ny === 'number') {
          curY = ny;
          curX = typeof nx === 'number' ? nx : 0;
          locate(curX, curY);
        }
      } else if (op === 'TJ') {
        // TJ 数组内的数字是「千分之一 em」的字距调整，负值表示向右让开。
        // -120 这种量级（0.12em）只是正常的字偶距微调，不能当空格；
        // 只有让开 ≥0.6em 才是真正的段落内空隙。
        if (nums.some((v) => v <= -600)) out += ' ';
      }
      nums.length = 0;
      continue;
    }
    i++;
  }

  return out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 逐行文本 → 段落。
 *
 * extractContentText 已经用 \n\n 标出了段边界（依据纵向位移判断），
 * 这里只负责把「段内的换行」合并回一行 —— 因为在 PDF 里一次换行往往只是
 * 排版的折行，并非语义分段，保留单换行会让 chunk 碎成一行一块。
 */
function linesToParagraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => {
      let out = '';
      for (const raw of para.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (!out) { out = line; continue; }
        // 中中文之间不加空格；英文/数字相邻才补空格
        const needSpace = /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(line);
        out += (needSpace ? ' ' : '') + line;
      }
      return out.trim();
    })
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------- 页面树

/** 按 /Root → /Pages → /Kids 递归收集页面对象，保证页序 */
function collectPages(src: string, objs: Map<number, PdfObject>): PdfObject[] {
  // 找 Catalog
  let rootNum: number | null = null;
  const rootRef = /\/Root\s+(\d+)\s+\d+\s+R/.exec(src);
  if (rootRef) rootNum = parseInt(rootRef[1], 10);
  if (rootNum === null) {
    for (const o of objs.values()) {
      if (/\/Type\s*\/Catalog/.test(o.dict)) { rootNum = o.num; break; }
    }
  }

  const pages: PdfObject[] = [];
  const walk = (num: number, depth: number) => {
    if (depth > 12) return;
    const obj = objs.get(num);
    if (!obj) return;
    if (/\/Type\s*\/Page\b/.test(obj.dict) && !/\/Type\s*\/Pages/.test(obj.dict)) {
      pages.push(obj);
      return;
    }
    const kidRef = /\/Kids\s*\[([\s\S]*?)\]/.exec(obj.dict);
    if (kidRef) {
      const re = /(\d+)\s+\d+\s+R/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(kidRef[1]))) walk(parseInt(m[1], 10), depth + 1);
    }
  };

  if (rootNum !== null) {
    const catalog = objs.get(rootNum);
    const pagesRef = catalog ? /\/Pages\s+(\d+)\s+\d+\s+R/.exec(catalog.dict) : null;
    if (pagesRef) walk(parseInt(pagesRef[1], 10), 0);
  }

  // 兜底：直接扫描所有 /Type /Page
  if (!pages.length) {
    for (const o of objs.values()) {
      if (/\/Type\s*\/Page\b/.test(o.dict) && !/\/Type\s*\/Pages/.test(o.dict)) pages.push(o);
    }
    pages.sort((a, b) => a.num - b.num);
  }
  return pages;
}

/** 取页面的内容流文本（/Contents 可能是单个引用或引用数组） */
function pageContent(src: string, page: PdfObject, objs: Map<number, PdfObject>): string {
  const k = page.dict.indexOf('/Contents');
  if (k < 0) return '';
  const after = page.dict.slice(k + '/Contents'.length);

  const parts: string[] = [];
  const arr = /^\s*\[([\s\S]*?)\]/.exec(after);
  const refs: number[] = [];
  if (arr) {
    const re = /(\d+)\s+\d+\s+R/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(arr[1]))) refs.push(parseInt(m[1], 10));
  } else {
    const one = /^\s*(\d+)\s+\d+\s+R/.exec(after);
    if (one) refs.push(parseInt(one[1], 10));
  }
  for (const n of refs) {
    const o = objs.get(n);
    if (o?.stream) parts.push(toLatin1(o.stream));
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------- 对外入口

/** 提取 PDF 文本。纯函数、无 IO，iOS / Web / Node 三端通用。 */
export function pdfExtractText(bytes: Uint8Array): PdfExtractResult {
  try {
    const src = toLatin1(bytes);

    // 加密 PDF 无法处理，直接返回（避免给出错误文本）
    if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(src) || /\/Encrypt\s*<</.test(src)) {
      return { text: '', pageCount: 0, hasTextLayer: false, quality: 0, note: 'PDF 已加密，无法解析' };
    }

    const objs = scanObjects(src, bytes);
    const pages = collectPages(src, objs);

    const pageTexts: string[] = [];
    for (const p of pages) {
      const content = pageContent(src, p, objs);
      if (!content) { pageTexts.push(''); continue; }
      const fonts = collectFonts(src, p.dict, objs);
      pageTexts.push(linesToParagraphs(extractContentText(content, fonts)));
    }

    // 归一化：把字体子集化产生的兼容码位（康熙部首等）还原为标准汉字，
    // 否则「适用于」这类词永远搜不到。
    const text = normalizeCjkCompat(pageTexts.filter(Boolean).join('\n\n').trim());
    const pageCount = pages.length;

    // 质量评估：可打印字符比例 × 每页字符密度
    const printable = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffefA-Za-z0-9\p{P}\s]/gu) || []).length;
    const ratio = text.length ? printable / text.length : 0;
    const perPage = pageCount ? text.length / pageCount : 0;

    let quality = 0;
    if (text.length > 0 && pageCount > 0) {
      quality = Math.min(1, ratio) * Math.min(1, perPage / 200);
    }
    const hasTextLayer = text.length >= 20 && perPage >= 10;

    let note: string | undefined;
    if (!hasTextLayer) note = '未检测到文本层，可能是扫描件（需要 OCR）';
    else if (quality < 0.4) note = '文本提取质量较低，可能存在乱码';

    return { text, pageCount, hasTextLayer, quality: Math.round(quality * 100) / 100, note };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { text: '', pageCount: 0, hasTextLayer: false, quality: 0, note: `解析异常：${msg}` };
  }
}

/** 便捷判断：文件名是否 PDF */
export const isPdfName = (name: string) => /\.pdf$/i.test(name);
