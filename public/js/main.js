/* NCP-QwenImage 生成器 · 主逻辑 */
import { api, settings, saveSettings, assetUrl, fetchAssetBlob } from './api.js';
import { Annotator, flatten, loadImageFromBlob } from './annotator.js';
import { $, $$, esc, toast, fmtElapsed, fmtTime, randSeed, snap32, clamp, downloadBlob, copyText, paintRange } from './util.js';

const MODE_LABEL = { t2i: '文生图', edit: '图片编辑', multi: '多图生成' };
const HIST_KEY = 'ncp-qwen-history';
let _uid = 0;
const uid = () => `${Date.now().toString(36)}${(_uid++).toString(36)}`;

const state = {
  mode: 't2i',
  job: null,
  health: null,
  history: loadHistory(),
  edit: { file: null },
  multi: { items: [], selected: null },
};

/* ============ 表单校验辅助 ============ */
function err(msg, field) { const e = new Error(msg); e.field = field; throw e; }

/* ============ 模式切换 ============ */
function setMode(mode) {
  state.mode = mode;
  $$('.side-item').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $$('.mode').forEach(m => m.classList.toggle('active', m.id === `mode-${mode}`));
}
$$('.side-item').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

/* ============ 服务状态 ============ */
async function pollHealth() {
  try {
    state.health = await api.health();
  } catch {
    state.health = null;
  }
  renderStatus();
}

/* 状态灯直接映射服务器 phase 字段(encoding/denoising 等均视为工作中) */
const PHASE_LABEL = { encoding: '编码中', denoising: '去噪中', decoding: '解码中', loading: '加载模型' };

function renderStatus() {
  const dot = $('#srvDot');
  const h = state.health;
  if (!h) {
    dot.className = 'dot err';
    $('#srvState').textContent = '无法连接';
    $('#srvDetail').textContent = settings.base;
    return;
  }
  const phase = typeof h.phase === 'string' ? h.phase : 'idle';
  const phaseLabel = PHASE_LABEL[phase] || (phase === 'idle' ? '' : phase);
  const q = h.queued ?? h.queue_waiting ?? 0;
  if (phase !== 'idle') {
    dot.className = 'dot warn' + (state.job ? ' busy' : '');
    $('#srvState').textContent = state.job ? phaseLabel : `忙碌 · ${phaseLabel}`;
  } else if (state.job) {
    dot.className = 'dot warn busy';
    $('#srvState').textContent = '已提交 · 等待启动';
  } else if (q >= 3) {
    dot.className = 'dot warn';
    $('#srvState').textContent = `队列将满 ${q}`;
  } else {
    dot.className = 'dot ok';
    $('#srvState').textContent = h.status === 'ready' ? '服务正常' : h.status;
  }
  const v = h.vram || {};
  const used = Number.isFinite(v.used_gb) ? v.used_gb.toFixed(1) : '—';
  const total = Number.isFinite(v.total_gb) ? v.total_gb.toFixed(1) : '—';
  $('#srvDetail').textContent = `显存 ${used}/${total} GB · 队列 ${q}`;
}

function updateRunQueue() {
  $('#runQueue').textContent = '已提交至服务器 · 单卡串行执行,请耐心等待';
}

/* ============ 设置 ============ */
function openSettings() {
  $('#setBase').value = settings.base;
  $('#setKey').value = settings.key;
  $('#setTestResult').textContent = '';
  $('#settingsOverlay').hidden = false;
}
$('#serverPill').addEventListener('click', openSettings);
$('#setClose').addEventListener('click', () => { $('#settingsOverlay').hidden = true; });
$('#settingsOverlay').addEventListener('click', e => {
  if (e.target.id === 'settingsOverlay') $('#settingsOverlay').hidden = true;
});
$('#setSave').addEventListener('click', () => {
  const base = $('#setBase').value.trim().replace(/\/+$/, '');
  const r = $('#setTestResult');
  if (!/^https?:\/\/.+/.test(base)) {
    r.className = 'test-result err';
    r.textContent = '地址需以 http:// 或 https:// 开头';
    return;
  }
  saveSettings({ base, key: $('#setKey').value.trim() });
  $('#settingsOverlay').hidden = true;
  pollHealth();
  toast('设置已保存', 'success');
});
$('#setTest').addEventListener('click', async () => {
  const r = $('#setTestResult');
  r.className = 'test-result';
  r.textContent = '测试中…';
  const oldBase = settings.base;
  const oldKey = settings.key;
  saveSettings({ base: $('#setBase').value.trim().replace(/\/+$/, ''), key: $('#setKey').value.trim() });
  try {
    const h = await api.health();
    r.className = 'test-result ok';
    r.textContent = `连接成功 · ${h.status} · 队列 ${h.queue_waiting ?? 0}`;
  } catch (e) {
    r.className = 'test-result err';
    r.textContent = e.message;
    saveSettings({ base: oldBase, key: oldKey });
  }
});

