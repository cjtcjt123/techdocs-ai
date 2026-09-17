#!/usr/bin/env node
/**
 * web 预览视觉验证工具（零依赖，走 Chrome DevTools Protocol）
 *
 * 背景：`chrome --headless --screenshot` 对本项目会卡死——Expo dev server 的 HMR
 * WebSocket 长连接让 `--virtual-time-budget` 永远走不完；且本机外层沙箱会让 Chrome
 * 自带沙箱初始化失败（GPU 进程 FATAL），必须加 `--no-sandbox`。
 * 本脚本改用 CDP：导航 → 固定等待 → 截图 + 控制台错误 + 页面可见文本，可顺带点击若干
 * 元素（如切换 Tab）逐屏截图，然后立即退出，不留僵尸进程。
 *
 * 用法：
 *   1) 先起一个带调试端口的 Chrome：
 *      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *        --headless=new --no-sandbox --disable-gpu --remote-debugging-port=9222 \
 *        --user-data-dir=/tmp/chrome-cdp-profile about:blank &
 *   2) node scripts/web-shot.js [url] [输出前缀] [等待毫秒] [要点击的文本...]
 *      例：node scripts/web-shot.js http://localhost:8081 /tmp/shot 20000 问答 我的
 */
const fs = require('fs');

const URL_ = process.argv[2] || 'http://localhost:8081';
const OUT_PREFIX = process.argv[3] || '/tmp/webapp';
const WAIT = Number(process.argv[4] || 15000);
const CLICKS = process.argv.slice(5);
const PORT = process.env.CDP_PORT || 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Chrome 还没起来，重试
    }
    await sleep(500);
  }
  throw new Error(`找不到可调试页面，请确认 Chrome 已用 --remote-debugging-port=${PORT} 启动`);
}

// 可点击元素：RN web 的 Pressable 监听 pointerdown/pointerup，只发 click 不一定触发
const clickExpr = (text) => `(() => {
  const t = ${JSON.stringify(text)};
  const cands = Array.from(document.querySelectorAll('[role="button"], button, a, [tabindex]'));
  const el = cands.find(e => (e.innerText || '').trim() === t)
          || cands.find(e => (e.innerText || '').includes(t));
  if (!el) return 'NOT_FOUND';
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  ['pointerdown', 'pointerup', 'click'].forEach(type => {
    el.dispatchEvent(new MouseEvent(type, opts));
  });
  return 'CLICKED';
})()`;

async function main() {
  const target = await findPageTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  let seq = 0;
  const pending = new Map();
  const logs = [];

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      logs.push(`[${msg.params.type}] ${text}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      logs.push(`[exception] ${d.exception?.description || d.text || '未知异常'}`);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      logs.push(`[log-error] ${msg.params.entry.text}`);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`CDP 连接失败: ${e.message || e.type}`));
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });

  await send('Page.navigate', { url: URL_ });
  await sleep(WAIT);

  const visible = async () => {
    const r = await send('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : "(no body)"',
      returnByValue: true,
    });
    return String(r?.result?.value || '');
  };

  const shoot = async (file) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`  → ${file}`);
  };

  console.log(`=== 第 1 屏：${URL_} ===`);
  await shoot(`${OUT_PREFIX}-0.png`);
  console.log((await visible()).slice(0, 500) || '(空)');

  for (let i = 0; i < CLICKS.length; i++) {
    const label = CLICKS[i];
    const r = await send('Runtime.evaluate', { expression: clickExpr(label), returnByValue: true });
    const state = r?.result?.value;
    await sleep(2500);
    console.log(`\n=== 点击「${label}」（${state}）后 ===`);
    await shoot(`${OUT_PREFIX}-${i + 1}.png`);
    console.log((await visible()).slice(0, 500) || '(空)');
  }

  console.log('\n=== 控制台输出 / 异常 ===');
  console.log(logs.length ? logs.slice(0, 40).join('\n') : '(无)');

  ws.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
