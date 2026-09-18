/**
 * 经验库列表页（方案 P1）的浏览器端到端验收（真实 UI + 真实 store）
 *
 * 验的是这条链：
 *   资料库页分段切到经验库 → 概览/筛选/搜索 → 详情 → 停用/启用检索 → 编辑 → 新建 → 删除 → 落库
 *
 * 几个断言是刻意加的，它们对应设计上的硬约束，改坏了必须红：
 *   · 新建/编辑走同一份 formFor：编辑后 localStorage 里 id 与 createdAt 必须【不变】
 *     （createdAt 跟着编辑刷新 = 篡改记录日期，提示词里会出现「根据你 08-12 的记录」这类假引用）
 *   · 停用检索只翻 verified，记录本身必须还在
 *   · 删除必须二次确认
 *
 * 用法：
 *   1) 起 dev server（见项目记忆里的固定命令）
 *   2) 用 --remote-debugging-port=9222 起一个 Chrome
 *   3) node scripts/web-case-list-check.js [url]
 */
const fs = require('fs');

const URL_ = process.argv[2] || 'http://localhost:8081';
const PORT = process.env.CDP_PORT || 9222;
const WAIT_BOOT = Number(process.env.WAIT_BOOT || 25000);
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/cases-shot';
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

  // 与 web-case-check.js / web-batch-check.js 同一套判据（坑的成因写在那两处的注释里）：
  // 剔零面积候选 + 优先精确匹配 + CDP 真实鼠标事件 + 点前 elementFromPoint 复核。
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

  const casesInDb = () => evaluate(`(() => {
    try { return (JSON.parse(localStorage.getItem(${JSON.stringify(NS)}) || '{}').cases) || []; }
    catch { return []; }
  })()`);
  // 写库是异步的（set 之后才落盘），断言前必须轮询而不是 sleep 一个拍脑袋的数字
  const waitDb = async (pred, ms = 3000) => {
    let last = [];
    for (let i = 0; i < ms / 100; i++) {
      last = await casesInDb();
      if (pred(last)) return last;
      await sleep(100);
    }
    return last;
  };

  // 详情弹层开着吗？认它的检索开关提示语 —— 只有详情弹层有这句。
  const sheetOpen = () => evaluate(`(() => {
    return Array.from(document.querySelectorAll('div')).some((e) => {
      const t = e.innerText || '';
      return t.includes('点一下可临时停用') || t.includes('点一下重新启用');
    });
  })()`);

  // 打开某条案例的详情，并确认【打开的确实是它】。
  //
  // 判据用「只在弹层里出现的文字」= 该条的 finalFix：
  //   · 卡片只显示 标题 / 型号 / 日期 / 标签，从不显示 finalFix —— 所以底层列表里的残留
  //     不可能让断言假过（拿标题或日期当判据就会假过，卡上也有）
  //   · 第一轮我就是靠「弹层开着」+「屏幕上能找到某段文字」下的判断，结果 c2 的弹层一直留在
  //     最上层，后面每一次「点编辑 / 点停用」都作用在 c2 上，而断言按 c1 查库 —— 一片假红，
  //     还差点让人去怀疑 app 本身。
  const openCase = async (title, fix) => {
    await clickText(title);
    await sleep(700);
    const open = await sheetOpen();
    const t = await bodyText();
    check(`点开「${title}」后弹层已打开`, open === true);
    check(`弹层里是这一条（认它独有的 finalFix）`, t.includes(fix), t.includes(fix) ? '' : '没找到：' + fix);
    return open === true && t.includes(fix);
  };

  // 关掉当前弹层（点右上角 ✕）
  const closeSheet = async () => { await clickText('✕'); await sleep(500); };

  // 分段 chip 与底部 Tab 都叫「资料库」，按面积最小选会选错 ——
  // 只认「跟另一个分段同父」的那个候选，即分段行里的 chip。
  const clickSegment = async (label) => {
    const box = await evaluate(`(() => {
      const LABELS = ['资料库', '经验库'], T = ${JSON.stringify('__LABEL__')};
      const cand = Array.from(document.querySelectorAll('div')).filter((e) => {
        const r = e.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        if ((e.innerText || '').trim() !== T) return false;
        const pt = e.parentElement ? (e.parentElement.innerText || '') : '';
        return LABELS.some((o) => o !== T && pt.includes(o));
      });
      if (!cand.length) return null;
      cand.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      });
      const el = cand[0];
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`.replace('__LABEL__', label));
    if (!box) return 'NOT_FOUND';
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: Math.round(box.x), y: Math.round(box.y),
        button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
      });
    }
    await sleep(600);
    return 'CLICKED';
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

  // ---------- 预置 3 条案例：2 条参与检索、1 条未参与；三种结果各一条 ----------
  // 每条给【互不相同】的 finalFix：它不进卡片、只进详情弹层，因此可以当作
  // 「现在打开的是哪一条」的指纹（见 openCase 的注释）。
  const mkCase = (id, title, outcome, verified, extra = {}) => ({
    id, title, problem: `${title}（详细现象）`, product: 'Araldite CY1578',
    rootCause: '真空度不足', finalFix: '升温至 60℃ 抽真空 30 min 后静置',
    outcome, verified, tags: ['气泡'], createdAt: `2025-03-0${id.slice(1)}T00:00:00.000Z`,
    ...extra,
  });
  const FIX1 = '升温至 60℃ 抽真空 30 min 后静置';
  const FIX2 = '延长脱泡至 60 min，并改用真空搅拌消泡';
  const FIX3 = '按车间实际温度换算固化剂比例后再配比';
  const seedCases = [
    mkCase('c1', 'CY1578 混合料出现气泡', 'success', true, { finalFix: FIX1 }),
    mkCase('c2', '真空脱泡后仍有少量气孔', 'partial', true, { finalFix: FIX2 }),
    mkCase('c3', '冬季固化剂比例误判', 'fail', false, { product: 'Araldite CY5192', finalFix: FIX3 }),
  ];
  const seed = {
    documents: [], chunks: [], embeddings: [],
    kv: { app_settings: JSON.stringify({ dataStrategy: 'local' }) },
    cases: seedCases,
  };

  console.log(`=== 打开 ${URL_} ===`);
  await send('Page.navigate', { url: URL_ });
  await sleep(WAIT_BOOT);
  if (!(await bodyText())) throw new Error('页面没有渲染出内容（调大 WAIT_BOOT）');
  await evaluate(`(() => {
    localStorage.clear();
    localStorage.setItem(${JSON.stringify(NS)}, ${JSON.stringify(JSON.stringify(seed))});
    return 'SEEDED';
  })()`);
  await send('Page.reload');
  await sleep(WAIT_BOOT);
  // 从这一刻起才算「本轮的错误」。页面在改代码时一直开着，HMR 会把编辑途中的半成品状态
  // （比如 `<>` 还没配对的 LibraryScreen、还没加 import 的 ConfirmCloudModal）以 exception
  // 形式塞进 console 历史 —— 不清零就会得到一条与本次完全无关的假红。
  logs.length = 0;

  // ---------- 进入资料库 → 分段切到经验库 ----------
  console.log('\n=== 分段切换 ===');
  // 切 Tab 必须用【真实鼠标事件】：RN Web 的 Pressable 走自己的 responder 体系，
  // 不响应合成的 `new MouseEvent('click')` —— 派发了页面纹丝不动，症状是「所有断言全挂」。
  console.log('  切到资料库：', await clickText('资料库'));
  await sleep(1500);
  let t = await bodyText();
  check('资料库页出现「经验库」分段', /经验库/.test(t));
  check('默认停在资料库（标题是资料库）', /资料库/.test(t) && !/共 3 条/.test(t));
  await shot('01-分段');

  console.log('  切到经验库：', await clickSegment('经验库'));
  await sleep(800);
  t = await bodyText();
  check('经验库概览条：共 3 条 · 参与检索 2 · 未参与 1', /共\s*3\s*条\s*·\s*参与检索\s*2\s*·\s*未参与\s*1/.test(t), t.split('\n').find((l) => /参与检索/.test(l)) || '');
  check('列出三条案例', /CY1578 混合料出现气泡/.test(t) && /真空脱泡后仍有少量气孔/.test(t) && /冬季固化剂比例误判/.test(t));
  check('未参与检索的案例带灰徽章', /未参与检索/.test(t));
  await shot('02-列表');

  // ---------- 筛选 chips ----------
  console.log('\n=== 筛选 ===');
  check('chips 计数正确（全部 3 / 成功 1 / 部分成功 1 / 失败 1 / 未参与检索 1）',
    /全部\s*3/.test(t) && /成功\s*1/.test(t) && /部分成功\s*1/.test(t) && /失败\s*1/.test(t) && /未参与检索\s*1/.test(t));

  console.log('  点「失败 1」：', await clickText('失败 1'));
  t = await bodyText();
  check('按结果筛选：只剩失败那条', /冬季固化剂比例误判/.test(t) && !/CY1578 混合料出现气泡/.test(t));
  await shot('03-筛选失败');

  console.log('  点「未参与检索 1」：', await clickText('未参与检索 1'));
  t = await bodyText();
  check('按「能不能用」筛选：只剩未参与的', /冬季固化剂比例误判/.test(t) && !/真空脱泡后仍有少量气孔/.test(t));

  console.log('  点「全部 3」：', await clickText('全部 3'));
  t = await bodyText();
  check('回到全部：三条都在', /CY1578 混合料出现气泡/.test(t) && /真空脱泡后仍有少量气孔/.test(t) && /冬季固化剂比例误判/.test(t));

  // ---------- 搜索 ----------
  console.log('\n=== 搜索 ===');
  console.log('  搜「脱泡」：', await typeInto('搜案例', '脱泡'));
  await sleep(700);
  t = await bodyText();
  check('搜「脱泡」只命中标题含脱泡的那条', /真空脱泡后仍有少量气孔/.test(t) && !/CY1578 混合料出现气泡/.test(t));
  // ⚠️ 这里只能清输入框，不能去点「脱泡」两个字 —— 那个「包含即命中」的定位会点到
  //    唯一可见的那张卡片、把它的详情弹层打开，之后所有动作就都作用在它身上了。
  console.log('  清空搜索：', await typeInto('搜案例', ''));
  await sleep(700);
  t = await bodyText();
  check('清空搜索后三条都回来', /CY1578 混合料出现气泡/.test(t) && /冬季固化剂比例误判/.test(t));
  await shot('04-搜索');

  // ---------- 详情 + 检索开关 ----------
  console.log('\n=== 详情与检索开关 ===');
  const C1 = 'CY1578 混合料出现气泡';
  await openCase(C1, FIX1);
  t = await bodyText();
  check('详情显示根因与最终解决', /根因/.test(t) && /真空度不足/.test(t) && /最终解决/.test(t) && t.includes(FIX1));
  check('详情里显示当前是「参与问答检索」', /参与问答检索/.test(t) && /停用/.test(t));
  await shot('05-详情');

  console.log('  点「停用」：', await clickText('停用'));
  await sleep(500);
  t = await bodyText();
  let db = await waitDb((cs) => cs.find((c) => c.id === 'c1')?.verified === false);
  check('停用后记录仍在（只翻 verified）', db.length === 3);
  check('停用后 c1 的 verified=false 落库', db.find((c) => c.id === 'c1')?.verified === false,
    `c1.verified=${db.find((c) => c.id === 'c1')?.verified}`);
  check('概览的参与检索数跟着变成 1', /参与检索\s*1/.test(t), t.split('\n').find((l) => /参与检索/.test(l)) || '');
  check('详情里文案变成「未参与问答检索」', /未参与问答检索/.test(t) && /启用/.test(t));
  await shot('06-停用检索');

  console.log('  点「启用」：', await clickText('启用'));
  db = await waitDb((cs) => cs.find((c) => c.id === 'c1')?.verified === true);
  check('启用后 c1 的 verified=true 回到库里', db.find((c) => c.id === 'c1')?.verified === true);
  await closeSheet();
  check('关掉弹层后详情确实收了', (await sheetOpen()) === false);

  // ---------- 编辑：id / createdAt 必须不变 ----------
  console.log('\n=== 编辑 ===');
  await openCase(C1, FIX1);
  const c1Before = (await casesInDb()).find((c) => c.id === 'c1');
  console.log('  点「编辑」：', await clickText('编辑'));
  await sleep(900);
  t = await bodyText();
  check('编辑表单标题是「编辑案例」', /编辑案例/.test(t));
  check('编辑表单预填了原标题', t.includes(C1));
  await shot('07-编辑');

  const NEW_TITLE = 'CY1578 混合料气泡（已复核）';
  await typeInto('一句话，例如：CY1578 混合料出现气泡', NEW_TITLE);
  await sleep(300);
  console.log('  保存修改：', await clickText('保存修改'));
  await sleep(800);
  t = await bodyText();
  db = await waitDb((cs) => cs.some((c) => c.title === NEW_TITLE));
  check(`列表出现新标题`, t.includes(NEW_TITLE));
  check('新标题落在 c1 上（不是别的某条）', db.find((c) => c.id === 'c1')?.title === NEW_TITLE,
    db.map((c) => `${c.id}:${c.title}`).join(' | '));
  const c1After = db.find((c) => c.id === 'c1');
  check('编辑不换 id', !!c1After && c1After.id === c1Before.id);
  check('编辑不刷新 createdAt（否则等于篡改记录日期）', c1After?.createdAt === c1Before.createdAt,
    `${c1Before.createdAt} → ${c1After?.createdAt}`);
  check('编辑后仍是 3 条（不是新增了一条）', db.length === 3);
  check('其它两条没被动过', db.find((c) => c.id === 'c2')?.title === '真空脱泡后仍有少量气孔');
  await shot('08-编辑后');

  // ---------- 新建 ----------
  console.log('\n=== 新建 ===');
  console.log('  点「＋ 新建」：', await clickText('＋ 新建'));
  await sleep(900);
  t = await bodyText();
  check('新建表单标题是「记录这次怎么解决的」', /记录这次怎么解决的/.test(t));
  const NEW2 = '冬季车间 15℃ 环境下固化不完全';
  await typeInto('一句话，例如：CY1578 混合料出现气泡', NEW2);
  await typeInto('例如：升温至 60℃', '把料和固化剂提前 24h 移入 25℃ 恒温室再配比');
  await sleep(300);
  console.log('  保存到经验库：', await clickText('保存到经验库'));
  await sleep(800);
  const after4 = await waitDb((cs) => cs.length === 4);
  t = await bodyText();
  check('新建后共 4 条', after4.length === 4 && /共\s*4\s*条/.test(t));
  check('新建的案例标题落库', after4.some((c) => c.title === NEW2));
  check('新建的案例默认参与检索', after4.find((c) => c.title === NEW2)?.verified === true);
  check('概览参与检索数变成 3', /参与检索\s*3/.test(t), t.split('\n').find((l) => /参与检索/.test(l)) || '');
  const newId = after4.find((c) => c.title === NEW2)?.id;
  await shot('09-新建后');

  // ---------- 删除：必须二次确认 ----------
  console.log('\n=== 删除 ===');
  const FIX_NEW = '把料和固化剂提前 24h 移入 25℃ 恒温室再配比';
  await openCase(NEW2, FIX_NEW);
  console.log('  点「删除」：', await clickText('删除'));
  await sleep(700);
  t = await bodyText();
  check('删除前有二次确认，且说清不可撤销', /删除这条案例？/.test(t) && /无法撤销/.test(t));
  await shot('10-删除确认');

  console.log('  点「取消」：', await clickText('取消'));
  await sleep(600);
  check('取消后案例还在（4 条）', (await casesInDb()).length === 4);

  await openCase(NEW2, FIX_NEW);
  console.log('  再点「删除」：', await clickText('删除'));
  await sleep(700);
  console.log('  点「确认删除」：', await clickText('确认删除'));
  await sleep(800);
  const after5 = await waitDb((cs) => cs.length === 3);
  t = await bodyText();
  check('确认后从库里删掉（且删的是那一条）', after5.length === 3 && !after5.some((c) => c.id === newId),
    after5.map((c) => `${c.id}:${c.title}`).join(' | '));
  check('列表回到 3 条', /共\s*3\s*条/.test(t));
  check('删除有回执提示', /已从经验库删除/.test(t));
  await shot('11-删除后');

  // ---------- 切回资料库（分段 vs 底部 Tab 同名，必须点分段那个）----------
  console.log('\n=== 切回资料库 ===');
  console.log('  点「资料库」分段：', await clickSegment('资料库'));
  await sleep(800);
  t = await bodyText();
  check('切回资料库后经验库列表已卸载', !/参与检索/.test(t) && !/共\s*3\s*条/.test(t),
    t.split('\n').slice(0, 6).join(' / '));
  check('资料库自己的内容在（搜索框回来了）',
    await evaluate(`!!document.querySelector('input[placeholder*="搜索资料"]')`));
  await shot('12-切回资料库');

  console.log('\n=== 再切回经验库（状态还在）===');
  console.log('  ', await clickSegment('经验库'));
  await sleep(800);
  check('经验库仍在且数据没丢', /共\s*3\s*条/.test(await bodyText()));

  console.log('\n=== 运行期错误 ===');
  if (logs.length) logs.slice(0, 10).forEach((l) => console.log('  ' + l));
  check('本轮无未捕获异常 / console.error', logs.length === 0, logs.slice(0, 2).join(' | '));

  const pass = results.filter(([, ok]) => ok).length;
  console.log(`\n${'═'.repeat(46)}\n通过 ${pass}/${results.length}`);
  console.log(`截图目录：${SHOT_DIR}`);
  if (pass !== results.length) {
    console.log('失败项：');
    results.filter(([, ok]) => !ok).forEach(([l]) => console.log('  · ' + l));
    process.exitCode = 1;
  }
  ws.close();
}

main().catch((e) => { console.error('检查脚本自身出错：', e); process.exit(1); });