/* ============ 任务调度(服务器串行,前端一次只跑一个) ============ */
async function runJob(mode, meta, promiseFn) {
  if (state.job) { toast('已有任务在执行,请稍候或停止等待', 'info'); return; }
  const ctrl = new AbortController();
  const t0 = performance.now();
  state.job = { ctrl, mode, t0 };
  renderStatus();
  $('#runLabel').textContent = `正在生成 · ${MODE_LABEL[mode]}`;
  $('#runElapsed').textContent = '0.0 秒';
  updateRunQueue();
  $('#mainRunning').hidden = false;
  const timer = setInterval(() => {
    $('#runElapsed').textContent = fmtElapsed(performance.now() - t0);
  }, 200);
  $$('.btn-generate').forEach(b => { b.disabled = true; });
  try {
    const result = await promiseFn(ctrl.signal);
    const elapsed = performance.now() - t0;
    const images = (result?.data || []).map(d => ({
      url: d.url || (d.b64_json ? `data:image/png;base64,${d.b64_json}` : ''),
      file: d.file || 'image.png',
      seed: d.seed ?? null,
    })).filter(i => i.url);
    if (!images.length) throw new Error('服务器未返回图片数据');
    const entry = { id: uid(), mode, prompt: meta.prompt, params: meta.params, images, elapsed, at: Date.now() };
    addHistory(entry);
    showResult(mode, entry);
    toast(`生成完成 · ${fmtElapsed(elapsed)}`, 'success');
  } catch (e) {
    if (e.name === 'AbortError') {
      toast('已停止等待。服务器上的任务仍会执行完毕,稍后可从历史记录查看', 'info', 5000);
    } else {
      toast(e.message || '生成失败', 'error');
      if (e.field) { const f = $(e.field); if (f) f.focus(); }
    }
  } finally {
    clearInterval(timer);
    state.job = null;
    $('#mainRunning').hidden = true;
    $$('.btn-generate').forEach(b => { b.disabled = false; });
    renderStatus();
    pollHealth();
  }
}
$('#runCancel').addEventListener('click', () => state.job?.ctrl.abort());

/* ============ 结果展示 ============ */
function showResult(mode, entry) {
  if (mode === 't2i') {
    $('#t2iEmpty').hidden = true;
    const grid = $('#t2iResult');
    grid.hidden = false;
    grid.innerHTML = entry.images.map((im, i) => `
      <figure class="result-item">
        <img src="${assetUrl(im.url)}" alt="生成结果 ${i + 1}" data-i="${i}">
        <figcaption class="ri-bar">
          <span class="ri-seed" title="种子">seed ${im.seed ?? '—'}</span>
          <span class="flex-sp"></span>
          <button class="icon-btn" data-dl="${i}" title="下载 PNG"><svg class="icon"><use href="#i-download"/></svg></button>
        </figcaption>
      </figure>`).join('');
    $$('img[data-i]', grid).forEach(img => img.addEventListener('click', () => openLightbox(entry, +img.dataset.i)));
    $$('[data-dl]', grid).forEach(b => b.addEventListener('click', () => downloadEntryImage(entry, +b.dataset.dl)));
    grid.scrollIntoView({ block: 'nearest' });
  } else {
    showResultCard(mode, entry);
  }
}

