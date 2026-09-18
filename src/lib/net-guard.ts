/**
 * 联网守卫：把「离线模式」与「云端调用需确认」这两个隐私开关真正接到网络层。
 *
 * 为什么单独一个模块：这两个开关要在 lib/ 的各个请求点生效，而 lib/ 不能 import store
 * （store 反过来 import lib，会成环）。所以这里放一对可注入的开关 + 确认钩子，
 * 由 store 在 init / updateSettings 时推给它，lib 只负责读。
 *
 * 这两件事以前是【空壳开关】——界面上能点，但没有任何代码读它，
 * 打开「离线模式」照样联网、打开「云端需确认」从不弹窗。
 * 这种假功能比没有更糟：用户以为被保护着，出问题时也想不到要怀疑它。
 */

let offline = false;
let confirmEnabled = false;
let confirmHook: ((what: string) => Promise<boolean>) | null = null;

/**
 * store 在 init / 每次保存设置后调用，把当前开关状态推过来。
 *
 * 只更新【显式传入】的字段，不把 undefined 当作 false：
 * 签名里两者都是可选，若写成 `offline = !!v.offlineMode`，那么一次「只想改确认开关」的部分推送
 * 就会把离线模式静默关掉 —— 保护消失且界面上的开关还亮着，属于最难查的一类问题。
 * 反过来，万一某次推送漏了字段，结果是「保持原状」而不是「静默放开」，偏向 fail-safe。
 */
export function setPrivacySwitches(v: { offlineMode?: boolean; cloudConfirm?: boolean }): void {
  if (v.offlineMode !== undefined) offline = !!v.offlineMode;
  if (v.cloudConfirm !== undefined) confirmEnabled = !!v.cloudConfirm;
}

/** UI 层挂确认弹窗；返回 false = 用户拒绝。没挂钩子时不阻塞（离线脚本、无 UI 场景） */
export function setConfirmHook(fn: ((what: string) => Promise<boolean>) | null): void {
  confirmHook = fn;
}

export function isOffline(): boolean {
  return offline;
}

/** 所有对外请求的第一行守卫 */
export function assertOnline(what: string): void {
  if (offline) {
    throw new Error(
      `已开启「离线模式」，${what}需要联网。\n` +
      `→ 去「我的 → 隐私与安全」关掉离线模式；或改用手机本地模型 + 本地解析，全程不联网。`
    );
  }
}

/**
 * 从 URL 里抠出主机名。
 *
 * 刻意不用 `new URL()`：RN（Hermes）里 URL 的实现不完整，历史上有过解析出错的版本。
 * 一个正则就够用，且行为在原生与 web 上完全一致 —— 这个判断会被用来决定要不要弹窗，
 * 两个平台给出不同答案的话，「同一份资料在手机上问了、在浏览器里没问」会非常难查。
 */
function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?\[?([^\]/:?#]+)\]?/i.exec(url || '');
  return m ? m[1].toLowerCase() : '';
}

/**
 * 是否「没出本机 / 没出内网」。
 *
 * 用来决定要不要弹「云端调用需确认」：内网自托管（NAS 上的 Ollama、解析服务、向量服务）
 * 不该被拦 —— 资料压根没离开用户的网络。若连这个也弹，用户很快就会把开关关掉，
 * 反而连真正外发的调用也一起失去保护。
 */
export function isPrivateHost(url: string): boolean {
  const h = hostOf(url);
  if (!h) return false; // 解析不出地址 → 当成外部，宁可多问一次
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal')) return true;
  // 不带点的纯主机名（如 nas / tower）通常就是局域网机器名
  if (!h.includes('.')) return true;
  return false;
}

/** 这次调用会不会把资料发到外部（= 需要用户确认） */
export function needsExternalConfirm(url: string): boolean {
  if (!confirmEnabled) return false;
  return !isPrivateHost(url);
}

/**
 * 发外部请求前的确认。返回 false = 用户点了「取消」。
 * 只有「确认开关开着 + 目标是外部地址 + 挂了 UI 钩子」三者同时成立才真的问。
 */
export async function confirmExternal(what: string, url: string): Promise<boolean> {
  if (!needsExternalConfirm(url)) return true;
  if (!confirmHook) return true;
  return confirmHook(`${what}\n目标：${url}`);
}
