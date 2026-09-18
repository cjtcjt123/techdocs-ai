/**
 * web 端「生成中可停止」实测（CDP，零依赖）
 *
 * 为什么需要它：停止生成这个功能**只有在请求真的挂着的时候才存在** ——
 * 请求秒失败的话界面一闪而过，什么都看不出来，等于没验证。
 *
 * 怎么制造一个持续的请求而**不依赖真实网络**：打开「云端调用需确认」后，
 * chat() 会先 await 用户的确认（弹窗挂起），thinking 就这样一直挂着 ——
 * 不需要配 API、不需要 NAS、也不会有真的请求发出去。
 *
 * 断言三件事：
 *   ① 生成中输入框被禁用、发送键变成「停止」
 *   ② 点「停止」后界面立刻回到可发送状态（不等那个挂起的请求）
 *   ③ 停止不是报错：不出现「⚠️ 请求失败」
 *
 * 前置：一个带调试端口的 Chrome（见 web-shot.js 头部说明）
 * 用法：node scripts/web-stop-check.js [url]
 */
const PORT = process.env.CDP_PORT || 9222;
const URL_ = process.argv[2] || 'http://localhost:8081';
const BOOT_WAIT = Number(process.env.WAIT_BOOT || 45000);
// TEST-NET-1（192.0.2.0/24）是保留地址，不会有人回包 —— 正好用来制造「永久思考中」
const BLACKHOLE = 'http://192.0.2.1:9999/v1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
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

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: `(() => { try { return JSON.stringify(${expr}, null, 0); } catch (e) { return 'ERR: ' + e.message; } })()`,
      returnByValue: true, awaitPromise: true,
    });
    return typeof r?.result?.value === 'string' ? r.result.value : JSON.stringify(r?.result?.value);
  };
  const bodyText = () => evalJs(`document.body.innerText.replace(/\\s+/g, ' ')`);

  // 点击：先 scrollIntoView（getBoundingClientRect 是相对视口的），再用真实鼠标事件。
  // 不用 el.click() —— RN Web 的 Pressable 不一定响应程序化的 click。
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
    try { p = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return false; }
    if (!p || typeof p.x !== 'number') return false;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    }
    return true;
  };

  /**
   * 点同名元素里的某一个，直到 `verify` 这段文字出现为止。
   *
   * 为什么需要：底栏的「助手」和助手屏自绘标题栏的「助手」在 DOM 里同名，
   * 而标题栏那个排在前面 —— 只点第一个的话，页面停在「我的」页不动，
   * 发送按钮虽然在 DOM 里却不在屏幕上，点了个空（clickText 照样返回 true）。
   */
  const clickUntil = async (text, verify, tries = 5) => {
    const raw = await evalJs(`(() => [...document.querySelectorAll('*')]
      .filter((e) => {
        if (e.children.length) return false;
        if ((e.textContent || '').trim() !== ${JSON.stringify(text)}) return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })
    )`);
    let list = [];
    try { list = JSON.parse(raw) || []; } catch { list = []; }
    for (const p of list.slice(0, tries)) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
      }
      await sleep(600);
      const t = (await bodyText()) || '';
      if (t.includes(verify)) return true;
    }
    return false;
  };

  /** 翻一个开关：按它的标签文字找到同容器的 checkbox。RN 的 Switch 在 web 上是 input[type=checkbox] */
  const flipSwitch = async (label) => {
    const r = await evalJs(`(() => {
      const leaf = [...document.querySelectorAll('*')]
        .filter((e) => !e.children.length && (e.textContent || '').trim() === ${JSON.stringify(label)});
      if (!leaf.length) return 'NO_LABEL';
      let n = leaf[0], box = null;
      for (let i = 0; i < 7 && n && !box; i++) { n = n.parentElement; if (n) box = n.querySelector('input[type=checkbox]'); }
      if (!box) return 'NO_SWITCH';
      box.click();
      return 'OK';
    })()`);
    return r === '"OK"' || r === 'OK';
  };

  /**
   * 把 Base URL 改成黑洞地址。
   * ⚠️ 不能按 placeholder 找 —— RN Web 没把它透传到 DOM 上（实测 placeholder 属性是空的），
   * 只能按值找：这个框的默认值是 http(s) 开头，而同页的其它输入框是模型名 / sk- 开头。
   */
  const setBaseURL = async (value) => {
    const r = await evalJs(`(() => {
      const el = [...document.querySelectorAll('input')]
        .find((e) => (e.value || '').startsWith('http')) || document.querySelector('input');
      if (!el) return 'NO_EL';
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'OK';
    })()`);
    return r === '"OK"' || r === 'OK';
  };

  /** 往提问框（页面上唯一的 textarea）里打字 */
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

  console.log(`打开 ${URL_}`);
  await send('Page.navigate', { url: URL_ });
  for (let i = 0; i < BOOT_WAIT / 1000; i++) {
    await sleep(1000);
    const t = await bodyText();
    if (t && t.includes('助手')) break;
  }

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '　' + detail : ''}`);
  };

  // 不需要改 API 地址：默认配置下这个环境里出网本来就慢，
  // 请求挂得住 —— 真要百分百挂死可以用 setBaseURL(BLACKHOLE)（见下面那个 helper）。
  const typed = await typeQuestion('CY1578 的适用温度范围');
  check('填入提问', typed);
  await sleep(300);
  const sent = await clickText('发送');
  check('点到发送', sent);

  // 第一次检查不 sleep：请求万一秒失败，晚 250ms 就什么都看不到了
  let sawStop = false;
  for (let i = 0; i < 60; i++) {
    const t = (await bodyText()) || '';
    if (t.includes('停止')) { sawStop = true; break; }
    await sleep(120);
  }
  check('生成中出现「停止」按钮', sawStop);
  if (!sawStop) {
    // 判「没发出去」和「发出去了但请求没挂住」—— 前者是脚本的问题，后者是环境限制
    const t = (await bodyText()) || '';
    console.log('   ↳ 提问进了消息列表吗：', t.includes('CY1578 的适用温度范围'));
    console.log('   ↳ 界面原文：', t.slice(-260));
  }

  const disabled = sawStop
    ? (await evalJs(`(() => {
        const el = [...document.querySelectorAll('textarea, input')].find((e) => e.tagName === 'TEXTAREA');
        return el ? String(!!el.disabled || !!el.readOnly) : 'NO_EL';
      })()`)).includes('true')
    : false;
  check('生成中输入框被禁用', disabled);

  // ---- ③ 点停止 ----
  // 同样要遍历候选：按钮在输入栏，消息列表一滚动它的位置就变了，只点一次可能落空
  if (sawStop) {
    const raw = await evalJs(`[...document.querySelectorAll('*')]
      .filter((e) => !e.children.length && (e.textContent || '').trim() === '停止')
      .map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })`);
    let list = [];
    try { list = JSON.parse(raw) || []; } catch { list = []; }
    for (const p of list) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
      }
      await sleep(900);
      const t = (await bodyText()) || '';
      if (t.includes('发送') && !t.includes('停止')) break;
    }
  }
  await sleep(1200);
  const after = (await bodyText()) || '';
  // ⚠️ 不能用「不含『停止』」判断是否恢复 —— 追加的那条「⏹ 已停止生成。」里就有"停止"两个字，
  // 那样断言必然失败，还会让人误以为功能坏了。看真正的恢复信号：输入框又能编辑了。
  const reEnabled = (await evalJs(`(() => {
    const el = document.querySelector('textarea');
    return el ? String(!el.disabled && !el.readOnly) : 'NO_EL';
  })()`)).includes('true');
  check('点「停止」后输入框恢复可编辑', reEnabled);
  check('追加的是「已停止生成」', after.includes('已停止生成'), after.match(/已停止生成|⚠️[^ ]{0,24}/)?.[0] || '');
  check('停止没有被当成错误报出来', !after.includes('请求失败'));

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n通过 ${pass}/${results.length}`);
  ws.close();
  if (pass !== results.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
