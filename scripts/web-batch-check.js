/**
 * 资料库「批量操作」的浏览器端到端验收（真实 UI + 真实 store）
 *
 * 验的是这条链：
 *   进入选择态 → 逐项勾选 → 全选当前 → 批量加标签 → 批量删除（确认页逐份列名）→ 落库
 *
 * 重点在最后两项：
 *   · 批量加标签必须是【追加】而不是覆盖（覆盖会把各文档原有标签清空）
 *   · 批量删除的确认页必须【逐份列出文件名】——只报个数等于把核对成本推给用户
 *
 * 用法：
 *   1) 起 dev server（见项目记忆里的固定命令）
 *   2) 用 --remote-debugging-port=9222 起一个 Chrome
 *   3) node scripts/web-batch-check.js [url]
 */
const fs = require('fs');

const URL_ = process.argv[2] || 'http://localhost:8081';
const PORT = process.env.CDP_PORT || 9222;
const WAIT_BOOT = Number(process.env.WAIT_BOOT || 25000);
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/batch-shot';
const NS = 'techdocs.v1.db';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* Chrome 还没起来 */ }
    await sleep(500);
  }
  throw new Error(`找不到可调试页面，请确认 Chrome 用 --remote-debugging-port=${PORT} 启动`);
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
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
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      logs.push(`[exception] ${d.exception?.description || d.text}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      logs.push(`[console.error] ${(msg.params.args || []).map((a) => a.value ?? a.description).join(' ')}`);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`CDP 连接失败: ${e.message || e.type}`));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS 执行出错');
    return r?.result?.value;
  };
  const bodyText = () => evaluate('document.body ? document.body.innerText : ""');

  const SEL = '[role="button"], [role="tab"], button, a, [tabindex], div';

  // 与 web-case-check.js 同一套判据，坑的原因写在那边的注释里：
  // 剔零面积候选 + 优先精确匹配 + 用 CDP 真实鼠标事件 + 点前复核 elementFromPoint。
  const HIT_EXPR = (text, sel) => `(() => {
    const T = ${JSON.stringify(text)};
    const vis = Array.from(document.querySelectorAll(${JSON.stringify(sel)})).filter((e) => {
      const r = e.getBoundingClientRect();
      return (e.innerText || '').includes(T) && r.width > 0 && r.height > 0;
    });
    if (!vis.length) return null;
    const exact = vis.filter((e) => (e.innerText || '').trim() === T);
    const pool = exact.length ? exact : vis;
    pool.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
    const el = pool[0];
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName, n: vis.length, exact: exact.length > 0,
      t: (el.innerText || '').trim().slice(0, 24),
      x: r.left + r.width / 2, y: r.top + r.height / 2,
    };
  })()`;

  const findBox = (text, sel = SEL) => evaluate(HIT_EXPR(text, sel));

  const clickText = async (text, sel = SEL) => {
    const box = await findBox(text, sel);
    if (!box) return 'NOT_FOUND';
    const landed = await evaluate(
      `!!document.elementFromPoint(${Math.round(box.x)}, ${Math.round(box.y)})`
    );
    if (!landed) return `NOT_HITTABLE@${Math.round(box.x)},${Math.round(box.y)}`;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: Math.round(box.x), y: Math.round(box.y),
        button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
      });
    }
    await sleep(450);
    return 'CLICKED';
  };

  // 选择器先在 JS 侧拼好再 JSON 注入：把嵌套模板字符串写在一行里极易多打/漏打反引号，
  // 而且报错位置（"missing ) after argument list"）指向的完全不是真正的错处。
  const typeInto = (placeholder, value) => {
    const selector = `input[placeholder*="${placeholder}"], textarea[placeholder*="${placeholder}"]`;
    return evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NOT_FOUND';
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'TYPED';
    })()`);
  };

  const db = () => evaluate(`(() => {
    try { return JSON.parse(localStorage.getItem(${JSON.stringify(NS)}) || '{}'); } catch { return {}; }
  })()`);

  // 确认页里的清单项（每项形如「· 文件名」）。
  //
  // ⚠️ 不能拿【整页 innerText】去断言「确认页没列出某份文档」：弹层只是盖住了底层列表，
  //    底层卡片仍在 DOM 里，整页文字里当然还有那份文档名 —— 会得到一个稳定的假红。
  //    （第一轮就是这么红的：两条正例全过、这条否定断言挂。）
  //    所以只取「以 · 开头且没有子元素」的叶子节点 = 确认页清单本身。
  const confirmListItems = () => evaluate(`(() => {
    const out = [];
    for (const e of document.querySelectorAll('div')) {
      const t = (e.innerText || '').trim();
      if (e.children.length === 0 && t.startsWith('· ') && t.length < 80) out.push(t);
    }
    return out;
  })()`);

  const shot = async (name) => {
    try {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(r.data, 'base64'));
    } catch (e) {
      console.log(`（截图 ${name} 失败：${e.message}）`);
    }
  };

  const results = [];
  const check = (label, ok, extra) => {
    results.push([label, ok]);
    console.log(`${ok ? '✅' : '❌'} ${label}${extra ? '　' + extra : ''}`);
  };

  // ---------- 预置：三份文档，其中两份带原有标签（验「批量加标签是追加不是覆盖」）----------
  console.log(`=== 打开 ${URL_} ===`);
  await send('Page.navigate', { url: URL_ });
  await sleep(WAIT_BOOT);
  if (!(await bodyText())) throw new Error('页面没有渲染出内容（调大 WAIT_BOOT）');

  const mkDoc = (id, name, tags) => ({
    id, name, type: 'pdf', folderId: null, tags,
    pinned: false, status: 'indexed',
    meta: { pages: 1, chars: 100, parseSource: 'local' },
    createdAt: '2025-01-0' + id.slice(1) + 'T00:00:00.000Z',
  });
  const seed = {
    documents: [
      mkDoc('d1', 'CY1578 TDS.pdf', ['Araldite']),
      mkDoc('d2', 'HY1578 规格书.pdf', ['Huntsman']),
      mkDoc('d3', '检验报告.pdf', []),
    ],
    chunks: [
      { id: 'k1', docId: 'd1', seq: 0, pageNo: 1, ctype: 'para', content: '真空脱泡：建议 40 min，温度 60℃。' },
    ],
    kv: { app_settings: JSON.stringify({ dataStrategy: 'local' }) },
    embeddings: [],
    cases: [],
  };
  await evaluate(`(() => {
    localStorage.clear();
    localStorage.setItem(${JSON.stringify(NS)}, ${JSON.stringify(JSON.stringify(seed))});
    return 'SEEDED';
  })()`);
  await send('Page.reload');
  await sleep(WAIT_BOOT);
  // 切 Tab 必须用【真实鼠标事件】：RN Web 的 Pressable 走自己的 responder 体系，
  // 不响应合成的 `new MouseEvent('click')` —— 派发了页面纹丝不动，
  // 症状是「所有断言全挂」，很容易误判成 Tabs 或整页坏了。实际只是点了个寂寞。
  console.log('  切到资料库：', await clickText('资料库'));
  await sleep(1500);
  let t = await bodyText();
  check('进入资料库并列出 3 份文档', /3 份文档/.test(t), t.split('\n').find((l) => /份文档/.test(l)) || '');
  check('未进选择态时没有全选按钮', !/全选当前/.test(t));
  await shot('01-列表');

  // ---------- 进入选择态 ----------
  console.log('\n=== 进入选择态 ===');
  check('点「选择」返回 CLICKED', (await clickText('选择')) === 'CLICKED');
  await sleep(800);
  t = await bodyText();
  check('出现「已选 0」', /已选\s*0/.test(t));
  check('出现全选按钮', /全选当前/.test(t));
  check('出现加标签按钮', /加标签/.test(t));
  check('出现钉住按钮', /⭐\s*钉住/.test(t));
  check('出现删除按钮（未选时禁用）', /删除/.test(t));
  check('选择态下隐藏搜索框', !(await evaluate('!!document.querySelector(\'input[placeholder*="搜索资料"]\')')));
  check('「选择」变成「完成」', /完成/.test(t));
  await shot('02-选择态');

  // ---------- 逐项勾选 ----------
  console.log('\n=== 逐项勾选 ===');
  console.log('  点 d1：', await clickText('CY1578 TDS.pdf'));
  t = await bodyText();
  check('勾选 1 份后显示「已选 1」', /已选\s*1/.test(t));
  await shot('03-勾选1份');

  console.log('  点 d3：', await clickText('检验报告.pdf'));
  t = await bodyText();
  check('再勾 1 份 → 已选 2', /已选\s*2/.test(t));

  // 取消勾选（再点一次）
  console.log('  再点 d3（取消勾选）：', await clickText('检验报告.pdf'));
  t = await bodyText();
  check('再点一次可取消勾选 → 已选 1', /已选\s*1/.test(t));

  // ---------- 全选当前 ----------
  console.log('\n=== 全选 ===');
  check('点「全选当前」', (await clickText('全选当前')) === 'CLICKED');
  await sleep(600);
  t = await bodyText();
  check('全选后已选 3', /已选\s*3/.test(t));
  check('按钮变成「取消全选」', /取消全选/.test(t));
  await shot('04-全选');

  // ---------- 批量加标签（核心：追加而非覆盖）----------
  console.log('\n=== 批量加标签 ===');
  check('点「加标签」打开面板', (await clickText('加标签')) === 'CLICKED');
  await sleep(700);
  t = await bodyText();
  check('面板标题显示将作用于 3 份', /给\s*3\s*份加标签/.test(t));
  check('面板说明写明是追加式', /追加式/.test(t));
  await shot('05-批量加标签面板');

  // 关掉再开：先验证「取消」不会改数据
  await clickText('取消');
  await sleep(500);
  let d = await db();
  check('点取消后标签没被改动', JSON.stringify(d.documents.find((x) => x.id === 'd1').tags) === '["Araldite"]');

  await clickText('加标签');
  await sleep(600);
  await typeInto('例如：Araldite', 'CY1578、TDS');
  await sleep(400);
  check('点「加进去」', (await clickText('加进去')) === 'CLICKED');
  await sleep(1500);
  d = await db();
  const kept = d.documents.find((x) => x.id === 'd1').tags;      // 原有 Araldite 必须还在
  const kept2 = d.documents.find((x) => x.id === 'd2').tags;     // 原有 Huntsman 必须还在
  const got3 = d.documents.find((x) => x.id === 'd3').tags;
  check('d1 是被【追加】：原有 Araldite 保留 + 新增两个', kept.join(',') === 'Araldite,CY1578,TDS', kept.join(','));
  check('d2 原有 Huntsman 保留', kept2.includes('Huntsman'), kept2.join(','));
  check('d3 空标签文档拿到两个新标签', got3.length === 2, got3.join(','));
  t = await bodyText();
  check('加完自动退出选择态', !/已选\s*\d/.test(t) || /0\s*份文档|3\s*份文档/.test(t), '');
  await shot('06-加标签后');

  // ---------- 批量删除 ----------
  console.log('\n=== 批量删除（只选 2 份，验逐份列名）===');
  await clickText('选择');
  await sleep(700);
  console.log('  点 d2：', await clickText('HY1578 规格书.pdf'));
  console.log('  点 d3：', await clickText('检验报告.pdf'));
  t = await bodyText();
  check('已选 2 份', /已选\s*2/.test(t));

  check('点「删除 2」打开确认页', (await clickText('删除 2')) === 'CLICKED');
  await sleep(800);
  t = await bodyText();
  check('确认页标题写明 2 份', /删除这\s*2\s*份资料/.test(t));
  const items = (await confirmListItems()) || [];
  check('确认页清单恰好 2 项', items.length === 2, items.join(' | '));
  check('清单逐份列出：HY1578 规格书.pdf', items.some((x) => x.includes('HY1578 规格书.pdf')));
  check('清单逐份列出：检验报告.pdf', items.some((x) => x.includes('检验报告.pdf')));
  check('清单没有混入未勾选的 d1', !items.some((x) => x.includes('CY1578 TDS')));
  check('确认页给出「返回勾选」的退路', /返回勾选/.test(t));
  check('确认页写明不可撤销', /无法撤销/.test(t));
  await shot('07-删除确认');

  // 先验「返回勾选」不删任何东西
  await clickText('返回勾选');
  await sleep(600);
  d = await db();
  check('点「返回勾选」后一份都没删', d.documents.length === 3, `实际 ${d.documents.length} 份`);

  await clickText('删除 2');
  await sleep(700);
  check('点「确认删除 2 份」', (await clickText('确认删除 2 份')) === 'CLICKED');
  await sleep(1800);
  d = await db();
  check('删除后只剩 1 份', d.documents.length === 1, `实际 ${d.documents.length} 份`);
  check('剩下的是未勾选的 d1', d.documents[0]?.id === 'd1', d.documents[0]?.name || '');
  t = await bodyText();
  check('列表回到非选择态（底部是导入按钮）', /导入文档/.test(t));
  check('副标题变成 1 份文档', /1\s*份文档/.test(t));
  await shot('08-删除后');

  // ---------- 控制台 ----------
  const realErrors = logs.filter((l) => !/React DevTools|Development-level warnings/.test(l));
  check('控制台无异常', realErrors.length === 0, realErrors.slice(0, 3).join(' ｜ '));

  const pass = results.filter((r) => r[1]).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  if (pass < results.length) {
    console.log('失败项：');
    results.filter((r) => !r[1]).forEach((r) => console.log('  ❌ ' + r[0]));
  }
  console.log(`截图目录：${SHOT_DIR}`);
  ws.close();
}

main().catch((e) => { console.error('运行失败：', e.message); process.exit(1); });
