/**
 * 「文字被悄悄裁掉」的扫描表达式（共用）。
 *
 * 为什么值得抽出来：RN Web 的 <Text> 是 overflow:hidden 的盒子，盒子高度由字体度量与 flex
 * 布局共同决定。一旦被压小，汉字下半截会无声消失 —— 截图上看不出「本该是几个字」，肉眼极难发现。
 * 底部 Tab 标签就踩过这个坑（盒子塌到 10px、行高 normal，只给 fontSize 时行盒不够高）。
 *
 * 判定要区分两种「溢出」：
 *  ① 真裁切（要报）：盒子高度 < 它承诺显示的行数应有的高度 → 字形被切，且没有省略号兜住。
 *  ② 正常截断（不报）：numberOfLines 引起的 -webkit-line-clamp，盒子正好 N×lineHeight，
 *     多出的部分由浏览器补省略号 —— 来源卡的引文就是 2 行 + …，是设计意图。
 *
 * 门槛取 1px（不是 2px）：拉丁文 10px 字号下常只差 1px（clientHeight 10 / scrollHeight 11），
 * 汉字差得多。宁可略多报，也别放过。
 */
const SCAN_EXPR = `(() => {
  const bad = [];
  const px = (v, fallback) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback; // lineHeight 可能是 "normal"
  };
  for (const el of document.querySelectorAll('*')) {
    const hasOwnText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && n.textContent.trim().length > 0
    );
    if (!hasOwnText) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowY === 'visible' && cs.overflow === 'visible') continue; // 不裁切就不可能被切
    const over = el.scrollHeight - el.clientHeight;
    if (over < 1) continue;

    const fs = px(cs.fontSize, 12);
    const lh = px(cs.lineHeight, fs * 1.2);
    const clampRaw = cs.webkitLineClamp;
    const clamp = Number.isFinite(parseFloat(clampRaw)) ? parseInt(clampRaw, 10)
                : cs.whiteSpace.includes('nowrap') ? 1 : 0;
    // 盒子高度 >= 承诺行数的高度 → 溢出的是「多出来的行」，由省略号兜住，不算字形裁切
    if (clamp > 0 && el.clientHeight >= clamp * lh - 1) continue;

    bad.push({
      text: (el.textContent || '').trim().slice(0, 16),
      overflowY: +over.toFixed(0),
      h: +el.clientHeight.toFixed(0),
      need: +(clamp > 0 ? clamp * lh : lh).toFixed(0),
      clamp: clampRaw === 'none' ? (clamp || '-') : clampRaw,
      lh: cs.lineHeight, fs: cs.fontSize, ff: cs.fontFamily.slice(0, 18),
    });
  }
  return bad;
})()`;

const describe = (b) =>
  `「${b.text}」 溢出 ${b.overflowY}px（盒高 ${b.h}px 需要 ${b.need}px · clamp=${b.clamp} lh=${b.lh} fs=${b.fs}）`;

module.exports = { SCAN_EXPR, describe };
