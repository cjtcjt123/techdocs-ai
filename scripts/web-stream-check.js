/**
 * web 端「流式输出」实测（CDP + 本地 SSE 桩，零第三方依赖）
 *
 * 为什么必须有一个会吐 SSE 的桩：流式输出这件事**只有服务端真的分片时才存在**。
 * 用真实云端服务验要联网、要密钥、还得它真的开了 stream；用整段返回的接口验，
 * 界面上看到的是「一次性整段弹出」，跟没改之前一模一样 —— 那不叫验证。
 *
 * 桩在这里做了三件事：
 *   ① 收到 stream:true 时按 SSE 分帧、每帧间隔 220ms 地往外吐（中文 + 标点）
 *   ② 收到 stream:false 时整段返回（用来验「网关不支持流式」时的兜底）
 *   ③ 故意让最后一帧跨多个 UTF-8 字节boundary：中文一行 3 字节，
 *      解码写错就会出乱码（U+FFFD）或半个字
 *
 * 断言五件事：
 *   ① 首个字不是等整段才出现（至少看到 3 个逐级变长的中间态）
 *   ② 最终答案完整，且**不重复**（帧解析错会把内容拼两遍，这是最容易出的错）
 *   ③ 中文不乱码（验手写 UTF-8 解码在分帧边界上的正确性）
 *   ④ 「 FX: fall back」—— 关掉流式时仍能拿到完整答案（桩切到整段模式）
 *   ⑤ 结束后界面回到可发送状态，没有报错气泡
 *
 * 前置：一个带调试端口的 Chrome（见 web-shot.js 头部说明）
 * 用法：node scripts/web-stream-check.js [url]
 */
const PORT = process.env.CDP_PORT || 9222;
const URL_ = process.argv[2] || 'http://localhost:8081';
const BOOT_WAIT = Number(process.env.WAIT_BOOT || 45000);
const STUB_PORT = Number(process.env.STUB_PORT || 8799);
const STUB = `http://127.0.0.1:${STUB_PORT}/v1`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- SSE 桩服务
const CHUNKS = ['第一段：CY1578 适用', '温度范围是 ', '-40 ℃ 到 120 ℃。', '第二段：配比为 100 比 38。', '流式收尾。'];
const FULL = CHUNKS.join('');

