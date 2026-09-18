/**
 * NAS 解析服务客户端 —— 方案 C 的「高精度」分支。
 *
 * 手机本地能解析 PDF（见 pdf-lite.ts），但对复杂排版、嵌入字体、加密流的 PDF
 * 质量有限；NAS 上的服务用 PyMuPDF 解析，质量与稳定性都更好。两者关系是
 * 「能连上就用 NAS，连不上自动退回本地」，不影响离线可用性。
 *
 * 服务端代码与部署方式见项目内 `nas-parse/` 目录。
 */

export interface NasParseResult {
  text: string;
  pages: number;
  /** 0~1 */
  quality: number;
  /** 服务端用的解析引擎，便于排查（如 "pymupdf"） */
  engine?: string;
}

/** 把 Uint8Array 安全地转成 fetch 可用的 ArrayBuffer（不能直接传 buffer，可能有偏移） */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const trimUrl = (u: string) => u.trim().replace(/\/+$/, '');

/** 带超时的 fetch（AbortController 在 RN 与浏览器都可用） */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    return await fetch(url, ctl ? { ...init, signal: ctl.signal } : init);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * 把文档交给 NAS 解析。失败一律抛错，由调用方决定是否降级到本地解析。
 */
export async function parseViaNas(
  bytes: Uint8Array,
  name: string,
  endpoint: string,
  token?: string,
  timeoutMs = 90000
): Promise<NasParseResult> {
  const base = trimUrl(endpoint);
  if (!base) throw new Error('未配置解析服务地址');

  const res = await fetchWithTimeout(
    `${base}/parse?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...authHeaders(token) },
      body: toArrayBuffer(bytes),
    },
    timeoutMs
  );

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) throw new Error('鉴权失败，请检查解析服务令牌');
    if (res.status === 413) throw new Error('文件过大，解析服务拒绝接收');
    throw new Error(`HTTP ${res.status}${txt ? `：${txt.slice(0, 120)}` : ''}`);
  }

  const data = (await res.json()) as Partial<NasParseResult>;
  if (typeof data.text !== 'string') throw new Error('解析服务返回格式不正确');
  return {
    text: data.text,
    pages: typeof data.pages === 'number' ? data.pages : 0,
    quality: typeof data.quality === 'number' ? data.quality : 0.9,
    engine: data.engine,
  };
}

/** 连通性测试：供「我的 → NAS 解析服务」里的测试按钮使用 */
export async function testParseService(
  endpoint: string,
  token?: string,
  timeoutMs = 8000
): Promise<{ ok: boolean; message: string; engine?: string }> {
  const base = trimUrl(endpoint);
  if (!base) return { ok: false, message: '请先填写解析服务地址' };
  try {
    const res = await fetchWithTimeout(`${base}/health`, { headers: authHeaders(token) }, timeoutMs);
    if (!res.ok) return { ok: false, message: `服务返回 HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { engine?: string; version?: string };
    return { ok: true, message: `服务正常${data.version ? `（v${data.version}）` : ''}`, engine: data.engine };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `连接失败：${msg}（网页预览受 CORS 限制属正常，请以真机为准）` };
  }
}
