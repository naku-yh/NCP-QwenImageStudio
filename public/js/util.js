/* 通用工具 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function toast(msg, type = 'info', ms) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = type === 'success' ? 'i-check' : type === 'error' ? 'i-info' : 'i-info';
  el.innerHTML = `<svg class="icon"><use href="#${icon}"/></svg><span></span>`;
  el.querySelector('span').textContent = msg;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, ms ?? (type === 'error' ? 6000 : 3200));
}

export function fmtElapsed(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${String(Math.floor(s % 60)).padStart(2, '0')} 秒`;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function randSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/** 对齐到 32 的倍数并夹在范围内 */
export function snap32(v, lo = 256, hi = 2752) {
  return clamp(Math.round(v / 32) * 32, lo, hi);
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name || 'image.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** 给 range input 设置已填充比例(CSS 渐变用) */
export function paintRange(input) {
  const min = +input.min || 0, max = +input.max || 100;
  const p = ((+input.value - min) / (max - min)) * 100;
  input.style.setProperty('--p', `${p}%`);
}
