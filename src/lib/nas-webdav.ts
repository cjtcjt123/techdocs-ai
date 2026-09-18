// WebDAV 客户端：连接测试 / 列目录 / 下载文件
// 基于标准 fetch + Basic 鉴权，iOS 与 Web 通用。
// 注意：Web 预览受浏览器 CORS 与证书限制，连接/同步以真机为准；SMB 留接口占位。
import type { NasConnection } from '../types';

function baseUrl(conn: NasConnection): string {
  const scheme = conn.secure ? 'https' : 'http';
  const port = conn.port ? `:${conn.port}` : '';
  let path = conn.path || '/';
  if (!path.startsWith('/')) path = '/' + path;
  return `${scheme}://${conn.host}${port}${path}`;
}

// ASCII-only Base64（Basic 鉴权，凭证通常不含非 ASCII，避免依赖 btoa 在各端不一致）
function base64(str: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < str.length; i += 3) {
    const b0 = str.charCodeAt(i) & 0xff;
    const b1 = i + 1 < str.length ? str.charCodeAt(i + 1) & 0xff : 0;
    const b2 = i + 2 < str.length ? str.charCodeAt(i + 2) & 0xff : 0;
    out += chars[b0 >> 2]
      + chars[((b0 & 3) << 4) | (b1 >> 4)]
      + (i + 1 < str.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=')
      + (i + 2 < str.length ? chars[b2 & 63] : '=');
  }
  return out;
}

function authHeader(conn: NasConnection, password: string): Record<string, string> {
  if (!conn.user) return {};
  return { Authorization: `Basic ${base64(`${conn.user}:${password}`)}` };
}

export interface NasEntry {
  name: string;
  href: string;
  isDir: boolean;
  size: number;
}

export async function testConnection(conn: NasConnection, password: string): Promise<{ ok: boolean; message: string }> {
  const url = baseUrl(conn);
  try {
    const res = await fetch(url, { method: 'PROPFIND', headers: { ...authHeader(conn, password), Depth: '0' } });
    if (res.status === 401) return { ok: false, message: '鉴权失败（用户名 / 密码错误）' };
    if (res.ok || res.status === 207) return { ok: true, message: `连接成功（HTTP ${res.status}）` };
    // 部分服务器不支持 PROPFIND，退回 GET 探测
    const res2 = await fetch(url, { method: 'GET', headers: authHeader(conn, password) });
    if (res2.status === 401) return { ok: false, message: '鉴权失败（用户名 / 密码错误）' };
    if (res2.ok) return { ok: true, message: '连接成功' };
    return { ok: false, message: `连接失败（HTTP ${res2.status}）` };
  } catch (e: any) {
    return { ok: false, message: `连接异常：${e?.message || String(e)}（Web 预览可能受 CORS / 证书限制，真机为准）` };
  }
}

export async function listDir(conn: NasConnection, password: string, subPath = ''): Promise<NasEntry[]> {
  const root = baseUrl(conn).replace(/\/$/, '');
  const url = root + (subPath.startsWith('/') ? subPath : subPath ? '/' + subPath : '');
  const res = await fetch(url, { method: 'PROPFIND', headers: { ...authHeader(conn, password), Depth: '1' } });
  if (!res.ok && res.status !== 207) throw new Error(`列目录失败（HTTP ${res.status}）`);
  const xml = await res.text();
  const entries = parsePropfind(xml);
  const baseName = url.split('/').filter(Boolean).pop() || '';
  // 过滤掉目录自身（与请求路径同名那个）
  return entries.filter((e) => !(e.isDir && e.name === baseName));
}

export async function downloadText(conn: NasConnection, password: string, href: string): Promise<string> {
  const res = await fetch(href, { method: 'GET', headers: authHeader(conn, password) });
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
  return await res.text();
}

// 命名空间无关的 PROPFIND 解析：标准 WebDAV 返回 multistatus，元素可能带 d: / D: 等前缀
function parsePropfind(xml: string): NasEntry[] {
  const out: NasEntry[] = [];
  const re = /<([\w-]*:)?response[^>]*>([\s\S]*?)<\/\1response>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const block = m[2];
    const hrefM = block.match(/<([\w-]*:)?href>\s*([\s\S]*?)\s*<\/\1href>/i);
    if (!hrefM) continue;
    const href = decodeURIComponent((hrefM[2] || '').trim());
    const isDir = /<([\w-]*:)?resourcetype[^>]*>[\s\S]*?<([\w-]*:)?collection/i.test(block);
    const sizeM = block.match(/<([\w-]*:)?getcontentlength>\s*(\d+)\s*<\/\1getcontentlength>/i);
    const size = sizeM ? parseInt(sizeM[2], 10) : 0;
    const name = href.split('/').filter(Boolean).pop() || href;
    out.push({ name, href, isDir, size });
  }
  return out;
}
