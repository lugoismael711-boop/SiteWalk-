/* ============================================================
   map.js — 2D floor-plan view
   ------------------------------------------------------------
   Top-down map of scene positions. Optional floor-plan image
   as a background. Pan/zoom, drag dots to reposition, tap a dot
   to open that scene, tap empty space to place the selected shot.
   Scene positions (scene.map = {x,y}) are stored in normalized
   0..1 coordinates so they survive any canvas size / image swap.
   ============================================================ */

export class FloorMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scenes = [];
    this.floorImage = null;   // HTMLImageElement or null
    this.selectedId = null;   // scene selected for placement / highlight

    // view transform
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;

    this.onOpenScene = null;   // (sceneId) =>
    this.onMoveScene = null;   // (sceneId, {x,y}) =>
    this.onPlaceScene = null;  // (sceneId, {x,y}) =>

    this._dragScene = null;
    this._panning = false;
    this._bind();
    window.addEventListener('resize', () => this.resize());
  }

  setData(scenes, floorImage, selectedId) {
    this.scenes = scenes || [];
    this.floorImage = floorImage || null;
    this.selectedId = selectedId || null;
    this.resize();
  }
  setSelected(id) { this.selectedId = id; this.draw(); }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = w; this._h = h;
    this.draw();
  }

  /* Map normalized (0..1) coords -> screen pixels. */
  _toScreen(nx, ny) {
    const base = this._contentRect();
    return {
      x: this.offsetX + (base.x + nx * base.w) * this.scale,
      y: this.offsetY + (base.y + ny * base.h) * this.scale,
    };
  }
  _toNorm(sx, sy) {
    const base = this._contentRect();
    return {
      x: ((sx - this.offsetX) / this.scale - base.x) / base.w,
      y: ((sy - this.offsetY) / this.scale - base.y) / base.h,
    };
  }
  /* The un-zoomed content rectangle (letterboxed floor image, or full canvas). */
  _contentRect() {
    const W = this._w || 1, H = this._h || 1;
    if (this.floorImage) {
      const ir = this.floorImage.width / this.floorImage.height;
      const cr = W / H;
      let w, h, x, y;
      if (ir > cr) { w = W; h = W / ir; x = 0; y = (H - h) / 2; }
      else { h = H; w = H * ir; y = 0; x = (W - w) / 2; }
      return { x, y, w, h };
    }
    return { x: 0, y: 0, w: W, h: H };
  }

  draw() {
    const ctx = this.ctx;
    if (!this._w) return;
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.fillStyle = '#0e1116';
    ctx.fillRect(0, 0, this._w, this._h);

    const rect = this._contentRect();
    // floor image
    if (this.floorImage) {
      const p = this._toScreen(0, 0);
      ctx.drawImage(this.floorImage, p.x, p.y, rect.w * this.scale, rect.h * this.scale);
    } else {
      // grid backdrop
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      const step = 40 * this.scale;
      if (step > 8) {
        for (let x = (this.offsetX % step); x < this._w; x += step) {
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this._h); ctx.stroke();
        }
        for (let y = (this.offsetY % step); y < this._h; y += step) {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this._w, y); ctx.stroke();
        }
      }
    }

    // links between scenes (based on nav hotspots)
    ctx.strokeStyle = 'rgba(59,130,246,0.5)';
    ctx.lineWidth = 2;
    const byId = {};
    this.scenes.forEach((s) => { byId[s.id] = s; });
    this.scenes.forEach((s) => {
      if (!s.map) return;
      (s.hotspots || []).forEach((h) => {
        if (h.type !== 'nav' || !h.targetSceneId) return;
        const t = byId[h.targetSceneId];
        if (!t || !t.map) return;
        const a = this._toScreen(s.map.x, s.map.y);
        const b = this._toScreen(t.map.x, t.map.y);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      });
    });

    // scene dots
    this.scenes.forEach((s, i) => {
      if (!s.map) return;
      const p = this._toScreen(s.map.x, s.map.y);
      const isSel = s.id === this.selectedId;
      ctx.beginPath();
      ctx.arc(p.x, p.y, isSel ? 13 : 10, 0, Math.PI * 2);
      ctx.fillStyle = isSel ? '#22c55e' : '#3b82f6';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      // number label
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.x, p.y);
    });

    // unplaced hint
    const unplaced = this.scenes.filter((s) => !s.map).length;
    if (unplaced) {
      ctx.fillStyle = 'rgba(230,237,243,0.7)';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`${unplaced} shot(s) not placed — select one in "Shots", then tap the map`, 10, 10);
    }
  }

  _hitTest(sx, sy) {
    for (let i = this.scenes.length - 1; i >= 0; i--) {
      const s = this.scenes[i];
      if (!s.map) continue;
      const p = this._toScreen(s.map.x, s.map.y);
      if (Math.hypot(p.x - sx, p.y - sy) < 18) return s;
    }
    return null;
  }

  _bind() {
    const el = this.canvas;
    let lastX = 0, lastY = 0, moved = 0, downT = 0;
    let pinch = 0;

    const rectPos = (clientX, clientY) => {
      const r = el.getBoundingClientRect();
      return { x: clientX - r.left, y: clientY - r.top };
    };

    const start = (sx, sy) => {
      moved = 0; downT = Date.now();
      lastX = sx; lastY = sy;
      const hit = this._hitTest(sx, sy);
      if (hit) { this._dragScene = hit; this._panning = false; }
      else { this._dragScene = null; this._panning = true; }
    };
    const move = (sx, sy) => {
      const dx = sx - lastX, dy = sy - lastY;
      lastX = sx; lastY = sy;
      moved += Math.abs(dx) + Math.abs(dy);
      if (this._dragScene) {
        const n = this._toNorm(sx, sy);
        this._dragScene.map = { x: Math.max(0, Math.min(1, n.x)), y: Math.max(0, Math.min(1, n.y)) };
        this.draw();
      } else if (this._panning) {
        this.offsetX += dx; this.offsetY += dy;
        this.draw();
      }
    };
    const end = (sx, sy) => {
      const isTap = moved < 8 && Date.now() - downT < 400;
      if (this._dragScene) {
        if (isTap) {
          if (this.onOpenScene) this.onOpenScene(this._dragScene.id);
        } else if (this.onMoveScene) {
          this.onMoveScene(this._dragScene.id, this._dragScene.map);
        }
      } else if (isTap && this.selectedId && this.onPlaceScene) {
        const n = this._toNorm(sx, sy);
        if (n.x >= 0 && n.x <= 1 && n.y >= 0 && n.y <= 1) {
          this.onPlaceScene(this.selectedId, { x: n.x, y: n.y });
        }
      }
      this._dragScene = null; this._panning = false;
    };

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      el.setPointerCapture(e.pointerId);
      const p = rectPos(e.clientX, e.clientY); start(p.x, p.y);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' || (!this._dragScene && !this._panning)) return;
      const p = rectPos(e.clientX, e.clientY); move(p.x, p.y);
    });
    el.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') return;
      const p = rectPos(e.clientX, e.clientY); end(p.x, p.y);
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._zoomAt(rectPos(e.clientX, e.clientY), Math.sign(e.deltaY) < 0 ? 1.1 : 0.9);
    }, { passive: false });

    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) { const p = rectPos(e.touches[0].clientX, e.touches[0].clientY); start(p.x, p.y); }
      else if (e.touches.length === 2) { this._dragScene = null; this._panning = false; pinch = this._tDist(e.touches); }
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 1) { const p = rectPos(e.touches[0].clientX, e.touches[0].clientY); move(p.x, p.y); }
      else if (e.touches.length === 2) {
        const d = this._tDist(e.touches);
        const mid = this._tMid(e.touches, el);
        if (pinch) this._zoomAt(mid, d / pinch);
        pinch = d;
      }
    }, { passive: false });
    el.addEventListener('touchend', (e) => {
      if (e.touches.length === 0 && e.changedTouches.length) {
        const p = rectPos(e.changedTouches[0].clientX, e.changedTouches[0].clientY); end(p.x, p.y);
      }
      if (e.touches.length < 2) pinch = 0;
    });
  }

  _zoomAt(pt, factor) {
    const newScale = Math.max(0.4, Math.min(6, this.scale * factor));
    const k = newScale / this.scale;
    // keep point under cursor stable
    this.offsetX = pt.x - (pt.x - this.offsetX) * k;
    this.offsetY = pt.y - (pt.y - this.offsetY) * k;
    this.scale = newScale;
    this.draw();
  }
  _tDist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
  _tMid(t, el) {
    const r = el.getBoundingClientRect();
    return { x: (t[0].clientX + t[1].clientX) / 2 - r.left, y: (t[0].clientY + t[1].clientY) / 2 - r.top };
  }
}