function showResultCard(scope, entry) {
  const card = $(`#${scope}ResultCard`);
  card.hidden = false;
  const isEdit = scope === 'edit';
  card.innerHTML = `
    <div class="rc-head">
      <b>生成完成</b><span class="rc-time">${fmtElapsed(entry.elapsed)}</span>
      <button class="icon-btn" data-close title="收起"><svg class="icon"><use href="#i-x"/></svg></button>
    </div>
    <div class="rc-thumbs">${entry.images.map((im, i) =>
      `<img src="${assetUrl(im.url)}" data-i="${i}" alt="结果 ${i + 1}" title="点击放大">`).join('')}</div>
    <div class="rc-actions">
      <button class="btn btn-secondary btn-sm" data-use>
        <svg class="icon"><use href="#i-${isEdit ? 'brush' : 'plus'}"/></svg>${isEdit ? '用作新底图' : '加入参考图'}
      </button>
      <button class="btn btn-secondary btn-sm" data-big>
        <svg class="icon"><use href="#i-external"/></svg>查看大图
      </button>
    </div>`;
  $$('img[data-i]', card).forEach(img => img.addEventListener('click', () => openLightbox(entry, +img.dataset.i)));
  $('[data-close]', card).addEventListener('click', () => { card.hidden = true; });
  $('[data-big]', card).addEventListener('click', () => openLightbox(entry, 0));
  $('[data-use]', card).addEventListener('click', async () => {
    const im = entry.images[0];
    try {
      const blob = await fetchAssetBlob(im.url);
      if (isEdit) {
        await editLoadBlob(blob, im.file);
        toast('已载入为编辑底图', 'success');
      } else {
        await multiAddBlob(blob, im.file);
        toast('已加入参考图列表', 'success');
      }
      card.hidden = true;
    } catch (e) {
      toast(e.message || '载入失败', 'error');
    }
  });
}

async function downloadEntryImage(entry, idx) {
  const im = entry.images[idx];
  try {
    const blob = await fetchAssetBlob(im.url);
    downloadBlob(blob, im.file || `ncp-qwen-${entry.id}.png`);
  } catch (e) {
    toast(e.message || '下载失败', 'error');
  }
}

/* ============ 历史记录 ============ */
function loadHistory() {
  try {
    const a = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}

function persistHistory() {
  try { localStorage.setItem(HIST_KEY, JSON.stringify(state.history.slice(0, 60))); } catch { /* 忽略容量问题 */ }
}

function addHistory(entry) {
  state.history.unshift(entry);
  renderHistory();
  persistHistory();
}

function renderHistory() {
  const grid = $('#histGrid');
  $('#histCount').textContent = state.history.length;
  $('#histEmpty').style.display = state.history.length ? 'none' : '';
  grid.querySelectorAll('.hist-item').forEach(n => n.remove());
  for (const en of state.history.slice(0, 60)) {
    const im = en.images[0];
    if (!im) continue;
    const b = document.createElement('button');
    b.className = 'hist-item';
    b.title = en.prompt || MODE_LABEL[en.mode];
    b.innerHTML = `<img src="${assetUrl(im.url)}" alt=""><span class="hm">${MODE_LABEL[en.mode] || ''}</span>`;
    b.querySelector('img').addEventListener('error', () => {
      const d = document.createElement('div');
      d.className = 'hist-item bad';
      d.title = '图片已失效(API 服务器可能已重启)';
      d.innerHTML = '<svg class="icon"><use href="#i-image"/></svg>';
      b.replaceWith(d);
    }, { once: true });
    b.addEventListener('click', () => openLightbox(en, 0));
    grid.appendChild(b);
  }
}

let clearTimer = null;
$('#histClear').addEventListener('click', () => {
  const btn = $('#histClear');
  if (btn.classList.contains('confirm')) {
    state.history = [];
    persistHistory();
    renderHistory();
    btn.classList.remove('confirm');
    btn.textContent = '清空';
    clearTimeout(clearTimer);
    toast('历史记录已清空', 'info');
  } else {
    btn.classList.add('confirm');
    btn.textContent = '确认清空?';
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      btn.classList.remove('confirm');
      btn.textContent = '清空';
    }, 2600);
  }
});

/* ============ 灯箱 ============ */
let lb = null;

function openLightbox(entry, idx) {
  lb = { entry, idx: Math.max(0, Math.min(idx, entry.images.length - 1)) };
  $('#lightbox').hidden = false;
  renderLightbox();
}

