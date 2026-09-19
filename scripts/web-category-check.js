/**
 * 「我的分类」的浏览器端到端验收（真实 UI + 真实 store）
 *
 * 验的是这条链：
 *   建分类 → 批量归入 → 按分类分组 → 改名（级联改资料）→ 设默认 → 问答按分类限定 → 删分类（不动资料）
 *
 * 为什么要单独一个脚本：分类是**单选**维度，和标签（多值、自由）是两套语义。
 * 最容易写错的三处，本脚本逐条盯着：
 *   · 改名必须级联改文档上的 meta.category —— 只改表会留下「幽灵分组」
 *   · 删除分类**不能**清掉已归入文档的归属（用户的归类工作不该被一次删除冲掉）
 *   · 问答按分类限定时，钉住的资料仍要带进来（范围与钉住不是互斥关系）
 *
 * 用法：
 *   1) 起 dev server（见项目记忆里的固定命令）
 *   2) 用 --remote-debugging-port=9222 起一个 Chrome
 *   3) node scripts/web-category-check.js [url]
 */
const fs = require('fs');

const URL_ = process.argv[2] || 'http://localhost:8081';
const PORT = process.env.CDP_PORT || 9222;
const WAIT_BOOT = Number(process.env.WAIT_BOOT || 25000);
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/category-shot';
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

  // 同 web-batch-check.js 的判据（坑的原因写在那边）：
  // 剔零面积候选 + 优先精确匹配 + CDP 真实鼠标事件 + 点前复核 elementFromPoint。
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

  /** 设置里的分类相关字段（categories / defaultCategory / retrieval.category） */
  const catState = async () => {
    const d = await db();
    let s = {};
    try { s = JSON.parse(d.kv?.app_settings || '{}'); } catch { /* 没有就算了 */ }
    return {
      categories: s.categories || [],
      defaultCategory: s.defaultCategory || '',
      retrievalCategory: s.retrieval?.category || '',
      docs: (d.documents || []).map((x) => ({ id: x.id, name: x.name, cat: x.meta?.category || '' })),
    };
  };

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

  // ---------- 预置：三份文档，都不带分类 ----------
  console.log(`=== 打开 ${URL_} ===`);
  await send('Page.navigate', { url: URL_ });
  await sleep(WAIT_BOOT);
  if (!(await bodyText())) throw new Error('页面没有渲染出内容（调大 WAIT_BOOT）');

  const mkDoc = (id, name) => ({
    id, name, type: 'pdf', folderId: null, tags: [],
    pinned: false, status: 'indexed',
    meta: { pages: 1, chars: 100, parseSource: 'local' },
    createdAt: '2025-01-0' + id.slice(1) + 'T00:00:00.000Z',
  });
  const seed = {
    documents: [
      mkDoc('d1', 'CY1578 TDS.pdf'),
      mkDoc('d2', 'HY1578 规格书.pdf'),
      mkDoc('d3', '拉挤工艺参数表.pdf'),
    ],
    chunks: [{ id: 'k1', docId: 'd1', seq: 0, pageNo: 1, ctype: 'para', content: '真空脱泡：建议 40 min。' }],
    kv: { app_settings: JSON.stringify({ dataStrategy: 'local', categories: [] }) },
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
  console.log('  切到资料库：', await clickText('资料库'));
  await sleep(1500);
  let t = await bodyText();
  check('进入资料库并列出 3 份文档', /3 份文档/.test(t), t.split('\n').find((l) => /份文档/.test(l)) || '');
  await shot('01-列表');

  // ---------- 分组维度里要有「分类」 ----------
  console.log('\n=== 分组维度 ===');
  check('点「分类」切换分组维度', (await clickText('分类')) === 'CLICKED');
  await sleep(700);
  t = await bodyText();
  check('四个维度 chip 都在（型号/类型/分类/标签）',
    /型号/.test(t) && /类型/.test(t) && /标签/.test(t));
  check('还没有分类时 3 份全落「未分组」', /未分组\s*·\s*3/.test(t), (t.match(/未分组[^\n]*/) || [''])[0]);
  check('分类维度给的是「新建分类」入口而不是「补分类」',
    /新建分类/.test(t) && !/补分类\s*\d/.test(t));
  await shot('02-未分组');

  // ---------- 建两个分类 ----------
  console.log('\n=== 新建分类 ===');
  check('点「＋ 新建分类」', (await clickText('＋ 新建分类')) === 'CLICKED');
  await sleep(800);
  t = await bodyText();
  check('打开分类管理面板', /我的分类/.test(t));
  check('面板说明「问答时也能只查某一个分类」', /只查某一个分类/.test(t));
  await shot('03-管理面板空');

  check('输入「拉挤行业」', (await typeInto('例如：拉挤行业', '拉挤行业')) === 'TYPED');
  await sleep(400);
  check('点「＋ 添加」', (await clickText('＋ 添加')) === 'CLICKED');
  await sleep(900);
  let st = await catState();
  check('分类已落库：拉挤行业', st.categories.includes('拉挤行业'), st.categories.join('/'));
  check('第一个分类自动成为「新导入默认归入」', st.defaultCategory === '拉挤行业', st.defaultCategory);

  await typeInto('例如：拉挤行业', '高压行业');
  await sleep(400);
  await clickText('＋ 添加');
  await sleep(900);
  st = await catState();
  check('第二个分类也建好了', st.categories.join(',') === '拉挤行业,高压行业', st.categories.join(','));
  check('默认分类不被第二个覆盖', st.defaultCategory === '拉挤行业', st.defaultCategory);
  t = await bodyText();
  check('面板里两个分类都列出（带份数）', /拉挤行业\s*·\s*0\s*份/.test(t) && /高压行业/.test(t));
  await shot('04-两个分类');

  check('关掉面板', (await clickText('关闭')) === 'CLICKED');
  await sleep(600);

  // ---------- 批量归入 ----------
  console.log('\n=== 批量归入分类 ===');
  check('点「选择」', (await clickText('选择')) === 'CLICKED');
  await sleep(800);
  console.log('  点 d1：', await clickText('CY1578 TDS.pdf'));
  console.log('  点 d3：', await clickText('拉挤工艺参数表.pdf'));
  t = await bodyText();
  check('已选 2 份', /已选\s*2/.test(t));

  check('点「归入分类」', (await clickText('归入分类')) === 'CLICKED');
  await sleep(800);
  t = await bodyText();
  check('面板写明作用于 2 份', /把这\s*2\s*份归入/.test(t));
  check('面板说明是「设为」不是追加', /「设为」/.test(t));
  await shot('05-归入面板');

  check('点「拉挤行业」', (await clickText('拉挤行业')) === 'CLICKED');
  await sleep(1500);
  st = await catState();
  const c1 = st.docs.find((x) => x.id === 'd1')?.cat;
  const c3 = st.docs.find((x) => x.id === 'd3')?.cat;
  const c2 = st.docs.find((x) => x.id === 'd2')?.cat;
  check('d1 归入拉挤行业', c1 === '拉挤行业', c1);
  check('d3 归入拉挤行业', c3 === '拉挤行业', c3);
  check('未勾选的 d2 不受影响', !c2, c2 || '(空)');
  await sleep(400);
  t = await bodyText();
  check('分组头显示「拉挤行业 · 2」', /拉挤行业\s*·\s*2/.test(t), (t.match(/拉挤行业[^\n]*/) || [''])[0]);
  check('剩下的落在「未分组 · 1」', /未分组\s*·\s*1/.test(t));
  await shot('06-归入后');

  // ---------- 改名要级联改资料 ----------
  console.log('\n=== 改名（级联）===');
  check('点「管理分类」', (await clickText('管理分类')) === 'CLICKED');
  await sleep(800);
  check('点「改名」', (await clickText('改名')) === 'CLICKED');
  await sleep(700);
  t = await bodyText();
  check('改名面板提示会连带改 2 份资料', /2\s*份资料会一起改过来/.test(t), (t.match(/\d+ 份资料会一起改过来/) || [''])[0]);
  check('输入新名', (await typeInto('分类名', '拉挤工艺')) === 'TYPED');
  await sleep(300);
  check('点「保存」', (await clickText('保存')) === 'CLICKED');
  await sleep(1800);
  st = await catState();
  check('分类表里的名字改了', st.categories.includes('拉挤工艺'), st.categories.join('/'));
  check('**文档上的分类跟着改了**（不是留下幽灵分组）',
    st.docs.find((x) => x.id === 'd1')?.cat === '拉挤工艺',
    st.docs.map((x) => `${x.id}:${x.cat || '-'}`).join(' '));
  check('默认分类也跟着改了', st.defaultCategory === '拉挤工艺', st.defaultCategory);
  await shot('07-改名后');

  // ---------- 设默认分类（再点一次取消）----------
  console.log('\n=== 设默认分类 ===');
  t = await bodyText();
  check('当前默认显示为「拉挤工艺」', /当前：拉挤工艺/.test(t), (t.match(/当前：[^\n]*/) || [''])[0]);
  // ⚠️ 必须带上「● / ○」前缀再点：只写「拉挤工艺」会命中弹层**背后**列表里的分组头 ——
  //    它同样在 DOM 里、面积还更小，而 elementFromPoint 复核落在弹层遮罩上（也算 hittable），
  //    于是这一下等于点了遮罩 = 把面板关掉，后面几条全跟着挂。
  check('点分类名切换默认（拉挤工艺 → 取消）', (await clickText('● 拉挤工艺')) === 'CLICKED');
  await sleep(900);
  st = await catState();
  check('再点一次取消默认（不自动归类）', !st.defaultCategory, st.defaultCategory || '(空)');
  check('点「高压行业」设为默认', (await clickText('○ 高压行业')) === 'CLICKED');
  await sleep(900);
  st = await catState();
  check('默认分类切到高压行业', st.defaultCategory === '高压行业', st.defaultCategory);
  await shot('08-默认分类');
  await clickText('关闭');
  await sleep(600);

  // ---------- 问答按分类限定 ----------
  console.log('\n=== 问答页按分类限定 ===');
  console.log('  切到助手：', await clickText('助手'));
  await sleep(1500);
  check('展开检索范围面板', (await clickText('全部资料')) === 'CLICKED');
  await sleep(800);
  t = await bodyText();
  check('面板出现「按分类（单选）」', /按分类（单选）/.test(t));
  check('分类项带份数：拉挤工艺 2', /拉挤工艺\s*2/.test(t), (t.match(/拉挤工艺[^\n]*/) || [''])[0]);
  check('0 份的分类标成「（空）」防止误选', /高压行业（空）/.test(t), (t.match(/高压行业[^\n]*/) || [''])[0]);
  await shot('09-检索范围');

  check('点「拉挤工艺 2」', (await clickText('拉挤工艺 2')) === 'CLICKED');
  await sleep(900);
  st = await catState();
  check('retrieval.category 落库为拉挤工艺', st.retrievalCategory === '拉挤工艺', st.retrievalCategory);
  t = await bodyText();
  check('范围条显示「分类：拉挤工艺」', /分类：拉挤工艺/.test(t), (t.match(/🔍[^\n]*/) || [''])[0]);
  check('提示写明钉住的仍会带上', /钉住的资料仍会带上/.test(t));

  check('再点一次取消限定', (await clickText('拉挤工艺 2')) === 'CLICKED');
  await sleep(800);
  st = await catState();
  check('取消后 retrieval.category 清空', !st.retrievalCategory, st.retrievalCategory || '(空)');
  await shot('10-取消限定');

  // ---------- 删分类：不动资料 ----------
  console.log('\n=== 删除分类（不动资料归属）===');
  console.log('  切到资料库：', await clickText('资料库'));
  await sleep(1500);
  check('点「管理分类」', (await clickText('管理分类')) === 'CLICKED');
  await sleep(800);
  check('点「删除」', (await clickText('删除')) === 'CLICKED');
  await sleep(800);
  t = await bodyText();
  check('确认页写明已归入的份数', /2\s*份资料已归入这个分类/.test(t), (t.match(/\d+ 份资料已归入/) || [''])[0]);
  check('确认页写明不会清掉归属', /不会.*清掉它们的归属/.test(t));
  await shot('11-删除确认');

  check('点「删除分类」', (await clickText('删除分类')) === 'CLICKED');
  await sleep(1500);
  st = await catState();
  check('分类表里少了一个', st.categories.length === 1, st.categories.join('/'));
  check('**已归入资料的归属保留**（分组照旧显示）',
    st.docs.find((x) => x.id === 'd1')?.cat === '拉挤工艺',
    st.docs.map((x) => `${x.id}:${x.cat || '-'}`).join(' '));
  await sleep(400);
  t = await bodyText();
  check('列表里「拉挤工艺」这一组还在', /拉挤工艺\s*·\s*2/.test(t), (t.match(/拉挤工艺[^\n]*/) || [''])[0]);
  await shot('12-删除后');

  // ---------- 新导入自动归入默认分类：不在这里验 ----------
  // 那条链（picker → parseAsset → insertDocument）要塞真文件，机制与界面操作不同，
  // 已并入 web-import-check.js（用 SEED_DEFAULT_CATEGORY 预置后跑一次真导入断言）。
  // 这里重复实现一份只会得到「input 找到了但库里没有」这种假红。

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
