// 文本切块（纯函数，无 IO、无平台依赖）—— 单独成文件是为了能被离线脚本直接跑：
// 切块粒度是检索精度的地基，必须能脱离 App 单独测（见 scripts/test-retrieval.mjs）
import type { Chunk } from '../types';

const CHUNK_MAX = 800; // 单块硬上限（超长再切）
// 超过这个长度、又没在句末收尾的行，判定为「排版折行」而非「逻辑行」，
// 与下一行拼接后再成块（阈值取中文正文一行的大致容量）
const LONG_LINE = 38;
// 短于这个长度的行、且不以标点收尾 → 视作小标题 / 表格行（用于折行的前瞻判断）
const HEADING_LEN = 12;
const SENTENCE_END = /[。！？；：、）】」”!?;:]\s*$/;
const CJK_END = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff）】」”]$/;
const CJK_START = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff（【「“]/;

/**
 * 文本切块 —— 检索的最小单元，粒度直接决定检索与引用的精度。
 *
 * 为什么不能只按空行切：一份 TDS 解析出来往往是「一页 = 一个空行段」，
 * 里面塞着产品描述 + 整张参数表 + 工艺说明。按段成块的话，问「弯曲强度多少」
 * 会命中整页，引用只能定位到页、无法定位到那一行，逐项比对也就没法做。
 *
 * 这里按「逻辑行」切，并区分两种换行：
 *   · 表格行 / 小标题 —— 短，或含数值，本身就是一个完整信息单元，独立成块；
 *   · 排版折行 —— 编者按版面宽度硬折的，不是语义边界，必须和下一行拼回去，
 *     否则「…具有优异的力学性能与耐」会被切成孤立的一块。
 * 判据是「行够长 + 没在句末收尾」→ 折行；段落边界（空行）则强制断开。
 */
export function chunkText(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let seq = 0;
  let buf = '';

  const flush = () => {
    const content = buf.trim();
    buf = '';
    if (!content) return;
    for (let i = 0; i < content.length; i += CHUNK_MAX) {
      const piece = content.slice(i, i + CHUNK_MAX);
      if (!piece) break;
      chunks.push({ id: `${seq}`, docId: '', seq: seq++, content: piece, ctype: 'para' });
    }
  };

  for (const para of text.split(/\n{2,}/)) {
    const lines = para.split('\n').map((s) => s.trim()).filter(Boolean);
    for (let li = 0; li < lines.length; li++) {
      const s = lines[li];
      const next = lines[li + 1];
      if (buf) {
        // 中文折行处本就没有空格（PDF 解析已清掉伪空格），英文折行则必须补一个，
        // 否则 May / cause 会粘成 Maycause
        buf += CJK_END.test(buf) && CJK_START.test(s) ? s : ` ${s}`;
      } else {
        buf = s;
      }
      if (buf.length >= LONG_LINE && !SENTENCE_END.test(buf)) {
        // 长且未在句末收尾 → 大概率是排版折行，等下一行拼上。
        // 但若下一行明显是「小标题 / 表格行」（很短且不以标点收尾），
        // 说明本行其实是完整的逻辑行 —— 英文标题行很容易掉进这个坑：
        // 「Technical Data Sheet — Bisphenol A epoxy resin」后面跟着「产品描述」
        const nextIsHeading = !!next && next.length < HEADING_LEN && !SENTENCE_END.test(next);
        if (!nextIsHeading) continue;
      }
      flush();
    }
    flush(); // 段落边界必定断开
  }
  flush();
  return chunks;
}