function renderLightbox() {
  if (!lb) return;
  const { entry, idx } = lb;
  const im = entry.images[idx];
  $('#lbImg').src = assetUrl(im.url);
  $('#lbMode').textContent = MODE_LABEL[entry.mode] || entry.mode;
  $('#lbPrompt').textContent = entry.prompt || '(无提示词)';
  const p = entry.params || {};
  const rows = [
    (p.width && p.height) ? ['尺寸', `${p.width} × ${p.height}`] : null,
    p.steps != null ? ['步数', p.steps] : null,
    im.seed != null ? ['种子', im.seed] : null,
    (p.n && p.n > 1) ? ['数量', p.n] : null,
    p.negative_prompt ? ['负向提示词', p.negative_prompt] : null,
    ['耗时', fmtElapsed(entry.elapsed)],
    ['时间', fmtTime(entry.at)],
    ['文件', im.file || '—'],
  ].filter(Boolean);
  $('#lbMeta').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  const many = entry.images.length > 1;
  $('#lbPrev').hidden = !many || idx === 0;
  $('#lbNext').hidden = !many || idx === entry.images.length - 1;
  $('#lbIndex').hidden = !many;
  $('#lbIndex').textContent = `${idx + 1} / ${entry.images.length}`;
}

function closeLightbox() {
  lb = null;
  $('#lightbox').hidden = true;
  $('#lbImg').src = '';
}
$('#lbClose').addEventListener('click', closeLightbox);
$('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') closeLightbox(); });
$('#lbPrev').addEventListener('click', () => { if (lb && lb.idx > 0) { lb.idx--; renderLightbox(); } });
$('#lbNext').addEventListener('click', () => { if (lb && lb.idx < lb.entry.images.length - 1) { lb.idx++; renderLightbox(); } });
$('#lbDownload').addEventListener('click', () => lb && downloadEntryImage(lb.entry, lb.idx));
$('#lbOpen').addEventListener('click', () => {
  if (!lb) return;
  window.open(assetUrl(lb.entry.images[lb.idx].url), '_blank');
});
$('#lbToEdit').addEventListener('click', async () => {
  if (!lb) return;
  const im = lb.entry.images[lb.idx];
  try {
    const blob = await fetchAssetBlob(im.url);
    closeLightbox();
    await editLoadBlob(blob, im.file);
    setMode('edit');
    toast('已载入为编辑底图', 'success');
  } catch (e) { toast(e.message || '载入失败', 'error'); }
});
$('#lbToMulti').addEventListener('click', async () => {
  if (!lb) return;
  const im = lb.entry.images[lb.idx];
  try {
    const blob = await fetchAssetBlob(im.url);
    closeLightbox();
    await multiAddBlob(blob, im.file);
    setMode('multi');
    toast('已加入参考图列表', 'success');
  } catch (e) { toast(e.message || '载入失败', 'error'); }
});
$('#lbCopy').addEventListener('click', async () => {
  if (!lb) return;
  const ok = await copyText(lb.entry.prompt || '');
  toast(ok ? '提示词已复制' : '复制失败', ok ? 'success' : 'error');
});

/* ============ 标注工具栏(编辑 / 多图共用逻辑) ============ */
function wireToolbar(scope, ann) {
  const tb = $(`#${scope}Toolbar`);
  const colors = $(`#${scope}Colors`);

  $$('.tool-btn', tb).forEach(b => b.addEventListener('click', () => pickTool(scope, b.dataset.tool)));
  $$('.swatch', colors).forEach(s => s.addEventListener('click', () => {
    $$('.swatch', colors).forEach(x => x.classList.toggle('active', x === s));
    if (s.dataset.color) ann.color = s.dataset.color;
  }));
  $(`#${scope}CustomColor`).addEventListener('input', e => {
    $$('.swatch', colors).forEach(x => x.classList.remove('active'));
    e.target.closest('.swatch').classList.add('active');
    ann.color = e.target.value;
  });
  const w = $(`#${scope}Width`), wv = $(`#${scope}WidthV`);
  w.addEventListener('input', () => { ann.width = +w.value; wv.value = w.value; paintRange(w); });
  $(`#${scope}Font`).addEventListener('change', e => { ann.fontSize = +e.target.value; });
  $(`#${scope}Undo`).addEventListener('click', () => ann.undo());
  $(`#${scope}Redo`).addEventListener('click', () => ann.redo());
  $(`#${scope}Clear`).addEventListener('click', () => ann.clear());
  const showBtn = $(`#${scope}Show`);
  showBtn.addEventListener('click', () => {
    const on = ann.toggleShow();
    showBtn.querySelector('use').setAttribute('href', on ? '#i-eye' : '#i-eye-off');
  });
}

