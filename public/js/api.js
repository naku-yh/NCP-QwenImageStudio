/* API 客户端:全部经本地网关 /p?url=… 转发,同源无 CORS 问题 */

const DEFAULTS = { base: 'http://192.168.31.30:8100', key: '' };
const LS_KEY = 'ncp-qwen-settings';

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings = load();

export function saveSettings(patch) {
  Object.assign(settings, patch);
  localStorage.setItem(LS_KEY, JSON.stringify({ base: settings.base, key: settings.key }));
}

export function proxyUrl(abs) {
  return '/p?url=' + encodeURIComponent(abs);
}

/** 结果里的图片地址 → 可直接用于 <img>/fetch 的同源地址 */
export function assetUrl(u) {
  if (!u) return '';
  if (u.startsWith('data:') || u.startsWith('/')) return u;
  return proxyUrl(u);
}

export class ApiError extends Error {
  constructor(status, message, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function request(path, { method = 'GET', body, headers, signal } = {}) {
  const h = { ...headers };
  if (settings.key) h['Authorization'] = 'Bearer ' + settings.key;
  let res;
  try {
    res = await fetch(proxyUrl(settings.base.replace(/\/+$/, '') + path), {
      method, body, headers: h, signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, '网络请求失败:无法连接本地网关,请确认 server.py 正在运行');
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    let msg = data?.error?.message || data?.detail || data?.error || text.slice(0, 300) || `HTTP ${res.status}`;
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
    if (res.status === 503) msg = '生成队列已满(最多 4 个),请稍后重试';
    if (res.status === 502) msg = data?.error || '无法连接 API 服务器,请检查地址与服务状态';
    throw new ApiError(res.status, msg, data);
  }
  return data;
}

export const api = {
  health: (signal) => request('/health', { signal }),
  generate: (params, signal) => request('/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  }),
  edit: (form, signal) => request('/v1/images/edits', { method: 'POST', body: form, signal }),
};

export async function fetchAssetBlob(url, signal) {
  const r = await fetch(assetUrl(url), { signal });
  if (!r.ok) throw new ApiError(r.status, '图片下载失败');
  return r.blob();
}
