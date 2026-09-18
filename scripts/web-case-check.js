/**
 * 经验库闭环的浏览器端到端验收（真实 UI + 真实检索，模型用离线桩）
 *
 * 验的是这条环：
 *   提问 → 回答里没有案例 → 点「记录怎么解决的」→ 填表保存
 *   → 再问同样的问题 → 这次回答里出现「案例」来源、步骤条出现「经验库命中」
 *
 * 最后两步才是关键：它同时证明了三件事
 *   1) 记录真的落库（localStorage.cases）
 *   2) 记录后检索索引真的重建了（不然「刚记完又问一遍，案例还是没生效」）
 *   3) 案例真的以更高优先级进了上下文（直接翻桩模型收到的 prompt 核对）
 *
 * 用法：
 *   1) 起 dev server（见项目记忆里的固定命令）
 *   2) 用 --remote-debugging-port=9222 起一个 Chrome
 *   3) node scripts/web-case-check.js [url]
 */
const fs = require('fs');
const { createServer } = require('node:http');
const { SCAN_EXPR, describe } = require('./lib/text-clip-scan');

const URL_ = process.argv[2] || 'http://localhost:8081';
const PORT = process.env.CDP_PORT || 9222;
const WAIT_BOOT = Number(process.env.WAIT_BOOT || 25000);
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/case-shot';
const NS = 'techdocs.v1.db';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 离线桩模型（与 web-import-check.js 同一手法）----------
function startStubLLM() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        try { fs.writeFileSync('/tmp/last-llm-prompt.json', JSON.stringify(JSON.parse(b), null, 2)); }
        catch { fs.writeFileSync('/tmp/last-llm-prompt.json', b); }
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '（离线桩模型）已收到检索上下文。' } }] }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

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
  const stub = await startStubLLM();
  const llmBase = `http://127.0.0.1:${stub.address().port}`;
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

  // 找【可点目标】并返回它的中心坐标。三个坑，都踩过：
  //   ① 祖先容器的 innerText 也含子节点文字 → `includes` 会命中整屏容器，
  //      事件派发给容器 → 真正带 onPress 的按钮收不到（症状：点了没反应）→ 故按【面积最小】取最内层。
  //   ② ⚠️ 但最小的往往是【面积 0 的零高容器】—— 对话滚动区就是 0 高、innerText 却含全部子节点文字。
  //      它排第一 → 点击坐标落到视口外 → elementFromPoint 返回 null → 点了等于没点。
  //      （这就是「保存到经验库」点不动的根因，真实按钮一直是那个 87x20 的 div。）
  //      → 必须先把 width/height 为 0 的候选剔除。
  //   ③ 弹层（RN Web Modal 走 portal）里的合成事件路径不可靠 → 用 CDP 真实鼠标事件，
  //      由浏览器自己做命中测试，等价于用户手点。
  const HIT_EXPR = (text, sel) => `(() => {
    const T = ${JSON.stringify(text)};
    const vis = Array.from(document.querySelectorAll(${JSON.stringify(sel)})).filter((e) => {
      const r = e.getBoundingClientRect();
      return (e.innerText || '').includes(T) && r.width > 0 && r.height > 0;
    });
    if (!vis.length) return null;
    const exact = vis.filter((e) => (e.innerText || '').trim() === T);
    const pool = exact.length ? exact : vis; // 文案完整等于目标的那层最可信，没有才退回「包含」
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
    // 再问一次浏览器：这个坐标底下真的有东西吗？没有就说明算错了（曾经静默点空过一整轮）。
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
    return 'CLICKED';
  };

  const typeInto = (placeholder, value) =>
    evaluate(`(() => {
      const q = ${JSON.stringify(`input[placeholder*="${placeholder}"], textarea[placeholder*="${placeholder}"]`)};
      const el = document.querySelector(q);
      if (!el) return 'NOT_FOUND';
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'TYPED';
    })()`);

  // ⚠️ 不能拿 /来源\s*·\s*\d+/ 当「等到回答」的条件：上一轮的答案还在页面上，
  //    第一次轮询就能匹配到它 → 拿到的是【本条回答尚未渲染】的快照。
  //    抢跑的后果不是全绿，而是【半新半旧】：步骤条（检索一完成就更新）已是新的，
  //    回答气泡（要等模型返回才 append）还是旧的 → 断言一半过一半不过，看着像功能坏了。
  //    所以按「来源 · 」出现第 n 次来判断。
  const waitForAnswers = async (n, ms) => {
    const t0 = Date.now();
    let t = await bodyText();
    while (Date.now() - t0 < ms) {
      t = await bodyText();
      if ((t.match(/来源\s*·\s*\d+/g) || []).length >= n) return t;
      await sleep(1000);
    }
    console.log(`（等第 ${n} 条回答超时 ${ms}ms）`);
    return t;
  };

  const waitFor = async (re, ms, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const t = await bodyText();
      if (re.test(t)) return t;
      await sleep(1000);
    }
    console.log(`（等「${label}」超时 ${ms}ms）`);
    return await bodyText();
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

  // ---------- 预置数据：一份文档 + 两块正文，案例先留空 ----------
  console.log(`=== 打开 ${URL_} ===`);
  await send('Page.navigate', { url: URL_ });
  await sleep(WAIT_BOOT);
  if (!(await bodyText())) throw new Error('页面没有渲染出内容（调大 WAIT_BOOT）');

  const seed = {
    documents: [{
      id: 'd1', name: 'HY1578 TDS.pdf', type: 'pdf', folderId: null, tags: ['CY1578'],
      pinned: false, status: 'indexed', meta: { pages: 1, chars: 120 }, createdAt: '2025-01-01T00:00:00.000Z',
    }],
    chunks: [
      { id: 'k1', docId: 'd1', seq: 0, pageNo: 1, ctype: 'para', content: '真空脱泡：建议 40 min，温度 60℃，静置后浇注可减少气泡。' },
      { id: 'k2', docId: 'd1', seq: 1, pageNo: 1, ctype: 'para', content: '储存条件：密封避光，保质期自生产日期起 24 个月。' },
    ],
    kv: {
      app_settings: JSON.stringify({
        modelConfig: { source: 'api', provider: 'custom', baseURL: llmBase, model: 'stub-model' },
      }),
    },
    embeddings: [],
    cases: [],
  };
  await evaluate(`(() => {
    localStorage.clear();
    localStorage.setItem(${JSON.stringify(NS)}, ${JSON.stringify(JSON.stringify(seed))});
    return 'SEEDED';
  })()`);
  await send('Page.navigate', { url: URL_ });
  await sleep(8000);
  await shot('01-初始');

  const askQuestion = async (q, n) => {
    await clickText('问答');
    await sleep(1200);
    await typeInto('输入问题', q);
    await sleep(400);
    await clickText('发送');
    return await waitForAnswers(n, 60000);
  };

  const Q = '真空脱泡 需要多久';
  console.log(`\n=== 第 1 次提问「${Q}」（此时经验库为空）===`);
  let t = await askQuestion(Q, 1);
  check('问答走到来源列表', /来源\s*·\s*\d+/.test(t));
  check('经验库为空时不显示案例命中', !/经验库命中/.test(t));
  check('来源里没有经验案例', !/含经验案例/.test(t));
  await shot('02-问1-无案例');

  // ---------- 记录一条案例 ----------
  console.log('\n=== 点「记录怎么解决的」并保存 ===');
  const clicked = await clickText('记录怎么解决的');
  check('回答下有记录入口', clicked === 'CLICKED', clicked);
  await sleep(1200);
  let form = await bodyText();
  check('记录表单已打开', /记录这次怎么解决的/.test(form) && /保存到经验库/.test(form));
  check('表单第一栏是结果三选', ['成功', '部分成功', '失败'].every((x) => form.includes(x)));
  await shot('03-记录弹层');

  // 诊断开关：弹层里的元素为什么找不到（body.innerText 有文字，但按 innerText 匹配不到元素）
  if (process.env.DEBUG_MODAL) {
    const info = await evaluate(`(() => {
      const T = '保存到经验库';
      const all = Array.from(document.querySelectorAll('*'));
      const byText = all.filter(e => (e.textContent || '').includes(T));
      const byInner = all.filter(e => (e.innerText || '').includes(T));
      const desc = (e) => {
        const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
        return e.tagName + '[role=' + (e.getAttribute('role') || '-') + '] disp=' + cs.display +
          ' vis=' + cs.visibility + ' op=' + cs.opacity + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) +
          ' textLen=' + (e.textContent || '').length + ' innerLen=' + (e.innerText || '').length;
      };
      const last = byText[byText.length - 1];
      const chain = [];
      let p = last;
      for (let i = 0; i < 7 && p; i++) { chain.push(desc(p)); p = p.parentElement; }
      return {
        totalEls: all.length, byText: byText.length, byInner: byInner.length,
        innermost: last ? desc(last) : null, chain,
        bodyInnerHas: document.body.innerText.includes(T),
      };
    })()`);
    console.log('DEBUG_MODAL\n' + JSON.stringify(info, null, 1));
  }

  const FIX = '升温 60℃ 抽真空 30 min，静置 5 min 后浇注，气泡消除';
  await clickText('部分成功');
  await sleep(200);
  const typed = await typeInto('例如：升温至', FIX);
  check('最终解决可填写', typed === 'TYPED', typed);
  await typeInto('一句话，例如', 'CY1578 混合料浇注后出现气泡');
  await sleep(300);
  await clickText('补充项');
  await sleep(600);
  await typeInto('空格或逗号分隔', '气泡 工艺 CY1578');
  await shot('04-填好表单');
  await clickText('保存到经验库');
  const after = await waitFor(/已存入经验库/, 8000, '保存成功提示');
  if (!/已存入经验库/.test(after)) {
    // 失败诊断：把弹层当时的可见文字打出来 —— 「校验没过」和「点击没生效」一眼能分
    console.log('--- 保存后页面可见文字（末尾 700 字）---');
    console.log(after.slice(-700));
    console.log('保存按钮定位：', JSON.stringify(await findBox('保存到经验库')));
  }
  check('保存后有成功提示', /已存入经验库/.test(after));

  // 落库是异步的（store 里 await saveCase 之后才 set）→ 轮询等，不要读一次就下结论
  let stored = null;
  for (let i = 0; i < 10 && !stored; i++) {
    stored = await evaluate(`(() => {
      const db = JSON.parse(localStorage.getItem(${JSON.stringify(NS)}) || '{}');
      const c = (db.cases || [])[0];
      return c ? { n: db.cases.length, outcome: c.outcome, verified: c.verified, fix: c.finalFix, tags: c.tags, docs: c.docIds } : null;
    })()`);
    if (!stored) await sleep(700);
  }
  check('案例已落库', !!stored, JSON.stringify(stored));
  check('结果与最终解决被保存', !!stored && stored.outcome === 'partial' && /抽真空 30 min/.test(stored.fix || ''));
  check('案例标记为已验证（才进召回池）', !!stored && stored.verified === true);
  check('标签与关联文档一起存下', !!stored && (stored.tags || []).includes('气泡') && (stored.docs || []).includes('d1'));

  // ---------- 再问一次：案例应当被检索到 ----------
  console.log(`\n=== 第 2 次提问同一问题（经验库里已有 1 条）===`);
  t = await askQuestion(Q, 2);
  check('步骤条出现「经验库命中」', /经验库命中\s*[1-9]/.test(t));
  check('来源区标出「含经验案例」', /含经验案例\s*[1-9]/.test(t));
  // 只看【最后一条回答】的来源区：indexOf 会拿到第一条（那会儿还没有案例）。
  // 徽章判据用 `\n案例\n`（独立成行）—— 光找「案例」两字不行，案例正文的片段里
  // 自带「【已验证案例 · 部分成功】」，徽章根本没渲染也会通过（弱断言 = 假绿）。
  const iSrc = t.lastIndexOf('来源 · ');
  check('来源区出现「案例」徽章', iSrc >= 0 && /\n案例\s*\n/.test(t.slice(iSrc)), `iSrc@${iSrc}`);
  await shot('05-问2-命中案例');

  // 直接翻桩模型收到的 prompt —— 这是最硬的证据：案例真的进了上下文，且排在资料前面
  //
  // ⚠️ 断言必须【只切上下文那一段】再看：系统提示词模板里本身就写着
  //    「【你已验证的经验案例】= 用户本人实操并记录过的做法…」这句说明，
  //    全文搜索会命中模板文字 → 案例根本没进来也会「通过」（第一版就踩了这个假绿）。
  const prompt = fs.existsSync('/tmp/last-llm-prompt.json')
    ? JSON.parse(fs.readFileSync('/tmp/last-llm-prompt.json', 'utf8'))
    : null;
  const sys = (prompt?.messages || []).find((m) => m.role === 'system')?.content || '';
  const ctx = sys.slice(sys.indexOf('【可引用资料】'));
  check('提示词里要求「以案例为准」', /以案例为准/.test(sys));
  check('上下文含案例条目（带 [来源N] 标记，不是模板说明）', /\[来源\d+\] 【你已验证的经验案例（部分成功）】/.test(ctx));
  const iCase = ctx.indexOf('【你已验证的经验案例（部分成功）】');
  const iDoc = ctx.indexOf('《HY1578 TDS.pdf》');
  check('案例排在原始资料之前', iCase >= 0 && iDoc >= 0 && iCase < iDoc, `case@${iCase} doc@${iDoc}`);
  check('案例正文带最终解决与结果', /最终解决：/.test(ctx) && /结果：部分成功/.test(ctx));
  check('案例正文带标签', /标签：/.test(ctx) && /气泡/.test(ctx));

  // ---------- 失败记录的分档（回归：失败记录曾被当成「已验证经验」推荐出去）----------
  //
  // 这一段必须【在真实页面上跑】，只靠离线测试不够：提示词里的失败规则写在 store.ts 的
  // sys 模板里，而 test-cases.mjs 只覆盖 cases.ts / rag.ts，够不到它。
  // 而那段规则是整件事的落点 —— 上下文里标得再准，提示词没说清「失败记录该怎么用」，
  // 模型照样会把它当成可照做的方案（这正是修之前的行为）。
  console.log('\n=== 把那条案例改成「失败」，再问一次 ===');
  const PROMPT_FILE = '/tmp/last-llm-prompt.json';
  const flipped = await evaluate(`(() => {
    const db = JSON.parse(localStorage.getItem(${JSON.stringify(NS)}) || '{}');
    const c = (db.cases || [])[0];
    if (!c) return 'NO_CASE';
    c.outcome = 'fail';
    localStorage.setItem(${JSON.stringify(NS)}, JSON.stringify(db));
    return c.id;
  })()`);
  check('已把案例结果改成失败', flipped !== 'NO_CASE', String(flipped));
  await send('Page.reload');
  await sleep(WAIT_BOOT);

  // 抓这一次的 prompt：删掉落盘文件 → 发问 → 等它重新出现。
  // 不用数「来源 · N」等回答数 —— reload 后会话历史是否恢复不该影响这段的成败。
  const askAndGrab = async () => {
    try { fs.unlinkSync(PROMPT_FILE); } catch { /* 本来就不存在 */ }
    await clickText('问答');
    await sleep(1500);
    await typeInto('输入问题', Q);
    await sleep(400);
    await clickText('发送');
    for (let i = 0; i < 60; i++) {
      if (fs.existsSync(PROMPT_FILE)) break;
      await sleep(1000);
    }
    if (!fs.existsSync(PROMPT_FILE)) return null;
    await sleep(300);
    return JSON.parse(fs.readFileSync(PROMPT_FILE, 'utf8'));
  };
  const p2 = await askAndGrab();
  check('桩模型收到了这次的请求', !!p2, p2 ? 'ok' : 'prompt 落盘文件没出现');
  const sys2 = (p2?.messages || []).find((m) => m.role === 'system')?.content || '';
  const ctx2 = sys2.slice(sys2.indexOf('【可引用资料】'));

  // 先断言前提，再断言行为 —— 否则「失败案例没进来」会让下面几条全都“通过”（空转假绿）
  check('失败案例确实进了上下文', /\[来源\d+\] 【你的失败记录（试过，没成）】/.test(ctx2));
  check('上下文头部写明「此路不通，不要照做」', /【已验证案例 · 失败 · 此路不通，不要照做】/.test(ctx2));
  check('失败案例的字段名换成了「试过的做法（未成功）」', !/最终解决：/.test(ctx2) && /试过的做法（未成功）：/.test(ctx2));

  // 提示词侧：四条规则缺任何一条，都等于前面的分档白做
  check('提示词写明失败记录不能当方案推荐', /绝不能当作解决方案推荐/.test(sys2));
  check('提示词写明失败只代表「当时那个条件下」不成立', /当时那个条件下/.test(sys2));
  check('提示词要求在条件不同时指出差异、可以再试', /可以再试/.test(sys2));
  check('提示词要求在条件相同时明确劝阻', /明确劝阻/.test(sys2));
  check('提示词给「以案例为准」补了失败记录那一层含义', /不是"照它做"/.test(sys2));

  // 界面侧：来源卡必须给这条换徽章。用户扫一眼来源区就该看出「这条是没成的」，
  // 而不是从一个笼统的「案例」徽章推断「AI 在推荐我这么做」。
  const t3 = await waitFor(/\n失败案例\s*\n/, 20000, '来源卡的「失败案例」徽章');
  check('来源卡把失败记录标成「失败案例」', /\n失败案例\s*\n/.test(t3));
  await shot('06-问3-失败记录');

  // ---------- 界面自检（溢出 / 文字裁切）----------
  // 注意：SCAN_EXPR 返回的是【数组】，不是对象。把数组当对象取属性会得到空数组 → 检查永远通过（假绿）。
  const clipBad = (await evaluate(SCAN_EXPR)) || [];
  check('无文字被裁切', clipBad.length === 0, clipBad.slice(0, 3).map(describe).join(' | '));

  const overBad = (await evaluate(`(() => {
    const lim = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.right > lim + 1 || r.width > lim + 1) {
        out.push(el.tagName + '「' + (el.textContent || '').trim().slice(0, 12) + '」w=' + Math.round(r.width) + ' right=' + Math.round(r.right));
      }
    }
    return out.slice(0, 8);
  })()`)) || [];
  check('无横向溢出', overBad.length === 0, overBad.join(' | '));
  check('运行期无 JS 报错', logs.length === 0, logs.slice(0, 3).join(' | '));

  // ---------- 汇总 ----------
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n经验库端到端：${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('失败项：\n' + failed.map(([l]) => '  ✗ ' + l).join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`全部通过 ✅　截图在 ${SHOT_DIR}`);
  }
  ws.close();
  stub.close();
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error('运行失败：', e.message);
  process.exit(1);
});