function pickTool(scope, tool) {
  const tb = $(`#${scope}Toolbar`);
  $$('.tool-btn', tb).forEach(x => x.classList.toggle('active', x.dataset.tool === tool));
  const ann = scope === 'edit' ? editAnn : multiAnn;
  ann.setTool(tool);
}

function updateAnnUI(scope, s) {
  $(`#${scope}Undo`).disabled = !s.canUndo;
  $(`#${scope}Redo`).disabled = !s.canRedo;
  $(`#${scope}Clear`).disabled = !s.annotated;
  const badge = $(`#${scope}AnnBadge`);
  badge.textContent = `标注 ${s.count}`;
  badge.classList.toggle('on', s.annotated);
  if (scope === 'multi') renderMultiList();
}

const editAnn = new Annotator($('#editCanvasWrap'), { onChange: s => updateAnnUI('edit', s) });
const multiAnn = new Annotator($('#multiCanvasWrap'), { onChange: s => updateAnnUI('multi', s) });
wireToolbar('edit', editAnn);
wireToolbar('multi', multiAnn);

/* ============ 模式二:图片编辑 ============ */
async function editLoadBlob(blob, name = 'image.png') {
  await editAnn.load(blob);
  state.edit.file = { name };
  $('#editFileName').textContent = name;
  $('#editFileDims').textContent = `${editAnn.img.naturalWidth} × ${editAnn.img.naturalHeight}`;
  editSize.refresh();
  $('#editEmpty').hidden = true;
  $('#editStageBody').hidden = false;
  $('#editFileChip').hidden = false;
  $('#editPick').style.display = 'none';
  $('#editResultCard').hidden = true;
}

async function editLoadFiles(files) {
  const f = files[0];
  if (!f) return;
  try {
    if (editAnn.ready) toast('已替换为新图片', 'info');
    await editLoadBlob(f, f.name || 'image.png');
  } catch (e) {
    toast(e.message || '图片载入失败', 'error');
  }
}

function editUnload() {
  editAnn.unload();
  state.edit.file = null;
  $('#editEmpty').hidden = false;
  $('#editStageBody').hidden = true;
  $('#editFileChip').hidden = true;
  $('#editPick').style.display = '';
}

$('#editPick').addEventListener('click', () => $('#editFile').click());
$('#editPick2').addEventListener('click', () => $('#editFile').click());
$('#editReplaceBtn').addEventListener('click', () => $('#editFile').click());
$('#editRemoveBtn').addEventListener('click', editUnload);
$('#editFile').addEventListener('change', e => {
  editLoadFiles([...e.target.files]);
  e.target.value = '';
});

$('#editGen').addEventListener('click', async () => {
  if (!editAnn.ready) return toast('请先载入图片', 'error');
  const prompt = $('#editPrompt').value.trim();
  if (!prompt) return toast('请输入编辑指令', 'error');
  const steps = +$('#editSteps').value;
  const { w, h } = editSize.compute();
  const form = new FormData();
  const blob = await editAnn.exportBlob();
  const base = (state.edit.file?.name || 'image').replace(/\.[^.]+$/, '');
  form.append('image', blob, editAnn.annotated ? `${base}-标注.png` : (state.edit.file?.name || 'image.png'));
  form.append('prompt', prompt);
  form.append('steps', steps);
  form.append('width', w);
  form.append('height', h);
  runJob('edit', { prompt, params: { steps, width: w, height: h } }, signal => api.edit(form, signal));
});

/* ============ 模式三:多图生成 ============ */
async function multiAddBlob(blob, name = 'image.png') {
  if (state.multi.items.length >= 10) return toast('最多 10 张参考图', 'error');
  const { img } = await loadImageFromBlob(blob);
  state.multi.items.push({
    id: uid(), name, blob, url: img.src, img,
    w: img.naturalWidth, h: img.naturalHeight,
    annotations: [],
  });
  renderMultiList();
  selectMulti(state.multi.items.length - 1);
  multiSize.refresh();
}

