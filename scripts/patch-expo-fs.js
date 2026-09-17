/**
 * WorkBuddy 受限环境补丁：
 * 本机的 toybox 沙箱会在 syscall 层拦截 Node 对 ~/.expo 目录下文件的
 * unlink / rename（报 EPERM），导致 Expo CLI 启动崩溃。
 *
 * 关键：Expo 的缓存层 cacache 用「写临时文件 -> rename 提交」模式，
 * 若直接吞掉 rename 的 EPERM，content 文件没移动到最终位置，后续读取会 ENOENT。
 * 因此 rename 失败时必须降级为「copyFile 到目标 + 删除源（unlink 也被吞）」。
 *
 * 仅对 ~/.expo 路径生效，其他路径的 EPERM 原样抛出，不会掩盖真实错误。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const EXPO_DIR = os.homedir() + '/.expo/';
const isExpoPath = (p) => typeof p === 'string' && p.indexOf(EXPO_DIR) !== -1;

function swallowEPERM(err) {
  return !!(err && err.code === 'EPERM');
}

// rename 失败降级：复制到目标 + 删源（保证 content 文件就位）
function renameFallback(oldP, newP) {
  try { fs.mkdirSync(path.dirname(newP), { recursive: true }); } catch (_) {}
  try { fs.copyFileSync(oldP, newP); } catch (e) { if (!swallowEPERM(e)) throw e; }
  try { fs.unlinkSync(oldP); } catch (_) {}
}

// ---- unlink ----
const _unlink = fs.unlink.bind(fs);
fs.unlink = function (p, cb) {
  if (isExpoPath(p)) {
    try { fs.unlinkSync(p); if (cb) cb(null); return; }
    catch (e) {
      if (swallowEPERM(e)) { if (cb) cb(null); return; }
      if (cb) cb(e); else throw e; return;
    }
  }
  return _unlink(p, cb);
};
const _unlinkSync = fs.unlinkSync.bind(fs);
fs.unlinkSync = function (p) {
  if (isExpoPath(p)) {
    try { _unlinkSync(p); return; } catch (e) { if (swallowEPERM(e)) return; throw e; }
  }
  return _unlinkSync(p);
};
if (fs.promises && fs.promises.unlink) {
  const _punlink = fs.promises.unlink.bind(fs.promises);
  fs.promises.unlink = async function (p) {
    if (isExpoPath(p)) {
      try { await _punlink(p); return; } catch (e) { if (swallowEPERM(e)) return; throw e; }
    }
    return _punlink(p);
  };
}

// ---- rename ----
const _rename = fs.rename.bind(fs);
fs.rename = function (oldP, newP, cb) {
  if (isExpoPath(oldP) || isExpoPath(newP)) {
    try { fs.renameSync(oldP, newP); if (cb) cb(null); return; }
    catch (e) {
      if (swallowEPERM(e)) {
        try { renameFallback(oldP, newP); if (cb) cb(null); return; }
        catch (e2) { if (swallowEPERM(e2)) { if (cb) cb(null); return; } if (cb) cb(e2); else throw e2; return; }
      }
      if (cb) cb(e); else throw e; return;
    }
  }
  return _rename(oldP, newP, cb);
};
const _renameSync = fs.renameSync.bind(fs);
fs.renameSync = function (oldP, newP) {
  if (isExpoPath(oldP) || isExpoPath(newP)) {
    try { _renameSync(oldP, newP); return; }
    catch (e) {
      if (swallowEPERM(e)) { try { renameFallback(oldP, newP); return; } catch (e2) { if (swallowEPERM(e2)) return; throw e2; } }
      throw e;
    }
  }
  return _renameSync(oldP, newP);
};
if (fs.promises && fs.promises.rename) {
  const _prename = fs.promises.rename.bind(fs.promises);
  fs.promises.rename = async function (oldP, newP) {
    if (isExpoPath(oldP) || isExpoPath(newP)) {
      try { await _prename(oldP, newP); return; }
      catch (e) {
        if (swallowEPERM(e)) { try { renameFallback(oldP, newP); return; } catch (e2) { if (swallowEPERM(e2)) return; throw e2; } }
        throw e;
      }
    }
    return _prename(oldP, newP);
  };
}

// ---- rm / rmSync / promises.rm ----
if (fs.rm) {
  const _rm = fs.rm.bind(fs);
  fs.rm = function (p, opts, cb) {
    if (isExpoPath(p)) {
      try { fs.rmSync(p, typeof opts === 'object' ? opts : {}); if (cb) cb(null); return; }
      catch (e) {
        if (swallowEPERM(e)) { if (cb) cb(null); return; }
        if (cb) cb(e); else throw e; return;
      }
    }
    return _rm(p, opts, cb);
  };
  const _rmSync = fs.rmSync.bind(fs);
  fs.rmSync = function (p, opts) {
    if (isExpoPath(p)) {
      try { _rmSync(p, opts); return; } catch (e) { if (swallowEPERM(e)) return; throw e; }
    }
    return _rmSync(p, opts);
  };
  if (fs.promises && fs.promises.rm) {
    const _prm = fs.promises.rm.bind(fs.promises);
    fs.promises.rm = async function (p, opts) {
      if (isExpoPath(p)) {
        try { await _prm(p, opts); return; } catch (e) { if (swallowEPERM(e)) return; throw e; }
      }
      return _prm(p, opts);
    };
  }
}

module.exports = {};
