#!/usr/bin/env node
/**
 * web 端「真文件导入」实测（走 Chrome DevTools Protocol，零依赖）
 *
 * 为什么需要它：parser.ts / parser.web.ts 这条链路只有在浏览器里塞进一个真 PDF
 * 才能验证——类型检查过了、bundle 编译过了，都不代表 expo-document-picker 给的
 * 资产能被 parseAsset 读出字节。本脚本点击「＋ 导入文档」，再用 CDP 把本地文件
 * 塞进 picker 创建的 input[type=file]，最后断言资料库里出现了「本地解析 N字」
 * 并且能搜到正文关键字。
 *
 * 前置：一个带调试端口的 Chrome（见 web-shot.js 头部说明）
 * 用法：node scripts/web-import-check.js <文件路径> [关键字] [url]
 *   例：node scripts/web-import-check.js /tmp/sample-tds.pdf 粘度
 */
const fs = require('fs');
const path = require('path');
const { createServer } = require('node:http');
const { SCAN_EXPR, describe } = require('./lib/text-clip-scan');

const FILE = process.argv[2];
const KEYWORD = process.argv[3] || '';
const URL_ = process.argv[4] || 'http://localhost:8081';
const PORT = process.env.CDP_PORT || 9222;
const WAIT_BOOT = Number(process.env.WAIT_BOOT || 25000); // 首次 web bundle 构建很慢
const WAIT_PARSE = Number(process.env.WAIT_PARSE || 15000);
const EMBED = process.env.SEED_EMBED_ENDPOINT || ''; // 嵌入服务地址，填了就顺手验语义路
const ASK = process.env.ASK || ''; // 语义路要验的问题，如「有效期是多久」

