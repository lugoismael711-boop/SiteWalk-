/* ============================================================
   viewer.js — WebGL equirectangular panorama viewer
   ------------------------------------------------------------
   • Renders a 360° photo on the inside of a sphere
   • Drag / pinch / wheel to look around and zoom
   • Optional device-orientation ("gyro") look control
   • Hotspots:
       - nav     : a flat arrow/chevron on the FLOOR (a path marker)
       - note    : a colored pin (color = priority)
       - measure : a line between two points with a distance label
   • Place modes return positions to the app:
       - 'nav' / 'note'  -> one tap  -> onPlace(mode,{yaw,pitch})
       - 'measure'       -> two taps -> onPlace('measure',{a,b})
   • Aim mode: no placing; app reads getLook() to store a landing view
   ============================================================ */

import * as THREE from 'three';

const SPHERE_R = 500;
const HOTSPOT_R = 460;
const FLOOR_R = 430;
const MIN_FOV = 30;
const MAX_FOV = 90;
const FLOOR_PITCH = -0.62; // arrows sit on the floor (~ -35°) unless tapped lower

export const PRIORITY_COLORS = {
  high:   '#ef4444',
  medium: '#f59e0b',
  low:    '#22c55e',
};

function dirFromYawPitch(yaw, pitch) {
  return new THREE.Vector3(
    Math.cos(pitch) * Math.sin(yaw),
    Math.sin(pitch),
    Math.cos(pitch) * Math.cos(yaw)
  );
}