async function multiAddFiles(files) {
  const imgs = files.filter(f => f.type.startsWith('image/'));
  if (!imgs.length) return;
  const room = 10 - state.multi.items.length;
  if (room <= 0) return toast('最多 10 张参考图', 'error');
  if (imgs.length > room) toast(`最多 10 张,已忽略多余的 ${imgs.length - room} 张`, 'info');
  for (const f of imgs.slice(0, room)) {
    try {
      await multiAddBlob(f, f.name || `图片-${state.multi.items.length + 1}.png`);
    } catch (e) {
      toast(`无法读取 ${f.name || '图片'}: ${e.message}`, 'error');
    }
  }
}

function renderMultiList() {
  const list = $('#multiList');
  const items = state.multi.items;
  $('#multiCount').textContent = `${items.length} / 10`;
  $('#multiEmpty').hidden = items.length > 0;
  $('#multiStageBody').hidden = items.length === 0;
  list.innerHTML = '';
  items.forEach((it, i) => {
    const el = document.createElement('div');
    el.className = 'multi-item' + (it === state.multi.selected ? ' sel' : '');
    el.title = '点击选中并在右侧标注';
    el.innerHTML = `
      <span class="mi-idx">${i + 1}</span>
      <img src="${it.url}" alt="">
      <div class="mi-meta"><b>${esc(it.name)}</b><i>${it.w}×${it.h}</i></div>
      ${it.annotations.length ? `<span class="mi-ann" title="含 ${it.annotations.length} 条标注"></span>` : ''}
      <button class="icon-btn" data-act="left" title="前移(影响参考顺序)"><svg class="icon"><use href="#i-chev-l"/></svg></button>
      <button class="icon-btn" data-act="right" title="后移"><svg class="icon"><use href="#i-chev-r"/></svg></button>
      <button class="icon-btn danger" data-act="del" title="移除"><svg class="icon"><use href="#i-x"/></svg></button>`;
    el.addEventListener('click', e => {
      const actBtn = e.target.closest('[data-act]');
      if (actBtn) {
        e.stopPropagation();
        const act = actBtn.dataset.act;
        if (act === 'left' && i > 0) {
          [items[i - 1], items[i]] = [items[i], items[i - 1]];
          renderMultiList();
        } else if (act === 'right' && i < items.length - 1) {
          [items[i], items[i + 1]] = [items[i + 1], items[i]];
          renderMultiList();
        } else if (act === 'del') {
          items.splice(i, 1);
          if (state.multi.selected === it) {
            state.multi.selected = null;
            const next = items[Math.min(i, items.length - 1)];
            if (next) selectMulti(items.indexOf(next));
            else { renderMultiList(); }
          } else {
            renderMultiList();
          }
        }
        return;
      }
      selectMulti(i);
    });
    list.appendChild(el);
  });
}

async function selectMulti(i) {
  const it = state.multi.items[i];
  if (!it) return;
  state.multi.selected = it;
  $('#multiCurFile').textContent = `${i + 1}. ${it.name}`;
  renderMultiList();
  try {
    await multiAnn.load(it.blob, { annotations: it.annotations });
  } catch (e) {
    toast(e.message || '图片载入失败', 'error');
  }
}

$('#multiPick').addEventListener('click', () => $('#multiFile').click());
$('#multiPick2').addEventListener('click', () => $('#multiFile').click());
$('#multiFile').addEventListener('change', e => {
  multiAddFiles([...e.target.files]);
  e.target.value = '';
});

$('#multiGen').addEventListener('click', async () => {
  const items = state.multi.items;
  if (!items.length) return toast('请先添加参考图片', 'error');
  const prompt = $('#multiPrompt').value.trim();
  if (!prompt) return toast('请输入生成指令', 'error');
  const steps = +$('#multiSteps').value;
  const { w, h } = multiSize.compute();
  const params = { steps, images: items.length, width: w, height: h };
  const form = new FormData();
  for (const it of items) {
    const blob = await flatten(it.blob, it.img, it.annotations);
    const base = (it.name || 'image').replace(/\.[^.]+$/, '');
    form.append('image', blob, it.annotations.length ? `${base}-标注.png` : it.name);
  }
  form.append('prompt', prompt);
  form.append('steps', steps);
  form.append('width', w);
  form.append('height', h);
  runJob('multi', { prompt, params }, signal => api.edit(form, signal));
});

