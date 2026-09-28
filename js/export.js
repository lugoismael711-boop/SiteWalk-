/* ============================================================
   export.js — export pinned tasks (notes) as a PDF punch list
   ------------------------------------------------------------
   For each note ("task") we render an undistorted perspective
   photo centered on the pin (via an offscreen WebGL panorama)
   and lay it out with the task text, priority and location.
   jsPDF (UMD) is vendored and lazy-loaded on first export.
   ============================================================ */

import * as THREE from 'three';

const PRIO_RANK = { high: 0, medium: 1, low: 2 };
const PRIO_RGB = { high: [239, 68, 68], medium: [245, 158, 11], low: [34, 197, 94] };
const PRIO_LABEL = { high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };

/* ---- offscreen equirect -> perspective capture ---- */
class OffscreenPano {
  constructor(w, h) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w; this.canvas.height = h;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(78, w / h, 0.1, 1100);
    const geo = new THREE.SphereGeometry(500, 64, 40); geo.scale(-1, 1, 1);
    this.mat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.sphere = new THREE.Mesh(geo, this.mat);
    this.scene.add(this.sphere);
    this.tex = null;
  }
  async setTexture(blob) {
    const url = URL.createObjectURL(blob);
    const tex = await new Promise((res, rej) => new THREE.TextureLoader().load(url, res, undefined, rej));
    tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    if (this.tex) this.tex.dispose();
    this.tex = tex;
    this.mat.map = tex; this.mat.color.set(0xffffff); this.mat.needsUpdate = true;
    URL.revokeObjectURL(url);
  }
  capture(yaw, pitch, fov = 80) {
    this.camera.fov = fov; this.camera.updateProjectionMatrix();
    const dir = new THREE.Vector3(
      Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw));
    this.camera.lookAt(dir);
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/jpeg', 0.82);
  }
  dispose() { if (this.tex) this.tex.dispose(); this.renderer.dispose(); }
}

/* ---- lazy-load jsPDF (UMD global) ---- */
let _jspdfP = null;
function loadJsPDF() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
  if (_jspdfP) return _jspdfP;
  _jspdfP = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'js/vendor/jspdf.umd.min.js';
    s.onload = resolve; s.onerror = () => reject(new Error('Could not load PDF library'));
    document.head.appendChild(s);
  });
  return _jspdfP;
}

/**
 * Build & download a tasks PDF.
 * @param opts { project, scenes, floors, getBlob, floorId? , onProgress? }
 * Returns the number of tasks exported.
 */
export async function exportTasksPDF({ project, scenes, floors, getBlob, floorId = null, onProgress }) {
  const floorName = (id) => { const f = (floors || []).find((x) => x.id === id); return f ? f.name : ''; };

  // Collect tasks (note hotspots), optionally limited to one floor.
  const tasks = [];
  scenes.forEach((s) => {
    if (floorId && s.floorId !== floorId) return;
    (s.hotspots || []).forEach((h) => { if (h.type === 'note') tasks.push({ scene: s, note: h }); });
  });
  if (!tasks.length) return 0;

  // Order: floor, then scene order, then priority (keeps a scene's texture reused).
  const floorOrder = new Map((floors || []).map((f, i) => [f.id, i]));
  tasks.sort((a, b) =>
    (floorOrder.get(a.scene.floorId) ?? 0) - (floorOrder.get(b.scene.floorId) ?? 0) ||
    (a.scene.order || 0) - (b.scene.order || 0) ||
    (PRIO_RANK[a.note.priority] ?? 1) - (PRIO_RANK[b.note.priority] ?? 1));

  await loadJsPDF();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const PW = doc.internal.pageSize.getWidth();
  const M = 40;
  const CW = PW - M * 2;

  // Header
  let y = M;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(20, 24, 30);
  doc.text(project.name || 'Site tour', M, y + 6);
  y += 24;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(120, 130, 140);
  const counts = { high: 0, medium: 0, low: 0 };
  tasks.forEach((t) => { counts[t.note.priority] = (counts[t.note.priority] || 0) + 1; });
  const date = new Date().toLocaleDateString();
  doc.text(`Punch list · ${tasks.length} task(s) · High ${counts.high || 0} / Med ${counts.medium || 0} / Low ${counts.low || 0} · ${date}`, M, y);
  y += 16;
  doc.setDrawColor(220, 224, 228); doc.line(M, y, PW - M, y);
  y += 14;

  const pano = new OffscreenPano(960, 600);
  const imgH = CW * (600 / 960); // keep aspect
  let curSceneId = null;

  try {
    for (let i = 0; i < tasks.length; i++) {
      const { scene, note } = tasks[i];
      if (onProgress) onProgress(i + 1, tasks.length);

      // Ensure the right panorama texture is loaded.
      if (scene.id !== curSceneId) {
        const blob = await getBlob(scene.imageId);
        if (blob) await pano.setTexture(blob);
        curSceneId = scene.id;
      }
      const img = pano.capture(note.yaw, note.pitch);

      // Block layout: priority chip + title, meta line, image.
      const titleLines = doc.splitTextToSize(note.text || '(no description)', CW - 90);
      const blockH = 22 + titleLines.length * 15 + 16 + imgH + 18;
      if (y + blockH > doc.internal.pageSize.getHeight() - M) { doc.addPage(); y = M; }

      // Number + priority chip
      const rgb = PRIO_RGB[note.priority] || PRIO_RGB.medium;
      doc.setFillColor(rgb[0], rgb[1], rgb[2]);
      doc.roundedRect(M, y, 74, 18, 4, 4, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(255, 255, 255);
      doc.text(`${i + 1}. ${PRIO_LABEL[note.priority] || 'MEDIUM'}`, M + 6, y + 12);

      // Title
      doc.setFontSize(13); doc.setTextColor(20, 24, 30);
      doc.text(titleLines, M + 88, y + 12);
      y += Math.max(20, titleLines.length * 15) + 4;

      // Meta
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(120, 130, 140);
      const loc = [floorName(scene.floorId), scene.name || 'Untitled'].filter(Boolean).join('  ›  ');
      doc.text(loc, M, y + 6);
      y += 16;

      // Image + a ring marking the pinned spot (centered)
      doc.addImage(img, 'JPEG', M, y, CW, imgH, undefined, 'FAST');
      doc.setDrawColor(rgb[0], rgb[1], rgb[2]); doc.setLineWidth(2.5);
      doc.circle(M + CW / 2, y + imgH / 2, 12, 'S');
      doc.setLineWidth(0.5);
      y += imgH + 20;
    }
  } finally {
    pano.dispose();
  }

  const fname = (project.name || 'tasks').replace(/[^\w\-]+/g, '_') + '_tasks.pdf';
  doc.save(fname);
  return tasks.length;
}
