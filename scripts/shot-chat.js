const fs = require('fs');
const PORT = 9222, URL_ = 'http://localhost:8081';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0; const pending = new Map();
  const send = (m, p) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: URL_ });
  await sleep(15000);
  // click 问答 tab
  const click = "(()=>{var c=Array.from(document.querySelectorAll('[role=button],button,a,[tabindex]'));var el=c.find(function(e){return (e.innerText||'').indexOf('助手')>=0});if(!el)return 'NF';var r=el.getBoundingClientRect();var o={bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2};['pointerdown','pointerup','click'].forEach(function(t){el.dispatchEvent(new MouseEvent(t,o))});return 'OK'})()";
  const cres = await send('Runtime.evaluate', { expression: click, returnByValue: true });
  console.log('click 问答:', cres.result && cres.result.value);
  await sleep(8000);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('screenshots/sdk54-chat.png', Buffer.from(shot.data, 'base64'));
  console.log('saved screenshots/sdk54-chat.png');
  ws.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