/* ============ 模式一:文生图 ============ */
function collectT2i() {
  const prompt = $('#t2iPrompt').value.trim();
  if (!prompt) err('请输入提示词', '#t2iPrompt');
  const { w, h } = t2iSize.compute();
  const params = {
    prompt, width: w, height: h,
    steps: +$('#t2iSteps').value,
    n: +$('#t2iN').value || 1,
    response_format: 'url',
  };
  const seed = $('#t2iSeed').value.trim();
  if (seed !== '') {
    const s = parseInt(seed, 10);
    if (!Number.isFinite(s) || s < 0) err('种子需为非负整数', '#t2iSeed');
    params.seed = s;
  }
  const neg = $('#t2iNeg').value.trim();
  if (neg) {
    params.negative_prompt = neg;
    params.cfg = +$('#t2iCfg').value;
  }
  if ($('#t2iAlpha').checked) params.transparent = true;
  return params;
}

$('#t2iGen').addEventListener('click', () => {
  let params;
  try { params = collectT2i(); } catch (e) {
    toast(e.message, 'error');
    if (e.field) $(e.field)?.focus();
    return;
  }
  const { prompt, ...rest } = params;
  runJob('t2i', { prompt, params: rest }, signal => api.generate(params, signal));
});

$('#t2iSeedRandom').addEventListener('click', () => { $('#t2iSeed').value = randSeed(); });

/* ============ 模式一:文生图 ============ */
/* ============ 尺寸选择:比例 × 分辨率(1K/2K)/自定义(≤2048) ============ */
const BUDGETS = { '1k': 1024 ** 2, '2k': 2048 ** 2 };

function snapCustomDim(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 1024;
  return snap32(clamp(n, 256, 2048));
}

/** 在总像素预算内求比例尺寸,对齐 32 倍数 */
function dimsForRatio(rw, rh, budget) {
  return {
    w: snap32(clamp(Math.sqrt(budget * rw / rh), 256, 2752)),
    h: snap32(clamp(Math.sqrt(budget * rh / rw), 256, 2752)),
  };
}

function wireSizeCtl(scope, getRefDims) {
  const ratioSeg = $(`#${scope}Ratio`);
  const resSeg = $(`#${scope}ResK`);
  const customRow = $(`#${scope}Custom`);
  const cw = $(`#${scope}CW`), ch = $(`#${scope}CH`);
  const note = $(`#${scope}SizeNote`);
  const sel = {
    ratio: ratioSeg.querySelector('.active')?.dataset.r ?? '1:1',
    res: resSeg.querySelector('.active')?.dataset.k ?? '1k',
  };

  function compute() {
    if (sel.res === 'custom') return { w: snapCustomDim(cw.value), h: snapCustomDim(ch.value) };
    const budget = BUDGETS[sel.res];
    if (sel.ratio === 'auto') {
      const ref = getRefDims ? getRefDims() : null;
      return ref ? dimsForRatio(ref[0], ref[1], budget) : { w: 1024, h: 1024 };
    }
    const [rw, rh] = sel.ratio.split(':').map(Number);
    return dimsForRatio(rw, rh, budget);
  }

  function refresh() {
    const d = compute();
    note.textContent = `输出 ${d.w} × ${d.h}`;
    customRow.hidden = sel.res !== 'custom';
    if (sel.res === 'custom') { cw.value = d.w; ch.value = d.h; }
  }

  $$('button', ratioSeg).forEach(b => b.addEventListener('click', () => {
    sel.ratio = b.dataset.r;
    $$('button', ratioSeg).forEach(x => x.classList.toggle('active', x === b));
    refresh();
  }));
  $$('button', resSeg).forEach(b => b.addEventListener('click', () => {
    sel.res = b.dataset.k;
    $$('button', resSeg).forEach(x => x.classList.toggle('active', x === b));
    refresh();
  }));
  [cw, ch].forEach(inp => inp.addEventListener('change', refresh));
  const swap = $(`#${scope}Swap`);
  if (swap) swap.addEventListener('click', () => {
    [cw.value, ch.value] = [ch.value, cw.value];
    refresh();
  });
  refresh();
  return { compute, refresh };
}

const t2iSize = wireSizeCtl('t2i', null);
const editSize = wireSizeCtl('edit',
  () => editAnn.ready ? [editAnn.img.naturalWidth, editAnn.img.naturalHeight] : null);
const multiSize = wireSizeCtl('multi', () => {
  const it = state.multi.items[state.multi.items.length - 1];
  return it ? [it.w, it.h] : null;
});

