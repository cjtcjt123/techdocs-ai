/**
 * 资料自动分类 —— 纯函数，不碰 IO。
 *
 * 存在理由：资料库的「分组」以前是半接线状态 —— 分组规则写好了（`tags[0] || meta.model`），
 * 但导入时不写标签、`meta.model` 又没有任何一处赋值，于是所有资料一律落进「未分组」，
 * 界面上等于没有分类。这里就是那个缺失的「数据来源」。
 *
 * 两个维度：
 *   · model 型号（CY1578 / HY5192 …）—— 环氧树脂资料的主轴
 *   · kind  文档类型（TDS / 规格书 / 检验报告 …）—— 做比对时的主轴
 * 第三个维度是用户自己的 tags（自由标签），不归这里管。
 *
 * ⚠️ 识别结果只是「给个起点」，用户可以在资料库里改 —— 所以宁可留空也不要瞎猜：
 *    猜错比不猜更糟（用户会以为界面在骗他）。拿不准就返回 undefined，让资料落进「未分类」。
 */
import type { DocKind } from '../types';

/**
 * 文档类型的中文名 —— 分组头、筛选 chip、卡片副标题共用。
 * ⚠️ 一律用短名：卡片副标题只有一行，「采购规格书」这种长名会把后面「本地解析 615字」挤掉。
 */
export const KIND_LABEL: Record<DocKind, string> = {
  tds: 'TDS',
  spec: '规格书',
  report: '检验报告',
  sds: '安全表',
  other: '未分类',
};

/** 可选类型的顺序（界面 chip 与手工选择共用，保证顺序一致） */
export const KIND_ORDER: DocKind[] = ['tds', 'spec', 'report', 'sds', 'other'];

/**
 * 类型判定规则。顺序 = 优先级。
 * 先扫文件名（最可靠），扫不到再扫正文开头（封面/页眉 usually 在这一段）。
 */
const KIND_RULES: Array<{ kind: DocKind; re: RegExp }> = [
  { kind: 'tds', re: /T\.?D\.?S\.?|Technical\s*Data\s*Sheet|Product\s*Data|技术数据表|产品数据表|技术数据单/i },
  { kind: 'spec', re: /Spec(?:ification)?\b|采购规范|采购规格|技术规格|规格书|技术要求|技术条件/i },
  { kind: 'report', re: /C\.?O\.?A\.?|Certificate\s*of\s*Analysis|检验报告|检测报告|质检报告|分析报告|试验报告/i },
  { kind: 'sds', re: /M?S\.?D\.?S\.?|Safety\s*Data\s*Sheet|安全数据表|安全技术说明书/i },
];

/**
 * 型号形如 `CY1578` / `HY-5192` / `CY 179`：2~4 个大写字母 + 3~5 位数字。
 * ⚠️ 不写成 `/[A-Z]{2,4}\d{3,5}/` 而允许中间的连字符/空格 —— 真实文件名里 `CY-1578.pdf` 很常见。
 */
const MODEL_RE = /\b([A-Z]{2,4})[-\s_]?(\d{3,5})([A-Z])?\b/g;

/** 只扫正文开头这么多个字符：型号/类型都写在封面或页眉，扫全文既慢又容易被表格里的数字污染。 */
const TEXT_SCAN = 3000;

/** 正文里出现几次才敢认定是型号（1 次可能是巧合或引用） */
const MODEL_MIN_HITS = 2;

/** 这些前缀看着像型号，其实是标准号/牌号以外的东西 */
const MODEL_BLOCK = new Set(['ISO', 'GB', 'GBU', 'ASTM', 'DIN', 'JIS', 'EN', 'IEC', 'HTTP', 'WWW', 'PDF']);

function normalizeModel(m: string): string {
  // `CY-1578` / `CY 1578` → `CY1578`，保证同名型号不会分成两组
  return m.replace(/[-\s_]/g, '').toUpperCase();
}

/**
 * 从一段文字里找型号。返回出现次数最多的那个（平局取先出现的）。
 * @param minHits 至少出现几次才认定。**文件名调用时传 1** —— 文件名里的型号本来就只写一次。
 */
export function pickModel(text: string, minHits = MODEL_MIN_HITS): string | undefined {
  const src = text.slice(0, TEXT_SCAN);
  const hits = new Map<string, { n: number; first: number }>();
  MODEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MODEL_RE.exec(src))) {
    const letters = m[1];
    if (MODEL_BLOCK.has(letters)) continue;
    const key = normalizeModel(m[0]);
    const cur = hits.get(key);
    if (cur) cur.n++;
    else hits.set(key, { n: 1, first: m.index });
  }
  let best: string | undefined;
  let bestN = 0;
  let bestFirst = Number.MAX_SAFE_INTEGER;
  for (const [key, v] of hits) {
    if (v.n > bestN || (v.n === bestN && v.first < bestFirst)) {
      best = key; bestN = v.n; bestFirst = v.first;
    }
  }
  return bestN >= minHits ? best : undefined;
}

/** 判定文档类型。文件名优先（最可靠），扫不到再看正文开头。 */
export function pickKind(name: string, text = ''): DocKind | undefined {
  for (const { kind, re } of KIND_RULES) if (re.test(name)) return kind;
  const src = text.slice(0, TEXT_SCAN);
  for (const { kind, re } of KIND_RULES) if (re.test(src)) return kind;
  return undefined;
}

/**
 * 导入时的自动分类入口。
 * 型号：文件名优先（`-CY1578-中文名.pdf` 这种命名很常见），文件名没有才去正文里找。
 * 类型：同上，文件名优先。
 */
export function classifyDoc(name: string, text = ''): { model?: string; kind?: DocKind } {
  // 文件名里的型号本来就只出现一次，不该受「至少两次」的限制
  const fromName = pickModel(name, 1);
  return {
    model: fromName || pickModel(text),
    kind: pickKind(name, text),
  };
}