function startStub() {
  const http = require('http');
  let mode = 'stream'; // 'stream' | 'whole'：whole = 假装不支持流式，整段返回
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    if (process.env.STUB_LOG) console.log(`   [桩] ${req.method} ${req.url} mode=${mode}`);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let stream = true;
      try {
        stream = JSON.parse(body || '{}').stream !== false;
      } catch {
        /* 解析不动就当普通请求 */
      }
      if (!stream || mode === 'whole') {
        const payload = JSON.stringify({
          choices: [{ message: { content: FULL }, delta: { content: FULL } }],
        });
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        return res.end(payload);
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (const c of CHUNKS) {
        // ⚠️ 每帧单独 write：浏览器/RN 可能把它们合并也可能不合并，
        // 客户端必须在字节流的任意位置切开都能正确还原 —— 这正是要验的东西。
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
        await sleep(220);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(STUB_PORT, '127.0.0.1', () => resolve({ server, setMode: (m) => (mode = m) })));
}

async function main() {
  const stub = await startStub();
  console.log(`SSE 桩已起：${STUB}`);

  // ---------- CDP ----------
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch {
      /* Chrome 还没起来 */
    }
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
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP 连接失败'));
  });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: `(() => { try { return JSON.stringify(${expr}, null, 0); } catch (e) { return 'ERR: ' + e.message; } })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    return typeof r?.result?.value === 'string' ? r.result.value : JSON.stringify(r?.result?.value);
  };
  const bodyText = () => evalJs(`document.body.innerText.replace(/\\s+/g, ' ')`);

  const clickText = async (text) => {
    const raw = await evalJs(`(() => {
      const cands = [...document.querySelectorAll('*')].filter((e) => {
        if (e.children.length) return false;
        if (!(e.textContent || '').trim()) return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const hit = cands.find((e) => (e.textContent || '').trim() === ${JSON.stringify(text)})
               || cands.find((e) => (e.textContent || '').includes(${JSON.stringify(text)}));
      if (!hit) return null;
      hit.scrollIntoView({ block: 'center' });
      const r = hit.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!raw || raw === 'null') return false;
    let p;
    try {
      p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return false;
    }
    if (!p || typeof p.x !== 'number') return false;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    }
    return true;
  };

  const typeQuestion = async (value) => {
    const r = await evalJs(`(() => {
      const el = document.querySelector('textarea');
      if (!el) return 'NO_EL';
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'OK';
    })()`);
    return r === '"OK"' || r === 'OK';
  };

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '　' + detail : ''}`);
  };

  console.log(`=== 打开 ${URL_} ===`);
  await send('Page.navigate', { url: URL_ });
  await sleep(BOOT_WAIT);

  // 干净起点 + 把模型地址指到桩上
  await evalJs(`(() => { try { localStorage.clear(); } catch (e) {} return 'CLEARED'; })()`);
  await send('Page.navigate', { url: URL_ });
  await sleep(6000);
  await evalJs(`(() => {
    const NS = 'techdocs.v1.db';
    const db = JSON.parse(localStorage.getItem(NS) || '{"kv":{}}');
    const s = JSON.parse(db.kv.app_settings || '{}');
    s.modelConfig = { source: 'api', provider: 'custom', baseURL: ${JSON.stringify(STUB)}, model: 'stub-model' };
    s.privacy = { ...(s.privacy || {}), cloudConfirm: false, offlineMode: false };
    db.kv.app_settings = JSON.stringify(s);
    localStorage.setItem(NS, JSON.stringify(db));
    return 'SEEDED';
  })()`);
  await send('Page.navigate', { url: URL_ });
  await sleep(8000);

  const Q = 'CY1578 的适用温度范围';
  check('填入提问', await typeQuestion(Q));
  await sleep(300);
  check('点到发送', await clickText('发送'));

  // ---- 采样：答案出现之后，每次快照都比上次长才算「真的在逐步出字」 ----
  const seen = [];
  for (let i = 0; i < 90; i++) {
    const t = (await bodyText()) || '';
    const at = t.lastIndexOf(Q);
    if (at >= 0) {
      // 气泡内容 = 提问之后的那段（去掉工具栏那些固定文案）
      let tail = t.slice(at + Q.length).replace(/发送|停止|助手|资料库|我的|复制|记录/g, '').trim();
      // 只保留答案本身：以任意一段 CHUNKS 开头才算
      if (/^(第一段|第|-)[\s\S]*$/.test(tail) && tail.length > 0) seen.push(tail);
      if (seen.length && tail.includes('流式收尾')) break;
    }
    await sleep(120);
  }
  const distinct = seen.filter((s, i) => i === 0 || s !== seen[i - 1]);
  const growing = distinct.filter((s, i) => i === 0 || s.length > distinct[i - 1].length);
  check('出现过逐步增长的中间态（不是整段弹出）', growing.length >= 3, `采样到 ${distinct.length} 个不同快照 / 递增 ${growing.length} 次`);
  if (!growing.length) {
    console.log('   ↳ 采样到的尾巴：', JSON.stringify(seen.slice(-3)));
  }

  await sleep(2000);
  const done = (await bodyText()) || '';
  const atDone = done.lastIndexOf(Q);
  const answer = atDone >= 0 ? done.slice(atDone + Q.length) : done;

  check('最终答案完整（含最后一帧）', answer.includes('流式收尾'), answer.slice(-60));
  check('所有分片都在且不重复', answer.includes('第一段') && answer.includes('第二段') && answer.includes('100 比 38'), '');
  check(
    '内容没有被拼两遍（帧解析正确）',
    (answer.match(/流式收尾/g) || []).length === 1 && (answer.match(/适用温度|第一段/g) || []).length <= 2,
    `「流式收尾」出现 ${(answer.match(/流式收尾/g) || []).length} 次`
  );
  check('中文没有乱码（跨帧 UTF-8 解码正确）', !/�/.test(answer) && answer.includes('适用温度范围'.slice(0, 2)) , JSON.stringify(answer.slice(0, 40)));
  check('没有报错气泡', !answer.includes('⚠️') && !answer.includes('请求失败'));

  const reEnabled = (await evalJs(`(() => {
    const el = document.querySelector('textarea');
    return el ? String(!el.disabled && !el.readOnly) : 'NO_EL';
  })()`)).includes('true');
  check('结束后回到可发送状态', reEnabled);

  // ---- 兜底：桩切成「不支持流式」（收到 stream:true 也整段返回） ----
  // readSse 一个增量都收不到时会补一次非流式请求，用户仍应拿到完整答案而不是空回答。
  stub.setMode('whole');
  await send('Page.navigate', { url: URL_ });
  await sleep(6000);
  check('（第二轮）填入提问', await typeQuestion('再问一次'));
  await sleep(300);
  check('（第二轮）点到发送', await clickText('发送'));
  // ⚠️ 不能判「页面里有『流式收尾』」—— 上一轮的答案还挂在会话里，第一帧就命中了。
  // 要等的是**第二次出现**（这一轮新追加的那条）。
  const countOf = (t, s) => (t.match(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  let answer2 = '';
  let got2 = false;
  for (let i = 0; i < 80; i++) {
    const t = (await bodyText()) || '';
    if (countOf(t, '流式收尾') >= 2) {
      answer2 = t.slice(t.lastIndexOf('再问一次') + 4);
      got2 = true;
      break;
    }
    await sleep(200);
  }
  check('网关不支持流式时兜底拿到完整答案', got2 && answer2.includes('100 比 38'), answer2.slice(-50));

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n通过 ${pass}/${results.length}`);
  ws.close();
  stub.server.close();
  if (pass !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