function syncNSeg() {
  const n = $('#t2iN').value || '1';
  $$('#t2iNSeg button').forEach(b => b.classList.toggle('active', b.dataset.n === n));
}
$$('#t2iNSeg button').forEach(b => b.addEventListener('click', () => {
  $('#t2iN').value = b.dataset.n;
  syncNSeg();
}));

/* ============ 拖放 / 粘贴 ============ */
['dragover', 'drop'].forEach(ev => window.addEventListener(ev, e => e.preventDefault()));

function wireDrop(el, handler) {
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('dragover'); });
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('dragover');
    const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) handler(files);
  });
}
wireDrop($('#stage-edit'), editLoadFiles);
wireDrop($('#stage-multi'), multiAddFiles);
wireDrop($('#editPick'), editLoadFiles);
wireDrop($('#multiPick'), multiAddFiles);

document.addEventListener('paste', e => {
  const t = e.target;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
  const items = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/'));
  if (!items.length) return;
  e.preventDefault();
  const files = items.map(i => i.getAsFile()).filter(Boolean);
  if (!files.length) return;
  if (state.mode === 'edit') editLoadFiles(files);
  else if (state.mode === 'multi') multiAddFiles(files);
});

/* ============ 键盘快捷键 ============ */
document.addEventListener('keydown', e => {
  const t = e.target;
  const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;

  if (!$('#lightbox').hidden && lb) {
    if (e.key === 'ArrowLeft' && lb.idx > 0) { lb.idx--; renderLightbox(); }
    else if (e.key === 'ArrowRight' && lb.idx < lb.entry.images.length - 1) { lb.idx++; renderLightbox(); }
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    const ann = state.mode === 'edit' ? editAnn : state.mode === 'multi' ? multiAnn : null;
    if (ann && !typing) {
      e.preventDefault();
      if (e.shiftKey) ann.redo(); else ann.undo();
    }
    return;
  }

  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === 'Escape') {
    $('#settingsOverlay').hidden = true;
    return;
  }
  if (e.key === '1' || e.key === '2' || e.key === '3') {
    setMode(['t2i', 'edit', 'multi'][+e.key - 1]);
    return;
  }
  if (state.mode !== 't2i') {
    const map = { b: 'brush', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', t: 'text', e: 'eraser' };
    const tool = map[e.key.toLowerCase()];
    if (tool) pickTool(state.mode, tool);
  }
});

/* ============ 表单状态持久化 ============ */
function wirePersist(key) {
  const root = $(`#mode-${key}`);
  if (!root) return;
  const fields = $$('input[id], textarea[id], select[id]', root).filter(f => f.type !== 'file');
  const save = () => {
    const o = {};
    fields.forEach(f => { o[f.id] = f.type === 'checkbox' ? f.checked : f.value; });
    try { localStorage.setItem(`ncp-form-${key}`, JSON.stringify(o)); } catch { /* 忽略 */ }
  };
  root.addEventListener('input', save);
  root.addEventListener('change', save);
  try {
    const o = JSON.parse(localStorage.getItem(`ncp-form-${key}`) || '{}');
    fields.forEach(f => {
      const v = o[f.id];
      if (v === undefined) return;
      if (f.type === 'checkbox') f.checked = v;
      else f.value = v;
    });
  } catch { /* 忽略 */ }
}
['t2i', 'edit', 'multi'].forEach(wirePersist);

/* ============ 滑杆填充与数值显示 ============ */
function wireRange(id, outId, decimals = 0) {
  const r = $(id), o = outId ? $(outId) : null;
  const upd = () => {
    paintRange(r);
    if (o) o.value = (+r.value).toFixed(decimals).replace(/\.0+$/, '');
  };
  r.addEventListener('input', upd);
  upd();
}
wireRange('#t2iSteps', '#t2iStepsV');
wireRange('#t2iCfg', '#t2iCfgV', 1);
wireRange('#editSteps', '#editStepsV');
wireRange('#multiSteps', '#multiStepsV');
wireRange('#editWidth', '#editWidthV');
wireRange('#multiWidth', '#multiWidthV');

/* ============ 收尾 ============ */
window.addEventListener('beforeunload', e => {
  if (state.job) { e.preventDefault(); e.returnValue = ''; }
});

syncNSeg();
renderHistory();
renderMultiList();
pollHealth();
setInterval(pollHealth, 8000);
