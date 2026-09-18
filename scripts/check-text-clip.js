#!/usr/bin/env node
/**
 * 文字裁切自检：扫整个界面，找出「文字盒子装不下自己」的元素。
 *
 * 为什么需要它：RN Web 里 <Text> 是 overflow:hidden 的盒子，高度由字体度量与 flex 布局共同决定。
 * 一旦盒子被压小（flexShrink、没给 lineHeight、写死高度），汉字的下半截会被静静切掉 —— 截图上看
 * 不出「本该是几个字」，肉眼很容易漏。底部 Tab 标签就踩过：盒子塌到 10px、行高 normal。
 * 判据（含「为什么 2 行的省略号不算问题」）见 scripts/lib/text-clip-scan.js。
 *
 * 用法：node scripts/check-text-clip.js [url] [等待毫秒] [要点击的文本...]
 *   例：node scripts/check-text-clip.js http://localhost:8081 15000 资料库 问答 对比
 * 退出码：有疑似裁切为 1，全干净为 0（可直接进流水线）
 */
const { SCAN_EXPR } = require('./lib/text-clip-scan');

const URL_ = process.argv[2] || 'http://localhost:8081';
const WAIT = Number(process.argv[3] || 15000);
const CLICKS = process.argv.slice(4);
const PORT = process.env.CDP_PORT || 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Chrome 还没起来
    }
    await sleep(500);
  }
  throw new Error(`找不到可调试页面（Chrome 需带 --remote-debugging-port=${PORT}）`);
}

// RN web 的 Pressable 认 pointer 事件，只发 click 不一定触发
const clickExpr = (text) => `(() => {
  const cands = Array.from(document.querySelectorAll('[role="button"], [role="tab"], button, a, [tabindex]'));
  const hits = cands.filter(e => (e.innerText || '').includes(${JSON.stringify(text)}));
  if (!hits.length) return 'NOT_FOUND';
  const el = hits[0];
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  ['pointerdown', 'pointerup', 'click'].forEach(t => el.dispatchEvent(new MouseEvent(t, opts)));
  return 'CLICKED';
})()`;

async function main() {
  const target = await findPageTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });

  const evalIn = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS 出错');
    return r?.result?.value;
  };

  await send('Page.navigate', { url: URL_ });
  await sleep(WAIT);

  let totalBad = 0;
  const screens = ['（首屏）', ...CLICKS];

  for (let i = 0; i < screens.length; i++) {
    if (i > 0) {
      const st = await evalIn(clickExpr(CLICKS[i - 1]));
      await sleep(2500);
      if (st !== 'CLICKED') console.log(`（点击「${CLICKS[i - 1]}」失败：${st}）`);
    }
    const bad = await evalIn(SCAN_EXPR);
    console.log(`\n=== 第 ${i + 1} 屏 ${screens[i]} ===`);
    if (!bad?.length) {
      console.log('✅ 没有文字被裁切');
    } else {
      totalBad += bad.length;
      for (const b of bad) {
        console.log(`❌ 「${b.text}」 溢出 ${b.overflowY}px · 盒高 ${b.h}px 但需要 ${b.need}px · clamp=${b.clamp} lh=${b.lh} fs=${b.fs} · ${b.ff}`);
      }
    }
  }

  console.log(`\n合计疑似裁切元素：${totalBad}`);
  ws.close();
  process.exit(totalBad ? 1 : 0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
