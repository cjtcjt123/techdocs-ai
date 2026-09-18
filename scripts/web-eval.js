/**
 * 在已连着的调试页面里执行一段 JS，把结果打印出来。
 *
 * 用途：断言失败时唯一有效的下一步 —— 直接看浏览器里的真实数据
 *      （localStorage 里到底存了什么、某个元素到底在哪），
 *      而不是盯着测试脚本的输出猜。
 *
 * 用法：
 *   node scripts/web-eval.js 'Object.keys(localStorage)'
 *   node scripts/web-eval.js 'JSON.parse(localStorage.getItem("techdocs.v1.db")).cases' 
 *   echo '...' | node scripts/web-eval.js -        # 表达式从 stdin 读，避开引号地狱
 */
const fs = require('fs');

const PORT = process.env.CDP_PORT || 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let expr = process.argv[2];
  if (!expr || expr === '-') expr = fs.readFileSync(0, 'utf8');
  if (!expr.trim()) throw new Error('没有表达式：node scripts/web-eval.js "<js>"');

  let target;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* Chrome 还没起来 */ }
    if (!target) await sleep(500);
  }
  if (!target) throw new Error(`找不到可调试页面（--remote-debugging-port=${PORT}）`);

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
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 连接失败')); });

  const r = await send('Runtime.evaluate', {
    expression: `(() => { try { return JSON.stringify(${expr}, null, 2); } catch (e) { return 'ERR: ' + e.message; } })()`,
    returnByValue: true, awaitPromise: true,
  });
  if (r?.exceptionDetails) {
    console.error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    process.exitCode = 1;
  } else {
    console.log(r?.result?.value);
  }
  ws.close();
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
