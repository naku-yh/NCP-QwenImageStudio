/* Canvas 标注引擎
   - 标注以图片原始像素坐标存储,导出时按原分辨率合成
   - annotations 数组可与外部数组共享引用(多图模式),所有修改均为原地操作
*/

const FONT_STACK = '-apple-system, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif';

export function drawAnnotation(ctx, a) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = a.width;

  if (a.type === 'brush') {
    const pts = a.points;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, a.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      const lp = pts[pts.length - 1];
      ctx.lineTo(lp.x, lp.y);
      ctx.stroke();
    }
  } else if (a.type === 'line') {
    ctx.beginPath();
    ctx.moveTo(a.x1, a.y1);
    ctx.lineTo(a.x2, a.y2);
    ctx.stroke();
  } else if (a.type === 'arrow') {
    const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
    const head = Math.min(Math.max(a.width * 3.4, 14), 110);
    ctx.beginPath();
    ctx.moveTo(a.x1, a.y1);
    ctx.lineTo(a.x2, a.y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(a.x2 - head * Math.cos(ang - 0.42), a.y2 - head * Math.sin(ang - 0.42));
    ctx.lineTo(a.x2, a.y2);
    ctx.lineTo(a.x2 - head * Math.cos(ang + 0.42), a.y2 - head * Math.sin(ang + 0.42));
    ctx.stroke();
  } else if (a.type === 'rect') {
    const x = Math.min(a.x1, a.x2), y = Math.min(a.y1, a.y2);
    ctx.strokeRect(x, y, Math.abs(a.x2 - a.x1), Math.abs(a.y2 - a.y1));
  } else if (a.type === 'ellipse') {
    const cx = (a.x1 + a.x2) / 2, cy = (a.y1 + a.y2) / 2;
    const rx = Math.abs(a.x2 - a.x1) / 2, ry = Math.abs(a.y2 - a.y1) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (a.type === 'text') {
    ctx.font = `600 ${a.size}px ${FONT_STACK}`;
    ctx.textBaseline = 'top';
    ctx.fillText(a.text, a.x, a.y);
  }
  ctx.restore();
}

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function measureTextWidth(a) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `600 ${a.size}px ${FONT_STACK}`;
  return ctx.measureText(a.text).width;
}

export function hitAnnotation(a, p, tol) {
  if (a.type === 'brush') {
    if (a.points.length === 1) {
      return Math.hypot(p.x - a.points[0].x, p.y - a.points[0].y) < a.width / 2 + tol;
    }
    for (let i = 0; i < a.points.length - 1; i++) {
      if (segDist(p, a.points[i], a.points[i + 1]) < a.width / 2 + tol) return true;
    }
    return false;
  }
  if (a.type === 'line' || a.type === 'arrow') {
    return segDist(p, { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }) < a.width / 2 + tol;
  }
  if (a.type === 'rect' || a.type === 'ellipse') {
    const x1 = Math.min(a.x1, a.x2) - tol, y1 = Math.min(a.y1, a.y2) - tol;
    const x2 = Math.max(a.x1, a.x2) + tol, y2 = Math.max(a.y1, a.y2) + tol;
    return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
  }
  if (a.type === 'text') {
    const w = measureTextWidth(a);
    return p.x >= a.x - tol && p.x <= a.x + w + tol
      && p.y >= a.y - tol && p.y <= a.y + a.size * 1.25 + tol;
  }
  return false;
}

/** 把图片 + 标注合成为原分辨率 PNG blob(无标注时返回原 blob) */
export async function flatten(blob, img, annotations) {
  if (!annotations || !annotations.length) return blob;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  for (const a of annotations) drawAnnotation(ctx, a);
  return new Promise(r => c.toBlob(r, 'image/png'));
}

export function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
    img.src = url;
  });
}