if (!FILE) {
  console.error('用法：node scripts/web-import-check.js <文件路径> [关键字] [url]');
  process.exit(1);
}
const absFile = path.resolve(FILE);
if (!fs.existsSync(absFile)) {
  console.error(`文件不存在：${absFile}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 离线桩模型：只是为了走通「问答」那条路。
 *
 * 为什么非要它：store 里 retrieve() 之后才调模型，模型一失败就走 catch 分支，
 * 那条分支的 quotes 是空的 —— 也就是「没配模型就看不到引用来源」。
 * 要在浏览器里看见语义检索捞出来的那一段，就必须有个能应答的模型。
 * 桩只回一句固定话，并把收到的完整请求留到 /tmp/last-llm-prompt.json 便于核对上下文。
 */
function startStubLLM() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(b);
          fs.writeFileSync('/tmp/last-llm-prompt.json', JSON.stringify(parsed, null, 2));
        } catch {
          fs.writeFileSync('/tmp/last-llm-prompt.json', b);
        }
        // 同一根桩要同时伺候「问答」和「对比」两条路：
        // 判断依据是 system 提示词 —— 合规检查那条路的 system 里写着「只输出合规检查结果 JSON」。
        const isCompliance = (parsed?.messages || []).some((m) => /合规检查结果 JSON/.test(m.content || ''));
        const content = isCompliance
          ? JSON.stringify({
              model: 'CY1578 / HY1578 拉挤体系',
              items: [
                { item: '弯曲强度', required: '≥ 110 MPa', actual: '118 MPa', verdict: 'ok', source: 'sample-tds.pdf p.1' },
                { item: '拉伸强度', required: '≥ 75 MPa', actual: '72 MPa', verdict: 'warn', source: 'sample-tds.pdf p.1' },
                { item: '热变形温度', required: '≥ 130 °C', actual: '资料未提供', verdict: 'warn' },
                { item: '适用期 25°C', required: '≥ 90 min', actual: '120 min', verdict: 'ok', source: 'sample-tds.pdf p.1' },
                { item: '混合比 A : B', required: '100 : 80', actual: '100 : 80', verdict: 'ok', source: 'sample-tds.pdf p.1' },
              ],
              conclusion: '弯曲强度、适用期、混合比满足要求；拉伸强度差 3 MPa，热变形温度资料未提供。',
            })
          : '（离线桩模型）已收到检索上下文，这里本应是真实回答。';
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
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
    } catch {
      // Chrome 还没起来
    }
    await sleep(500);
  }
  throw new Error(`找不到可调试页面，请确认 Chrome 已用 --remote-debugging-port=${PORT} 启动`);
}

async function main() {
  const stubLLM = ASK ? await startStubLLM() : null;
  const llmBase = stubLLM ? `http://127.0.0.1:${stubLLM.address().port}` : '';
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
  await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 430, height: 932, deviceScaleFactor: 2, mobile: true,
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS 执行出错');
    return r?.result?.value;
  };

  const bodyText = () => evaluate('document.body ? document.body.innerText : ""');

  // RN web 的 Pressable 监听 pointer 事件，只发 click 不一定触发
  // 点击文字。
  // ⚠️ 匹配顺序是「精确相等 → 包含」，不能只写 includes：
  //    模式条上有个「贴要求核对」，而发送按钮就叫「核对」—— 用包含匹配会点到模式条上，
  //    脚本还报 CLICKED，接下来等一个永远不会出现的核对结果，排查半天。
  //    另外先 scrollIntoView：元素在视口之外时 getBoundingClientRect 给的坐标不在屏幕上，
  //    派发出去的事件就落空了（而返回值照样是 CLICKED）。
  const clickText = (text, sel = '[role="button"], [role="tab"], button, a, [tabindex]') =>
    evaluate(`(() => {
      const cands = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
      const T = ${JSON.stringify(text)};
      const vis = cands.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const el = vis.find(e => (e.innerText || '').trim() === T) || vis.find(e => (e.innerText || '').includes(T));
      if (!el) return 'NOT_FOUND';
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width/2, clientY: r.top + r.height/2 };
      ['pointerdown','pointerup','click'].forEach(t => el.dispatchEvent(new MouseEvent(t, opts)));
      return 'CLICKED';
    })()`);

  const typeInto = (placeholder, value) =>
    evaluate(`(() => {
      const q = ${JSON.stringify(`input[placeholder*="${placeholder}"], textarea[placeholder*="${placeholder}"]`)};
      const el = document.querySelector(q);
      if (!el) return 'NOT_FOUND';
      // RN web 的多行 TextInput 渲染成 <textarea>，两者的 value setter 不同源
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'TYPED';
    })()`);

  // 等界面出现某个文本（轮询 body.innerText）
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

  console.log(`=== 打开 ${URL_} ===`);
  await send('Page.navigate', { url: URL_ });
  await sleep(WAIT_BOOT);
  const boot = await bodyText();
  if (!boot) throw new Error('页面没有渲染出内容（bundle 可能还没建好，调大 WAIT_BOOT 再试）');
  console.log(boot.slice(0, 200));

  // 干净起点：先清掉之前测试残留的资料，避免旧数据干扰断言
  await evaluate('try{localStorage.clear()}catch(e){}');
  await send('Page.navigate', { url: URL_ });
  await sleep(6000);

  // 预置「解析服务地址」以验证方案 C 的 NAS 分支。
  // web 端设置存在 localStorage[NS].kv.app_settings，直接写进去等价于在「我的」页填好并保存。
  // 一次性把要预置的设置写进 localStorage（等价于在「我的」页填好并保存）
  const patch = {};
  if (process.env.SEED_PARSE_ENDPOINT) patch.parseService = { endpoint: process.env.SEED_PARSE_ENDPOINT };
  if (EMBED) patch.embedding = { endpoint: EMBED };
  if (ASK) patch.modelConfig = { source: 'api', provider: 'custom', baseURL: llmBase, model: 'stub-model' };
  if (Object.keys(patch).length) {
    await evaluate(`(() => {
      const NS = 'techdocs.v1.db';
      const db = JSON.parse(localStorage.getItem(NS) || '{"kv":{}}');
      const s = JSON.parse(db.kv.app_settings || '{}');
      Object.assign(s, ${JSON.stringify(patch)});
      db.kv.app_settings = JSON.stringify(s);
      localStorage.setItem(NS, JSON.stringify(db));
      return 'SEEDED';
    })()`);
    await send('Page.navigate', { url: URL_ });
    await sleep(6000);
    console.log(`（已预置设置：${JSON.stringify(patch)}）`);
  }

  // RN web 的 Pressable 监听 pointer 事件，只发 click 不一定触发
  // 底栏现在是「助手 / 资料库 / 我的」（2026-09-18 起），导入入口在资料库页底部 ——
  // 原来那个独立的「工作台」Tab 已经不存在了（它的状态卡并进了助手页空态）
  console.log('\n=== 切到「资料库」→ 点击「导入文档」 ===');
  await clickText('资料库');
  await sleep(2000);
  const clicked = await clickText('导入文档');
  console.log(clicked);
  if (clicked !== 'CLICKED') throw new Error('找不到「＋ 导入文档」按钮');

  // picker 会往 body 里塞一个 display:none 的 input[type=file] 并 click()。
  // headless 下系统选择框不会出现，等它出现在 DOM 里后用 CDP 直接塞文件。
  let nodeId = null;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const doc = await send('DOM.getDocument', { depth: 2 });
    const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
    if (q?.nodeId) { nodeId = q.nodeId; break; }
  }
  if (!nodeId) throw new Error('picker 没有创建 input[type=file]，无法注入文件');

  console.log(`\n=== 注入文件 ${path.basename(absFile)} ===`);
  await send('DOM.setFileInputFiles', { files: [absFile], nodeId });
  await sleep(WAIT_PARSE);

  // 导入后先切到「资料库」再断言：解析来源/字数这些标签都在那一屏
  await clickText('资料库');
  await sleep(2500);
  const afterImport = await bodyText();
  console.log('--- 导入后界面（资料库） ---');
  console.log(afterImport.slice(0, 500));

  const results = [];
  const srcTag = (afterImport.match(/(本地解析|NAS解析|未解析)\s*(\d+)字/) || [])[0] || '没显示解析来源';
  results.push(['文档出现在资料库', /\.pdf|\.docx/i.test(afterImport) || /解析/.test(afterImport)]);
  results.push([`显示了解析来源与字数（实测「${srcTag}」）`, /解析\s*\d+字/.test(afterImport)]);
  if (process.env.SEED_PARSE_ENDPOINT) {
    results.push(['走的是 NAS 解析分支', afterImport.includes('NAS解析')]);
  }
  const chars = (afterImport.match(/解析\s*(\d+)字/) || [])[1];
  results.push([`解析出的字符数 > 500（实测 ${chars || '解析不到'}）`, !!chars && Number(chars) > 500]);

  if (KEYWORD) {
    console.log(`\n=== 搜索关键字「${KEYWORD}」 ===`);
    console.log(await typeInto('搜索资料', KEYWORD));
    await sleep(3000);
    const searchText = await bodyText();
    console.log('--- 搜索结果界面 ---');
    console.log(searchText.slice(0, 600));
    // 关键：查询【不要求原文照抄】。中文整句提问（如「固化剂配比是多少」）也必须能命中，
    // 这正是 BM25 + 中文分词要修的旧毛病（旧实现拿整句做 includes，一条都搜不到）。
    // 所以断言只看「有没有结果」，不看关键词是否字面出现在结果里。
    const hitCount = (searchText.match(/找到\s*(\d+)\s*条/) || [])[1];
    results.push([
      `搜索「${KEYWORD}」命中正文（实测 ${hitCount ? `${hitCount} 条` : '无结果'}）`,
      !!hitCount && Number(hitCount) > 0 && !/没有找到|无结果/.test(searchText),
    ]);
  }

  // ── 语义检索整条链：重建索引 → 提问 → 引用来源 ──
  // 验的是「换句话也能搜到」这件事在真浏览器里成立：问题用「有效期」，
  // 原文写的是「保质期」，零字面重叠 —— 只有向量那一路能捞到。
  if (EMBED && ASK) {
    // 「我的」现在是底栏第三格，直接点就行（以前要先回工作台、再点顶栏的齿轮）
    console.log('\n=== 底栏「我的」· 重建语义索引 ===');
    await clickText('我的');
    await sleep(2500);
    // 语义检索现在收在「服务与后端」折叠组里（默认收起 —— 这三个地址配一次就不再动了）
    console.log('展开折叠组:', await clickText('服务与后端'));
    await sleep(1200);
    const profile = await bodyText();
    if (!/重建语义索引/.test(profile)) {
      console.log(profile.slice(0, 800));
      throw new Error('「我的 → 服务与后端」展开后没找到「重建语义索引」按钮');
    }
    const embClick = await clickText('重建语义索引');
    console.log(embClick);
    // 注意要等「已建 N / M 块」里的 N 非 0 —— 初始态就是 0/M，用宽松正则会立刻返回假成功
    const afterRebuild = await waitFor(/已建\s*[1-9]\d*\s*\/\s*\d+\s*块/, 180000, '语义索引重建完成');
    console.log('--- 重建后 ---');
    console.log((afterRebuild.match(/语义检索[\s\S]{0,200}/) || [afterRebuild.slice(0, 300)])[0]);
    const em = afterRebuild.match(/已建\s*(\d+)\s*\/\s*(\d+)\s*块/);
    results.push([
      `重建语义索引后统计到向量（实测 已建 ${em?.[1] ?? '?'} / ${em?.[2] ?? '?'} 块）`,
      !!em && Number(em[1]) > 0 && em[1] === em[2],
    ]);

    console.log(`\n=== 切回「助手」· 提问「${ASK}」 ===`);
    await clickText('助手');
    await sleep(2500);
    console.log(await typeInto('输入问题', ASK));
    await sleep(500);
    await clickText('发送');
    // v3 里来源列表的标题从「引用来源」改成了「来源 · N · 按融合得分排序」
    const chatText = await waitFor(/来源\s*·\s*\d+/, 60000, '问答返回来源列表');
    console.log('--- 问答界面 ---');
    console.log(chatText.slice(0, 900));
    // 引用卡上要出现原文那段（保质期/储存条件），而不是别的段落
    results.push(['问答返回了来源列表', /来源\s*·\s*\d+/.test(chatText)]);
    results.push(['引用到了原文里讲保质期的那段（语义路命中）', /保质期|储存条件/.test(chatText)]);
    // 新增的信息层：检索步骤条 + 来源卡命中路徽章
    results.push([
      '检索步骤条摊开了过程（块数 / 命中数 / 双路各几条）',
      /已检索\s*\d+\s*块\s*·\s*命中\s*\d+\s*处/.test(chatText) && /BM25 命中\s*\d+/.test(chatText),
    ]);
    results.push(['来源卡标出了命中路徽章', /KW\+SEM|语义|KW|钉住/.test(chatText)]);

    // 文字裁切自检：问答屏是内容最密的一屏（胶囊、步骤条、来源卡挤在一起），
    // 最容易出现「盒子被压小、汉字下半截被切掉」这种肉眼看不出来的问题。
    const chatClip = await evaluate(SCAN_EXPR);
    results.push([`问答屏没有文字被裁切（扫到 ${chatClip.length} 处疑似）`, chatClip.length === 0]);
    chatClip.forEach((b) => console.log(`   ⚠️ ${describe(b)}`));

    // ---------- 核对模式（原「对比」页）----------
    // C 方案之后它降级成输入栏上方的模式开关：切模式 → 贴要求 → 点「核对」。
    // 结果作为一条会话消息回来（不再有独立结果区），所以刷新、切会话都不会丢。
    console.log('\n=== 切到「贴要求核对」· 跑一次逐项判定 ===');
    console.log('切模式:', await clickText('贴要求核对'));
    await sleep(1200);
    console.log(await typeInto('贴上技术要求', '弯曲强度 ≥ 110 MPa\n拉伸强度 ≥ 75 MPa\n热变形温度 ≥ 130 °C'));
    await sleep(600);
    console.log('开始核对:', await clickText('核对'));
    const cmpText = await waitFor(/已对要求逐项比对|满足/, 90000, '核对结果');
    console.log('--- 核对界面 ---');
    console.log(cmpText.slice(0, 900));
    results.push(['核对模式输出了逐项判定', /满足/.test(cmpText)]);
    results.push(['判定结果落进了会话消息（而不是独立结果区）', /已对要求逐项比对/.test(cmpText)]);

    // 对比屏的判定表是等宽三列 + 右侧 pill，列宽最容易把长中文压出裁切
    const cmpClip = await evaluate(SCAN_EXPR);
    results.push([`对比屏没有文字被裁切（扫到 ${cmpClip.length} 处疑似）`, cmpClip.length === 0]);
    cmpClip.forEach((b) => console.log(`   ⚠️ ${describe(b)}`));
    await sleep(800);
    const cmpShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('/tmp/shot-compare.png', Buffer.from(cmpShot.data, 'base64'));
  } else if (EMBED || ASK) {
    console.log('\n（SEED_EMBED_ENDPOINT 与 ASK 需同时提供才会验语义路，本次跳过）');
  }

  console.log('\n=== 断言 ===');
  let bad = 0;
  for (const [name, ok] of results) {
    console.log(`${ok ? '✅' : '❌'} ${name}`);
    if (!ok) bad++;
  }
  if (logs.length) {
    console.log('\n=== 控制台异常 ===');
    console.log(logs.slice(0, 20).join('\n'));
  }

  // 留一张截图便于人工确认
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const out = '/tmp/web-import-check.png';
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`\n截图：${out}`);

  ws.close();
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
