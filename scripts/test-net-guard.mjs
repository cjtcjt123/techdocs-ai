/**
 * 联网守卫（net-guard）离线测试
 *
 * 这两件事都靠它：
 *   · 离线模式 —— 该拦的没拦住 = 用户以为断网了，资料照发
 *   · 云端调用需确认 —— 该问的没问 = 资料静默外发；不该问的问了 = 用户把开关关掉，
 *     连真正外发的调用一起失去保护
 *
 * 所以两边的判据都要钉住，尤其是内网/外网的边界（172.16–31 是私有，172.32 不是；
 * 带用户名密码的地址、IPv6 回环、以及不带点的机器名）。
 *
 * 用法：node --no-warnings scripts/test-net-guard.mjs
 */
import {
  isPrivateHost,
  needsExternalConfirm,
  confirmExternal,
  assertOnline,
  setPrivacySwitches,
  setConfirmHook,
  isOffline,
} from '../src/lib/net-guard.ts';

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fails.push(name + (extra ? `  → ${extra}` : ''));
}
function eq(name, got, want) {
  ok(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

// ---------- A. 内网判定 ----------
console.log('=== A. isPrivateHost：内网（不该弹窗）===');
const PRIVATE = [
  'http://localhost:8788',
  'http://127.0.0.1:8788/parse?name=x.pdf',
  'http://[::1]:8081',
  'http://192.168.0.109:8787',
  'https://192.168.1.1',
  'http://10.0.0.5:11434/v1',
  'http://172.16.0.1',
  'http://172.31.255.254',
  'http://169.254.1.1',
  'http://nas:5005/dav',
  'http://tower.local/webdav',
  'http://box.lan/',
  'http://git.internal/',
  // 带用户名密码的地址：userinfo 必须被跳过，否则会把「user」当成主机名
  'http://user:pw@192.168.0.1:5005/dav',
  'http://user:pw@nas:5005',
];
for (const u of PRIVATE) eq(u, isPrivateHost(u), true);

console.log('\n=== B. isPrivateHost：外网（该弹窗）===');
const PUBLIC = [
  'https://api.openai.com/v1',
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://open.bigmodel.cn/api/paas/v4',
  'https://api.deepseek.com',
  'https://api.anthropic.com/v1',
  'https://api.openai.com/v1/embeddings',
  'https://8.8.8.8/v1',
  'http://203.0.113.10:8787',
  // 172.32 起就不是私有段了 —— 172.16–31 才是。这条最容易写错成 /^172\./
  'http://172.32.0.1',
  'http://172.15.0.1',
  'http://user:pw@example.com',
];
for (const u of PUBLIC) eq(u, isPrivateHost(u), false);

console.log('\n=== C. 解析不出地址时按「外部」处理（宁可多问一次）===');
for (const u of ['', 'not a url', 'api.openai.com/v1', '//api.openai.com']) {
  eq(JSON.stringify(u), isPrivateHost(u), false);
}

// ---------- D. 开关门禁 ----------
console.log('\n=== D. needsExternalConfirm 的门禁 ===');
setPrivacySwitches({ offlineMode: false, cloudConfirm: false });
eq('确认开关关着 → 外网地址也不问', needsExternalConfirm('https://api.openai.com/v1'), false);
setPrivacySwitches({ offlineMode: false, cloudConfirm: true });
eq('确认开关开着 → 外网地址要问', needsExternalConfirm('https://api.openai.com/v1'), true);
eq('确认开关开着 → 内网地址不问', needsExternalConfirm('http://192.168.0.109:8787'), false);
setPrivacySwitches({ offlineMode: true, cloudConfirm: true });
eq('离线模式下 needsExternalConfirm 仍只看确认开关', needsExternalConfirm('https://api.openai.com/v1'), true);

// ---------- E. confirmExternal 实际行为 ----------
console.log('\n=== E. confirmExternal ===');
let asked = [];
setConfirmHook(async (what) => { asked.push(what); return true; });

setPrivacySwitches({ offlineMode: false, cloudConfirm: false });
asked = [];
eq('开关关着 → 直接放行', await confirmExternal('发资料', 'https://api.openai.com/v1'), true);
eq('　且没有调用弹窗', asked.length, 0);

setPrivacySwitches({ offlineMode: false, cloudConfirm: true });
asked = [];
eq('内网 → 直接放行', await confirmExternal('发资料', 'http://192.168.0.109:8787'), true);
eq('　且没有调用弹窗', asked.length, 0);

asked = [];
const r1 = await confirmExternal('把 3 段资料发给嵌入服务', 'https://api.openai.com/v1');
eq('外网 → 调用弹窗并采用其结果（允许）', r1, true);
eq('　弹窗被调用一次', asked.length, 1);
ok('　弹窗文案带上了「发什么」', asked[0].includes('把 3 段资料发给嵌入服务'), asked[0]);
ok('　弹窗文案带上了「发去哪」', asked[0].includes('api.openai.com'), asked[0]);

setConfirmHook(async () => false);
eq('用户点了取消 → 返回 false', await confirmExternal('发资料', 'https://api.openai.com/v1'), false);

// 没挂 UI 钩子时不能阻塞（离线脚本、无界面场景）
setConfirmHook(null);
eq('没挂钩子 → 不阻塞，按放行处理', await confirmExternal('发资料', 'https://api.openai.com/v1'), true);

// ---------- F. 离线模式 ----------
console.log('\n=== F. assertOnline ===');
setPrivacySwitches({ offlineMode: false, cloudConfirm: false });
eq('离线模式关着 → isOffline 为 false', isOffline(), false);
let threw = null;
try { assertOnline('调用云端模型'); } catch (e) { threw = e; }
eq('　且不抛错', threw, null);

setPrivacySwitches({ offlineMode: true });
eq('离线模式打开 → isOffline 为 true', isOffline(), true);
threw = null;
try { assertOnline('调用云端模型'); } catch (e) { threw = e; }
ok('　抛错', !!threw);
ok('　错误信息说明是哪个动作被拦', !!threw && threw.message.includes('调用云端模型'), threw?.message);
ok('　错误信息给出可照做的下一步', !!threw && threw.message.includes('隐私与安全'), threw?.message);

// 开关可以部分更新（store 每次保存设置只推整个 privacy 对象，这里顺带钉住行为）
setPrivacySwitches({});
eq('只推空对象不会把离线模式冲掉', isOffline(), true);
setPrivacySwitches({ offlineMode: false });
eq('显式关掉才恢复', isOffline(), false);

// ---------- 汇总 ----------
console.log(`\n${'═'.repeat(46)}`);
console.log(`通过 ${pass}/${pass + fails.length}`);
if (fails.length) {
  console.log('失败项：');
  fails.forEach((f) => console.log('  ❌ ' + f));
  process.exit(1);
}
console.log('全部通过 ✅');