export class Annotator {
  constructor(wrapEl, opts = {}) {
    this.wrap = wrapEl;
    this.opts = { onChange: () => {}, ...opts };

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'annotator-canvas';
    this.textInput = document.createElement('input');
    this.textInput.type = 'text';
    this.textInput.className = 'ann-text-input';
    this.textInput.hidden = true;
    wrapEl.append(this.canvas, this.textInput);
    this.ctx = this.canvas.getContext('2d');

    this.img = null;
    this._blob = null;
    this._objUrl = '';
    this.annotations = [];
    this._undo = [];
    this._redo = [];
    this.draft = null;
    this.showAnn = true;

    this.tool = 'brush';
    this.color = '#ff3b30';
    this.width = 10;
    this.fontSize = 36;

    this._view = { scale: 1, cssW: 0, cssH: 0 };
    this._erasing = false;
    this._eraseSnap = null;
    this._textEditing = false;
    this._textPos = { x: 0, y: 0 };

    this._bindEvents();
    this._ro = new ResizeObserver(() => this.refit());
    this._ro.observe(wrapEl);
  }

  get ready() { return !!this.img; }
  get annotated() { return this.annotations.length > 0; }

  async load(blob, { annotations } = {}) {
    if (this._objUrl) URL.revokeObjectURL(this._objUrl);
    const { img, url } = await loadImageFromBlob(blob);
    this._objUrl = url;
    this.img = img;
    this._blob = blob;
    this.annotations = annotations || [];
    this._undo = [];
    this._redo = [];
    this.draft = null;
    this._textEditing = false;
    this.textInput.hidden = true;
    this.refit();
    this._emit();
  }

  /** 原地替换标注内容,保持外部引用有效 */
  _apply(list) {
    this.annotations.length = 0;
    this.annotations.push(...list);
  }

  _emit() {
    this.opts.onChange({
      hasImage: !!this.img,
      annotated: this.annotated,
      count: this.annotations.length,
      canUndo: this._undo.length > 0,
      canRedo: this._redo.length > 0,
    });
  }

