/**
 * 出「人看的」演示截图（不写断言）。
 *
 * 与 web-*-check.js 的分工：那些脚本验的是「有没有坏」，会在跑的过程中反复改写 localStorage
 * （预置/编辑/删除），所以它们产出的截图里数据是被改过的中间态，不适合拿去演示。
 * 这个脚本只读不写 —— 用它给真实数据（或手工灌进去的演示数据）留一份照片。
 *
 * 用法：
 *   1) 起 dev server（见项目记忆里的固定命令）
 *   2) 用 --remote-debugging-port=9222 起 Chrome
 *   3) SHOT_DIR=/tmp/demo-shot node scripts/web-demo-shots.js [url]
 *
 * 点击一律走「面积最小、非零尺寸的真实鼠标事件 + 点前 elementFromPoint 复核」——
 * 三条坑的成因写在 web-case-list-check.js 的 HIT_EXPR 上方注释里。
 */
const fs = require('fs');

const URL_ = process.argv[2] || 'http://localhost:8081';
const PORT = process.env.CDP_PORT || 9222;
const WAIT_BOOT = Number(process.env.WAIT_BOOT || 25000);
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/demo-shot';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
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
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`CDP 连接失败: ${e.message || e.type}`));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: Number(process.env.CDP_W || 430),
    height: Number(process.env.CDP_H || 932),
    deviceScaleFactor: 2,
    mobile: (process.env.CDP_MOBILE || '1') === '1',
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS 执行出错');
    return r?.result?.value;
  };

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(r.data, 'base64'));
    console.log(`  📷 ${name}`);
  };

  const SEL = '[role="button"], [role="tab"], button, a, [tabindex], div';
  const boxOf = (text, sel = SEL) => `(() => {
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
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, t: (el.innerText || '').trim().slice(0, 30) };
  })()`;

  // 落点复核：只判「那个坐标上有没有东西」是弱断言（页面处处都有背景层），
  // 必须判「落点确实在目标元素的子树里」—— 否则点到遮罩上会被当成点击成功，
  // 而实际效果是「弹层被关掉了」，症状是截图跟上一张一模一样（我就这么踩过一次）。
  const clickBox = async (box, landExpr) => {
    if (!box) return 'NOT_FOUND';
    if (landExpr && !(await evaluate(landExpr))) return 'MISLANDED';
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: Math.round(box.x), y: Math.round(box.y),
        button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
      });
    }
    await sleep(600);
    return `CLICKED(${box.t})`;
  };
  const click = async (text, sel) => clickBox(await evaluate(boxOf(text, sel)));

  // 找出弹层主体。
  //
  // ⚠️ 锚点不能只用一个短标记：「含『保存到经验库』的最小元素」就是那个提交按钮本身，
  // 再往里找「失败」必然 NOT_FOUND。要用【同时含多个标记】的最小元素 —— 只有弹层主体
  // 才同时包含标题区、字段区、提交按钮这几处文字。（我第一次就是单标记，白跑一轮。）
  const scopeExpr = (markers) => `(() => {
    const MS = ${JSON.stringify(markers)};
    const vis = Array.from(document.querySelectorAll('div')).filter((e) => {
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const t = e.innerText || '';
      return MS.every((m) => t.includes(m));
    });
    if (!vis.length) return null;
    vis.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
    return vis[0];
  })()`;

  // 在弹层子树里点一个精确文字的元素，并在点之前复核落点仍在这个子树内
  const clickInSheet = async (markers, targetText) => {
    const box = await evaluate(`(() => {
      const scope = ${scopeExpr(markers)};
      if (!scope) return null;
      const T = ${JSON.stringify(targetText)};
      const cand = Array.from(scope.querySelectorAll('div')).filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (e.innerText || '').trim() === T;
      });
      if (!cand.length) return null;
      cand.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      });
      const el = cand[0];
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, t: (el.innerText || '').trim() };
    })()`);
    if (!box) return 'NOT_FOUND';
    const landExpr = `(() => {
      const scope = ${scopeExpr(markers)};
      if (!scope) return false;
      const p = document.elementFromPoint(${Math.round(box.x)}, ${Math.round(box.y)});
      return !!p && scope.contains(p);
    })()`;
    return clickBox(box, landExpr);
  };

  // 分段 chip 与底部 Tab 都叫「资料库」→ 只认「跟另一个分段同父」的候选
  const clickSegment = async (label) => {
    const box = await evaluate(`(() => {
      const LABELS = ['资料库', '经验库'], T = ${JSON.stringify(label)};
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
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, t: T };
    })()`);
    return clickBox(box);
  };

  await send('Page.navigate', { url: URL_ });
  await sleep(WAIT_BOOT);
  console.log('  （已加载）');

  await shot('00-助手');
  console.log('  切资料库：', await click('资料库'));
  await sleep(900);
  await shot('01-资料库');

  console.log('  切经验库分段：', await clickSegment('经验库'));
  await sleep(900);
  await shot('02-经验库列表');

  // 失败那条的详情：认它独有的 finalFix，确认点开的是它
  const FAIL_FIX = '回到 100:45 并把操作环境升到 25℃';
  console.log('  点开失败案例：', await click('为延长适用期降低固化剂比例'));
  await sleep(900);
  const t = await evaluate('document.body.innerText');
  console.log(`  弹层里是这条吗：${t.includes(FAIL_FIX) ? '✅ 是' : '❌ 不是'}`);
  await shot('03-失败详情');

  console.log('  关弹层：', await click('✕'));
  await sleep(600);

  console.log('  点＋新建：', await click('＋ 新建'));
  await sleep(1000);
  await shot('04-新建表单');

  // 表单里选「失败」—— 限定在弹层主体内点（「失败」也是列表页的筛选 chip），
  // 并复核字段名是否真的跟着换了（否则点空只会静默关掉弹层）
  const SHEET = ['保存到经验库', '最终怎么解决的'];
  console.log('  在表单里选「失败」：', await clickInSheet(SHEET, '失败'));
  await sleep(700);
  const after = await evaluate('document.body.innerText');
  console.log(
    `  字段名是否已换成「试过什么、后来怎样」：${
      after.includes('试过什么、后来怎样') ? '✅ 是' : '❌ 否（可能点空了）'
    }`
  );
  console.log(`  旧文案「最终怎么解决的」是否已消失：${after.includes('最终怎么解决的') ? '❌ 还在' : '✅ 已消失'}`);
  await shot('05-表单选失败');

  // 等某段文字出现在页面上（而不是拍一个固定秒数就点）——
  // 固定等待在下一次改版/换机器时会静默失效：点了个还没渲染出来的元素，返回 NOT_FOUND
  // 但脚本照样往下走，最后留下的状态是错的，而日志里看不出来。
  const waitForText = async (text, ms = 30000) => {
    for (let i = 0; i < ms / 250; i++) {
      const t = await evaluate('document.body ? document.body.innerText : ""');
      if ((t || '').includes(text)) return true;
      await sleep(250);
    }
    return false;
  };

  // 收尾：不要留着半开的表单 —— 这个浏览器窗口可能被人直接接管去看。
  // 重新加载后停在经验库列表（而不是默认的「助手」），打开就能看到东西。
  console.log('\n  收尾：把页面停在经验库列表');
  await send('Page.navigate', { url: URL_ });
  // 底栏与页面标题都叫「助手」，这里只要判断界面起来了，用哪个都行
  const booted = await waitForText('助手', WAIT_BOOT * 2);
  console.log(`  界面已就绪：${booted ? '✅' : '❌ 超时'}`);
  console.log('  切资料库：', await click('资料库'));
  await sleep(900);
  console.log('  切经验库分段：', await clickSegment('经验库'));
  await sleep(900);
  const landed = await evaluate('document.body.innerText');
  console.log(
    `  当前停在：${landed.includes('共 3 条') ? '✅ 经验库列表' : '❌ ' + (landed.split('\n')[0] || '空')}`
  );

  console.log(`\n截图目录：${SHOT_DIR}`);
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('出错了：', e.message);
  process.exit(1);
});
