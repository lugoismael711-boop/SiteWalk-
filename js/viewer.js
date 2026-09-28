/* ============================================================
   viewer.js — WebGL equirectangular panorama viewer
   ------------------------------------------------------------
   • Renders a 360° photo on the inside of a sphere
   • Drag / pinch / wheel to look around and zoom
   • Optional device-orientation ("gyro") look control
   • Navigation + note hotspots as billboarded sprites
   • Tap-to-place mode returns yaw/pitch for new hotspots
   ============================================================ */

import * as THREE from 'three';

const SPHERE_R = 500;
const HOTSPOT_R = 460;
const MIN_FOV = 30;
const MAX_FOV = 90;

// Convert yaw (rad, around Y) + pitch (rad) to a direction vector.
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

    // Look state (spherical, radians)
    this.yaw = 0;
    this.pitch = 0;
    this.fov = 70;

    // Sphere
    const geo = new THREE.SphereGeometry(SPHERE_R, 64, 40);
    geo.scale(-1, 1, 1); // render inside faces
    this.sphereMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
    this.sphere = new THREE.Mesh(geo, this.sphereMat);
    this.scene.add(this.sphere);

    this.currentTexture = null;
    this.hotspotGroup = new THREE.Group();
    this.scene.add(this.hotspotGroup);
    this.hotspots = []; // { mesh, data }

    this.raycaster = new THREE.Raycaster();
    this.placeMode = null; // 'nav' | 'note' | null

    // Callbacks (set by app)
    this.onHotspotActivate = null; // (data) => {}
    this.onPlace = null;           // (yaw, pitch) => {}

    this._gyroEnabled = false;
    this._gyroQuat = new THREE.Quaternion();
    this._screenOrient = 0;

    this._bindInput();
    this._resize();
    this._raf = null;
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
  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

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

    this.yaw = initYaw;
    this.pitch = initPitch;
    this._resize();
  }

  /* -------------------- hotspots -------------------- */
  setHotspots(list) {
    // Clear
    this.hotspots.forEach((h) => {
      this.hotspotGroup.remove(h.mesh);
      if (h.mesh.material.map) h.mesh.material.map.dispose();
      h.mesh.material.dispose();
    });
    this.hotspots = [];
    (list || []).forEach((data) => this._addHotspotMesh(data));
  }

  _addHotspotMesh(data) {
    const tex = this._makeHotspotTexture(data.type);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    const scale = data.type === 'note' ? 34 : 46;
    sprite.scale.set(scale, scale, 1);
    const dir = dirFromYawPitch(data.yaw, data.pitch).multiplyScalar(HOTSPOT_R);
    sprite.position.copy(dir);
    sprite.userData = data;
    this.hotspotGroup.add(sprite);
    this.hotspots.push({ mesh: sprite, data });
  }

  _makeHotspotTexture(type) {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    // soft disc
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
    ctx.fillStyle = type === 'note' ? 'rgba(34,197,94,0.92)' : 'rgba(59,130,246,0.92)';
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    // glyph
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (type === 'note') {
      ctx.font = 'bold 60px sans-serif';
      ctx.fillText('i', size / 2, size / 2 + 2);
    } else {
      // up arrow (navigate)
      ctx.font = 'bold 66px sans-serif';
      ctx.fillText('↑', size / 2, size / 2 + 4);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /* -------------------- place mode -------------------- */
  setPlaceMode(mode) { this.placeMode = mode; }

  /* -------------------- input -------------------- */
  _bindInput() {
    const el = this.canvas;
    let dragging = false;
    let lastX = 0, lastY = 0;
    let moved = 0;
    let pinchDist = 0;
    let downTime = 0;

    const getYawPitchSensitivity = () => (this.fov / 70) * 0.0025;

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return; // handled by touch events
      dragging = true; moved = 0; downTime = Date.now();
      lastX = e.clientX; lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerType === 'touch') return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      const s = getYawPitchSensitivity();
      this.yaw -= dx * s;
      this.pitch += dy * s;
      this._clampPitch();
    });
    el.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') return;
      dragging = false;
      if (moved < 6 && Date.now() - downTime < 400) this._handleTap(e.clientX, e.clientY);
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.fov = Math.min(MAX_FOV, Math.max(MIN_FOV, this.fov + Math.sign(e.deltaY) * 3));
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }, { passive: false });

    // ----- Touch -----
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        dragging = true; moved = 0; downTime = Date.now();
        lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        dragging = false;
        pinchDist = this._touchDist(e.touches);
      }
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 1 && dragging) {
        const t = e.touches[0];
        const dx = t.clientX - lastX, dy = t.clientY - lastY;
        lastX = t.clientX; lastY = t.clientY;
        moved += Math.abs(dx) + Math.abs(dy);
        const s = getYawPitchSensitivity();
        this.yaw -= dx * s;
        this.pitch += dy * s;
        this._clampPitch();
      } else if (e.touches.length === 2) {
        const d = this._touchDist(e.touches);
        if (pinchDist) {
          const delta = (pinchDist - d) * 0.12;
          this.fov = Math.min(MAX_FOV, Math.max(MIN_FOV, this.fov + delta));
          this.camera.fov = this.fov;
          this.camera.updateProjectionMatrix();
        }
        pinchDist = d;
      }
    }, { passive: false });
    el.addEventListener('touchend', (e) => {
      if (dragging && moved < 10 && Date.now() - downTime < 400 && e.changedTouches.length) {
        this._handleTap(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      }
      dragging = false;
      if (e.touches.length < 2) pinchDist = 0;
    });
  }

  _touchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  _clampPitch() {
    const lim = Math.PI / 2 - 0.05;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  _handleTap(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);

    // Place mode wins if active.
    if (this.placeMode) {
      const dir = this.raycaster.ray.direction.clone().normalize();
      const yaw = Math.atan2(dir.x, dir.z);
      const pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
      if (this.onPlace) this.onPlace(yaw, pitch);
      return;
    }

    // Otherwise test hotspots.
    const meshes = this.hotspots.map((h) => h.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length && this.onHotspotActivate) {
      this.onHotspotActivate(hits[0].object.userData);
    }
  }

  /* -------------------- gyro -------------------- */
  async enableGyro() {
    // iOS 13+ requires an explicit permission prompt from a user gesture.
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') return false;
      }
    } catch (_) { return false; }

    this._onOrient = (e) => this._handleOrient(e);
    window.addEventListener('deviceorientation', this._onOrient, true);
    this._screenOrient = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
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
    const deg2rad = Math.PI / 180;
    const alpha = e.alpha * deg2rad;
    const beta = e.beta * deg2rad;
    const gamma = e.gamma * deg2rad;
    const orient = ((screen.orientation && screen.orientation.angle) || 0) * deg2rad;
    this._quatFromEuler(this._gyroQuat, alpha, beta, gamma, orient);
  }

  _quatFromEuler(quat, alpha, beta, gamma, orient) {
    // Standard deviceorientation -> quaternion (Three.js DeviceOrientationControls math)
    const zee = new THREE.Vector3(0, 0, 1);
    const euler = new THREE.Euler();
    const q0 = new THREE.Quaternion();
    const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 around x
    euler.set(beta, alpha, -gamma, 'YXZ');
    quat.setFromEuler(euler);
    quat.multiply(q1);
    quat.multiply(q0.setFromAxisAngle(zee, -orient));
  }

  /* -------------------- per-frame update -------------------- */
  _update() {
    if (this._gyroEnabled) {
      this.camera.quaternion.copy(this._gyroQuat);
    } else {
      const dir = dirFromYawPitch(this.yaw, this.pitch);
      this.camera.lookAt(dir);
    }
    // Keep hotspot sprites a constant on-screen size regardless of fov handled by sprite scale.
  }

  /* Return the current look direction as yaw/pitch (for saving initial view). */
  getLook() { return { yaw: this.yaw, pitch: this.pitch }; }

  dispose() {
    this.stop();
    this.disableGyro();
    if (this.currentTexture) this.currentTexture.dispose();
    this.renderer.dispose();
  }
}