  refit() {
    if (!this.img) return;
    const r = this.wrap.getBoundingClientRect();
    const availW = Math.max(80, r.width - 30);
    const availH = Math.max(80, r.height - 30);
    const s = Math.min(availW / this.img.naturalWidth, availH / this.img.naturalHeight);
    this._view = {
      scale: s,
      cssW: Math.max(1, Math.round(this.img.naturalWidth * s)),
      cssH: Math.max(1, Math.round(this.img.naturalHeight * s)),
    };
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${this._view.cssW}px`;
    this.canvas.style.height = `${this._view.cssH}px`;
    this.canvas.width = Math.round(this._view.cssW * dpr);
    this.canvas.height = Math.round(this._view.cssH * dpr);
    this.render();
    this._placeTextInput();
  }

  render() {
    if (!this.img) return;
    const ctx = this.ctx;
    const { scale } = this._view;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.clearRect(0, 0, this.img.naturalWidth, this.img.naturalHeight);
    ctx.drawImage(this.img, 0, 0);
    if (this.showAnn) {
      for (const a of this.annotations) drawAnnotation(ctx, a);
      if (this.draft) drawAnnotation(ctx, this.draft);
    }
  }

  setTool(tool) {
    this.tool = tool;
    this.canvas.classList.toggle('tool-text', tool === 'text');
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / this._view.scale,
      y: (e.clientY - r.top) / this._view.scale,
    };
  }

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => {
      if (!this.img || this._textEditing) return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const p = this._pos(e);
      if (this.tool === 'text') return this._beginText(p);
      if (this.tool === 'eraser') {
        this._erasing = true;
        this._eraseSnap = JSON.stringify(this.annotations);
        this._eraseAt(p);
        return;
      }
      const common = { color: this.color, width: this.width };
      if (this.tool === 'brush') this.draft = { ...common, type: 'brush', points: [p] };
      else this.draft = { ...common, type: this.tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    });

    c.addEventListener('pointermove', e => {
      if (!this.img) return;
      const p = this._pos(e);
      if (this._erasing) return this._eraseAt(p);
      if (!this.draft) return;
      if (this.draft.type === 'brush') {
        const pts = this.draft.points;
        const last = pts[pts.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) > 1.2) pts.push(p);
      } else {
        this.draft.x2 = p.x;
        this.draft.y2 = p.y;
      }
      this.render();
    });

    const finish = () => {
      if (this._erasing) {
        this._erasing = false;
        this._eraseSnap = null;
        this._emit();
        return;
      }
      if (!this.draft) return;
      const d = this.draft;
      this.draft = null;
      const moved = d.type === 'brush'
        ? d.points.length > 1
        : Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > 2;
      if (moved) {
        this._pushUndo();
        this.annotations.push(d);
      }
      this.render();
      this._emit();
    };
    c.addEventListener('pointerup', finish);
    c.addEventListener('pointercancel', finish);

    this.textInput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this._commitText();
      } else if (e.key === 'Escape') {
        this._cancelText();
      }
    });
    this.textInput.addEventListener('blur', () => this._commitText());
  }

  _eraseAt(p) {
    const tol = 8 / this._view.scale;
    let removed = false;
    for (let i = this.annotations.length - 1; i >= 0; i--) {
      if (hitAnnotation(this.annotations[i], p, tol)) {
        if (this._eraseSnap) {
          this._undo.push(this._eraseSnap);
          if (this._undo.length > 80) this._undo.shift();
          this._redo = [];
          this._eraseSnap = null;
        }
        this.annotations.splice(i, 1);
        removed = true;
      }
    }
    if (removed) {
      this.render();
      this._emit();
    }
  }

  _beginText(p) {
    this._textPos = p;
    this._textEditing = true;
    this.textInput.value = '';
    this.textInput.hidden = false;
    this._placeTextInput();
    requestAnimationFrame(() => this.textInput.focus());
  }

  _placeTextInput() {
    if (!this._textEditing || !this.img) return;
    const { scale } = this._view;
    this.textInput.style.left = `${this.canvas.offsetLeft + this._textPos.x * scale}px`;
    this.textInput.style.top = `${this.canvas.offsetTop + this._textPos.y * scale}px`;
    this.textInput.style.fontSize = `${Math.max(12, this.fontSize * scale)}px`;
  }

  _commitText() {
    if (!this._textEditing) return;
    const v = this.textInput.value.trim();
    this._textEditing = false;
    this.textInput.hidden = true;
    if (v && this.img) {
      this._pushUndo();
      this.annotations.push({
        type: 'text', x: this._textPos.x, y: this._textPos.y,
        text: v, color: this.color, size: this.fontSize,
      });
    }
    this.render();
    this._emit();
  }

  _cancelText() {
    this._textEditing = false;
    this.textInput.hidden = true;
  }

  _pushUndo() {
    this._undo.push(JSON.stringify(this.annotations));
    if (this._undo.length > 80) this._undo.shift();
    this._redo = [];
  }

  undo() {
    if (!this._undo.length) return;
    this._redo.push(JSON.stringify(this.annotations));
    this._apply(JSON.parse(this._undo.pop()));
    this.render();
    this._emit();
  }

  redo() {
    if (!this._redo.length) return;
    this._undo.push(JSON.stringify(this.annotations));
    this._apply(JSON.parse(this._redo.pop()));
    this.render();
    this._emit();
  }

  clear() {
    if (!this.annotations.length) return;
    this._pushUndo();
    this._apply([]);
    this.render();
    this._emit();
  }

  toggleShow() {
    this.showAnn = !this.showAnn;
    this.render();
    return this.showAnn;
  }

  async exportBlob() {
    if (!this.img) return null;
    return flatten(this._blob, this.img, this.annotations);
  }

  unload() {
    this.img = null;
    this._blob = null;
    this.annotations = [];
    this._undo = [];
    this._redo = [];
    this.draft = null;
    this._textEditing = false;
    this.textInput.hidden = true;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._emit();
  }
}