export class PanoramaViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1100);
    this.camera.position.set(0, 0, 0);

    this.yaw = 0; this.pitch = 0; this.fov = 70;

    const geo = new THREE.SphereGeometry(SPHERE_R, 64, 40);
    geo.scale(-1, 1, 1);
    this.sphereMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
    this.sphere = new THREE.Mesh(geo, this.sphereMat);
    this.scene.add(this.sphere);

    this.currentTexture = null;
    this.hotspotGroup = new THREE.Group();
    this.scene.add(this.hotspotGroup);
    this.hotspots = [];       // { obj, data } — objects that respond to taps
    this._decor = [];         // non-interactive lines/dots to dispose

    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line = { threshold: 6 };
    this.placeMode = null;    // 'nav' | 'note' | 'measure' | null
    this._measureFirst = null;

    this.onHotspotActivate = null;
    this.onHotspotMenu = null;   // long-press on a hotspot
    this.onPlace = null;
    this.onMeasureFirstPoint = null;
    this._lpTimer = null;
    this._lpFired = false;

    this._gyroEnabled = false;
    this._gyroQuat = new THREE.Quaternion();

    this._bindInput();
    this._resize();
    this._running = false;
    window.addEventListener('resize', () => this._resize());
  }

  /* -------------------- lifecycle -------------------- */
  start() {
    if (this._running) return;
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      this._update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }
  stop() { this._running = false; if (this._raf) cancelAnimationFrame(this._raf); }

  _resize() {
    const w = this.canvas.clientWidth || this.canvas.parentElement.clientWidth;
    const h = this.canvas.clientHeight || this.canvas.parentElement.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* -------------------- load a panorama -------------------- */
  async loadPanorama(blob, { initYaw = 0, initPitch = 0 } = {}) {
    const url = URL.createObjectURL(blob);
    const texture = await new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(url, resolve, undefined, reject);
    });
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;

    if (this.currentTexture) this.currentTexture.dispose();
    if (this._lastUrl) URL.revokeObjectURL(this._lastUrl);
    this._lastUrl = url;
    this.currentTexture = texture;

    this.sphere.material = new THREE.MeshBasicMaterial({ map: texture });
    if (this.sphereMat) this.sphereMat.dispose();
    this.sphereMat = this.sphere.material;

    this.yaw = initYaw; this.pitch = initPitch;
    this._resize();
  }

  setView(yaw, pitch) { this.yaw = yaw; this.pitch = pitch; }

  /* -------------------- hotspots -------------------- */
  clearHotspots() {
    this.hotspots.forEach((h) => this._disposeObj(h.obj));
    this.hotspots = [];
    this._decor.forEach((o) => this._disposeObj(o));
    this._decor = [];
    this._clearMeasureTemp();
  }
  _disposeObj(obj) {
    this.hotspotGroup.remove(obj);
    if (obj.material) {
      if (obj.material.map) obj.material.map.dispose();
      obj.material.dispose();
    }
    if (obj.geometry) obj.geometry.dispose();
  }

  setHotspots(list) {
    this.clearHotspots();
    (list || []).forEach((data) => {
      if (data.type === 'nav') this._addNav(data);
      else if (data.type === 'note') this._addNote(data);
      else if (data.type === 'measure') this._addMeasure(data);
    });
  }

  /* nav = flat chevron on the floor pointing along the walk direction */
  _addNav(data) {
    const tex = this._navTexture();
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    const size = 96;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    // Keep the marker where the user tapped; the flat orientation makes it
    // read as a path on the ground. (Tap the floor for the best look.)
    const pitch = data.pitch;
    plane.position.copy(dirFromYawPitch(data.yaw, pitch).multiplyScalar(FLOOR_R));
    // lie flat on the ground and rotate the chevron to face outward along yaw
    plane.rotation.order = 'YXZ';
    plane.rotation.y = data.yaw;
    plane.rotation.x = -Math.PI / 2;
    plane.userData = data;
    this.hotspotGroup.add(plane);
    this.hotspots.push({ obj: plane, data });
  }

  _navTexture() {
    const s = 256;
    const c = document.createElement('canvas'); c.width = c.height = s;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, s, s);
    // soft ring
    ctx.beginPath(); ctx.arc(s/2, s/2, s*0.42, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(59,130,246,0.35)'; ctx.fill();
    ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke();
    // double chevron pointing "up" in texture (=> outward along yaw)
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 22; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let i = 0; i < 2; i++) {
      const off = i * 46;
      ctx.beginPath();
      ctx.moveTo(s*0.30, s*0.60 - off);
      ctx.lineTo(s*0.50, s*0.40 - off);
      ctx.lineTo(s*0.70, s*0.60 - off);
      ctx.stroke();
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /* note = billboarded colored pin */
  _addNote(data) {
    const color = PRIORITY_COLORS[data.priority] || PRIORITY_COLORS.low;
    const tex = this._pinTexture(color);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(38, 38, 1);
    sprite.position.copy(dirFromYawPitch(data.yaw, data.pitch).multiplyScalar(HOTSPOT_R));
    sprite.userData = data;
    this.hotspotGroup.add(sprite);
    this.hotspots.push({ obj: sprite, data });
  }

  _pinTexture(color) {
    const s = 128;
    const c = document.createElement('canvas'); c.width = c.height = s;
    const ctx = c.getContext('2d');
    ctx.beginPath(); ctx.arc(s/2, s/2, s/2 - 8, 0, Math.PI*2);
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 66px sans-serif';
    ctx.fillText('!', s/2, s/2 + 4);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /* measure = endpoints + line + label at midpoint */
  _addMeasure(data) {
    const pa = dirFromYawPitch(data.a.yaw, data.a.pitch).multiplyScalar(HOTSPOT_R);
    const pb = dirFromYawPitch(data.b.yaw, data.b.pitch).multiplyScalar(HOTSPOT_R);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([pa, pb]);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x67e8f9, depthTest: false, transparent: true }));
    line.renderOrder = 2;
    this.hotspotGroup.add(line); this._decor.push(line);
    // endpoints
    [pa, pb].forEach((p) => {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(4, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0x67e8f9, depthTest: false }));
      dot.position.copy(p); this.hotspotGroup.add(dot); this._decor.push(dot);
    });
    // label
    const mid = pa.clone().add(pb).multiplyScalar(0.5).setLength(HOTSPOT_R - 6);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._labelTexture(data.label ? `${data.value} · ${data.label}` : String(data.value)),
      depthTest: false, depthWrite: false, transparent: true,
    }));
    const w = 90;
    label.scale.set(w, w * 0.34, 1);
    label.position.copy(mid);
    label.userData = data;
    this.hotspotGroup.add(label);
    this.hotspots.push({ obj: label, data });
  }

  _labelTexture(text) {
    const pad = 24, h = 96;
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = 'bold 46px sans-serif';
    const w = Math.max(160, measure.measureText(text).width + pad * 2);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(8,12,18,0.85)';
    roundRect(ctx, 2, 2, w - 4, h - 4, 20); ctx.fill();
    ctx.strokeStyle = '#67e8f9'; ctx.lineWidth = 4; roundRect(ctx, 2, 2, w - 4, h - 4, 20); ctx.stroke();
    ctx.fillStyle = '#e6faff'; ctx.font = 'bold 46px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 2);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    t._w = w; t._h = h;
    return t;
  }

  /* -------------------- place mode -------------------- */
  setPlaceMode(mode) {
    this.placeMode = mode;
    this._measureFirst = null;
    this._clearMeasureTemp();
  }
  _clearMeasureTemp() {
    if (this._measureTemp) { this._disposeObj(this._measureTemp); this._measureTemp = null; }
  }

  /* -------------------- input -------------------- */
  _bindInput() {
    const el = this.canvas;
    let dragging = false, lastX = 0, lastY = 0, moved = 0, pinchDist = 0, downTime = 0;
    const sens = () => (this.fov / 70) * 0.0025;

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      dragging = true; moved = 0; downTime = Date.now();
      lastX = e.clientX; lastY = e.clientY;
      this._startLongPress(e.clientX, e.clientY);
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerType === 'touch') return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 8) this._cancelLongPress();
      const s = sens(); this.yaw -= dx * s; this.pitch += dy * s; this._clampPitch();
    });
    el.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') return;
      dragging = false; this._cancelLongPress();
      if (this._lpFired) { this._lpFired = false; return; }
      if (moved < 6 && Date.now() - downTime < 400) this._handleTap(e.clientX, e.clientY);
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.fov = Math.min(MAX_FOV, Math.max(MIN_FOV, this.fov + Math.sign(e.deltaY) * 3));
      this.camera.fov = this.fov; this.camera.updateProjectionMatrix();
    }, { passive: false });

    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        dragging = true; moved = 0; downTime = Date.now();
        lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
        this._startLongPress(lastX, lastY);
      } else if (e.touches.length === 2) { dragging = false; this._cancelLongPress(); pinchDist = this._tDist(e.touches); }
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 1 && dragging) {
        const t = e.touches[0];
        const dx = t.clientX - lastX, dy = t.clientY - lastY;
        lastX = t.clientX; lastY = t.clientY; moved += Math.abs(dx) + Math.abs(dy);
        if (moved > 8) this._cancelLongPress();
        const s = sens(); this.yaw -= dx * s; this.pitch += dy * s; this._clampPitch();
      } else if (e.touches.length === 2) {
        const d = this._tDist(e.touches);
        if (pinchDist) {
          this.fov = Math.min(MAX_FOV, Math.max(MIN_FOV, this.fov + (pinchDist - d) * 0.12));
          this.camera.fov = this.fov; this.camera.updateProjectionMatrix();
        }
        pinchDist = d;
      }
    }, { passive: false });
    el.addEventListener('touchend', (e) => {
      this._cancelLongPress();
      if (this._lpFired) { this._lpFired = false; dragging = false; if (e.touches.length < 2) pinchDist = 0; return; }
      if (dragging && moved < 10 && Date.now() - downTime < 400 && e.changedTouches.length) {
        this._handleTap(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      }
      dragging = false; if (e.touches.length < 2) pinchDist = 0;
    });
  }

  _startLongPress(x, y) {
    this._cancelLongPress();
    this._lpFired = false;
    this._lpTimer = setTimeout(() => {
      if (this.placeMode) return;
      const objs = this.hotspots.map((h) => h.obj);
      const d = this._tapDir(x, y);
      this.raycaster.setFromCamera(d.ndc, this.camera);
      const hits = this.raycaster.intersectObjects(objs, false);
      if (hits.length && this.onHotspotMenu) { this._lpFired = true; this.onHotspotMenu(hits[0].object.userData); }
    }, 500);
  }
  _cancelLongPress() { if (this._lpTimer) { clearTimeout(this._lpTimer); this._lpTimer = null; } }

  _tDist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
  _clampPitch() { const lim = Math.PI/2 - 0.05; this.pitch = Math.max(-lim, Math.min(lim, this.pitch)); }

  _tapDir(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const dir = this.raycaster.ray.direction.clone().normalize();
    return {
      yaw: Math.atan2(dir.x, dir.z),
      pitch: Math.asin(Math.max(-1, Math.min(1, dir.y))),
      ndc,
    };
  }

  _handleTap(clientX, clientY) {
    const d = this._tapDir(clientX, clientY);

    if (this.placeMode === 'measure') {
      if (!this._measureFirst) {
        this._measureFirst = { yaw: d.yaw, pitch: d.pitch };
        this._showMeasureTemp(this._measureFirst);
        if (this.onMeasureFirstPoint) this.onMeasureFirstPoint(this._measureFirst);
      } else {
        const a = this._measureFirst, b = { yaw: d.yaw, pitch: d.pitch };
        this._measureFirst = null; this._clearMeasureTemp();
        if (this.onPlace) this.onPlace('measure', { a, b });
      }
      return;
    }
    if (this.placeMode === 'nav' || this.placeMode === 'note') {
      if (this.onPlace) this.onPlace(this.placeMode, { yaw: d.yaw, pitch: d.pitch });
      return;
    }
    // not placing: hit-test hotspots
    const objs = this.hotspots.map((h) => h.obj);
    const hits = this.raycaster.intersectObjects(objs, false);
    if (hits.length && this.onHotspotActivate) this.onHotspotActivate(hits[0].object.userData);
  }

  _showMeasureTemp(pt) {
    this._clearMeasureTemp();
    const dot = new THREE.Mesh(new THREE.SphereGeometry(5, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x67e8f9, depthTest: false }));
    dot.position.copy(dirFromYawPitch(pt.yaw, pt.pitch).multiplyScalar(HOTSPOT_R));
    this.hotspotGroup.add(dot);
    this._measureTemp = dot;
  }

  /* -------------------- gyro -------------------- */
  async enableGyro() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') return false;
      }
    } catch (_) { return false; }
    this._onOrient = (e) => this._handleOrient(e);
    window.addEventListener('deviceorientation', this._onOrient, true);
    this._gyroEnabled = true;
    return true;
  }
  disableGyro() {
    this._gyroEnabled = false;
    if (this._onOrient) window.removeEventListener('deviceorientation', this._onOrient, true);
  }
  get gyroEnabled() { return this._gyroEnabled; }

  _handleOrient(e) {
    if (e.alpha == null) return;
    const d = Math.PI / 180;
    const alpha = e.alpha * d, beta = e.beta * d, gamma = e.gamma * d;
    const orient = ((screen.orientation && screen.orientation.angle) || 0) * d;
    const zee = new THREE.Vector3(0, 0, 1);
    const euler = new THREE.Euler();
    const q0 = new THREE.Quaternion();
    const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
    euler.set(beta, alpha, -gamma, 'YXZ');
    this._gyroQuat.setFromEuler(euler);
    this._gyroQuat.multiply(q1);
    this._gyroQuat.multiply(q0.setFromAxisAngle(zee, -orient));
  }

  _update() {
    if (this._gyroEnabled) this.camera.quaternion.copy(this._gyroQuat);
    else this.camera.lookAt(dirFromYawPitch(this.yaw, this.pitch));
  }

  getLook() { return { yaw: this.yaw, pitch: this.pitch }; }

  dispose() {
    this.stop(); this.disableGyro();
    if (this.currentTexture) this.currentTexture.dispose();
    this.renderer.dispose();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
