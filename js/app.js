/* ============================================================
   app.js — SiteWalk main controller
   ============================================================ */

import * as DB from './db.js';
import { processPanorama, processImage } from './image.js';
import { PanoramaViewer } from './viewer.js';
import { FloorMap } from './map.js';
import { exportTasksPDF } from './export.js';
import * as UI from './ui.js';

/* -------------------- object-URL cache -------------------- */
const urlCache = new Map();
async function blobUrl(blobId) {
  if (!blobId) return null;
  if (urlCache.has(blobId)) return urlCache.get(blobId);
  const blob = await DB.getBlob(blobId);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(blobId, url);
  return url;
}
function forgetUrl(blobId) {
  if (urlCache.has(blobId)) { URL.revokeObjectURL(urlCache.get(blobId)); urlCache.delete(blobId); }
}
function clearUrlCache() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

const FLOOR_PITCH = -0.6;
const UNITS = ['ft', 'in', 'm', 'cm'];

/* -------------------- app state -------------------- */
const state = {
  view: 'projects',
  tab: 'tour',
  project: null,
  scenes: [],
  currentSceneId: null,
  currentFloorId: null,
  selectedForMap: null,
  history: [],          // scene ids for the Back button
};

let viewer = null;
let floorMap = null;
let placeType = null;
let replaceTargetId = null;
let aimResolver = null;

/* -------------------- refs -------------------- */
const el = (id) => document.getElementById(id);
const topbarTitle = el('title');
const btnBack = el('btnBack');

/* ============================================================ */
async function boot() {
  registerSW();
  wireGlobal();
  await renderProjects();
}
function registerSW() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => {});
}

function wireGlobal() {
  el('btnHelp').onclick = () => UI.showHelp();
  btnBack.onclick = () => { if (state.view === 'project') goProjects(); };

  el('btnNewProject').onclick = newProject;
  el('btnAddFirst').onclick = () => el('fileScene').click();
  el('btnAddShot').onclick = () => el('fileScene').click();

  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });

  el('fileScene').onchange = (e) => handleSceneFiles(e.target.files);
  el('fileFloor').onchange = (e) => handleFloorFile(e.target.files[0]);
  el('fileImport').onchange = (e) => handleImportFile(e.target.files[0]);
  el('fileReplace').onchange = (e) => handleReplaceFile(e.target.files[0]);

  // viewer HUD
  el('btnGyro').onclick = toggleGyro;
  el('btnAddHotspot').onclick = () => startPlace('nav');
  el('btnAddNote').onclick = () => startPlace('note');
  el('btnAddMeasure').onclick = () => startPlace('measure');
  el('btnManage').onclick = manageStop;
  el('btnFullscreen').onclick = toggleFullscreen;
  el('btnNavBack').onclick = navBack;
  el('placeBanner').onclick = cancelPlace;
  el('btnExportTasks').onclick = exportTasks;

  el('aimConfirm').onclick = () => finishAim(true);
  el('aimCancel').onclick = () => finishAim(false);

  el('btnMapUpload').onclick = () => el('fileFloor').click();
}

/* ============================================================
   Views
   ============================================================ */
function goProjects() {
  if (viewer) viewer.stop();
  state.view = 'projects'; state.project = null; state.history = [];
  clearUrlCache();
  el('view-project').classList.remove('active');
  el('view-projects').classList.add('active');
  btnBack.hidden = true;
  topbarTitle.textContent = 'SiteWalk';
  renderProjects();
}

async function openProject(id) {
  const project = await DB.getProject(id);
  if (!project) return;
  state.view = 'project'; state.project = project;
  state.scenes = await DB.listScenes(id);
  // Migrate legacy single-floor projects to the floors[] model.
  const mig = DB.ensureFloors(project, state.scenes);
  if (mig.changed) { await DB.putProject(project); for (const s of state.scenes) await DB.putScene(s); }
  state.currentFloorId = project.currentFloorId;
  state.currentSceneId = project.coverSceneId || (state.scenes[0] && state.scenes[0].id) || null;
  const cur = state.scenes.find((s) => s.id === state.currentSceneId);
  if (cur && cur.floorId) state.currentFloorId = cur.floorId;
  state.selectedForMap = state.currentSceneId;
  state.history = [];

  el('view-projects').classList.remove('active');
  el('view-project').classList.add('active');
  btnBack.hidden = false;
  topbarTitle.textContent = project.name;

  ensureViewer(); ensureMap();
  switchTab('tour');
  await refreshCurrentScene();
  renderFloorBars();
  renderGrid();
}

/* ============================================================
   Projects list
   ============================================================ */
async function renderProjects() {
  const listEl = el('projectList');
  const projects = await DB.listProjects();
  if (!projects.length) {
    listEl.innerHTML = `<div class="empty-note">No tours yet.<br/>Tap <strong>+</strong> to start your first site walk.<br/><br/>
      <button class="btn small" id="_imp">Import a .sitewalk file</button></div>`;
    listEl.querySelector('#_imp').onclick = () => el('fileImport').click();
    return;
  }
  listEl.innerHTML = '';
  for (const p of projects) {
    const scenes = await DB.listScenes(p.id);
    const coverScene = scenes.find((s) => s.id === p.coverSceneId) || scenes[0];
    const thumb = coverScene ? await blobUrl(coverScene.thumbId) : null;
    const card = document.createElement('div');
    card.className = 'project-card';
    card.innerHTML = `
      <div class="thumb" ${thumb ? `style="background-image:url('${thumb}')"` : ''}>${thumb ? '' : '🏙️'}</div>
      <div class="meta">
        <div class="name">${UI.escapeHtml(p.name)}</div>
        <div class="count">${scenes.length} shot${scenes.length === 1 ? '' : 's'}</div>
        <div class="del" title="Menu">⋮</div>
      </div>`;
    card.querySelector('.thumb').onclick = () => openProject(p.id);
    card.querySelector('.name').onclick = () => openProject(p.id);
    card.querySelector('.del').onclick = (e) => { e.stopPropagation(); projectMenu(p); };
    listEl.appendChild(card);
  }
  const imp = document.createElement('div');
  imp.className = 'empty-note';
  imp.innerHTML = `<button class="btn small" id="_imp2">Import a .sitewalk file</button>`;
  imp.querySelector('#_imp2').onclick = () => el('fileImport').click();
  listEl.appendChild(imp);
}

async function newProject() {
  const name = await UI.promptText({ title: 'New site tour', label: 'Tour name', placeholder: 'e.g. 5th St — Level 2', ok: 'Create' });
  if (name === null) return;
  const p = await DB.createProject(name || 'Untitled tour');
  await openProject(p.id);
}

async function projectMenu(p) {
  const { close, q } = UI.customModal(`
    <h2>${UI.escapeHtml(p.name)}</h2>
    <div class="row spread"><button class="btn small" data-a="rename">Rename</button>
      <button class="btn small" data-a="export">Export file</button>
      <button class="btn small danger" data-a="delete">Delete</button></div>
    <div class="row"><button class="btn" data-a="close">Close</button></div>`);
  q('[data-a=close]').onclick = close;
  q('[data-a=rename]').onclick = async () => {
    close();
    const name = await UI.promptText({ title: 'Rename tour', value: p.name, ok: 'Save' });
    if (name) { p.name = name; await DB.putProject(p); renderProjects(); }
  };
  q('[data-a=export]').onclick = async () => { close(); await exportProject(p.id); };
  q('[data-a=delete]').onclick = async () => {
    close();
    const ok = await UI.confirmDialog({ title: 'Delete tour?', message: `"${p.name}" and all its shots will be permanently deleted.`, ok: 'Delete', danger: true });
    if (ok) { await DB.deleteProject(p.id); UI.toast('Tour deleted'); renderProjects(); }
  };
}

/* ============================================================
   Tabs
   ============================================================ */
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  ['tour', 'map', 'grid'].forEach((n) => el('pane-' + n).classList.toggle('active', n === tab));
  if (tab === 'tour') { if (viewer) { viewer.start(); setTimeout(() => viewer._resize(), 30); } }
  else if (viewer) viewer.stop();
  if (tab === 'map') { renderFloorBars(); refreshMap(); }
  if (tab === 'grid') { renderFloorBars(); renderGrid(); }
}

/* ============================================================
   Viewer / current scene
   ============================================================ */
function ensureViewer() {
  if (viewer) return;
  viewer = new PanoramaViewer(el('viewer'));
  viewer.onHotspotActivate = onHotspotActivate;
  viewer.onHotspotMenu = onHotspotMenu;
  viewer.onPlace = onPlace;
  viewer.onMeasureFirstPoint = () => UI.toast('Now tap the second point');
}

/* ============================================================
   Floors
   ============================================================ */
function scenesOnFloor(floorId) {
  return state.scenes.filter((s) => (s.floorId || (state.project.floors[0] && state.project.floors[0].id)) === floorId);
}

function renderFloorBars() {
  ['floorBar', 'floorBarGrid'].forEach((id) => {
    const bar = el(id);
    if (!bar) return;
    bar.innerHTML = '';
    (state.project.floors || []).forEach((f) => {
      const chip = document.createElement('div');
      chip.className = 'floor-chip' + (f.id === state.currentFloorId ? ' active' : '');
      const count = scenesOnFloor(f.id).length;
      chip.innerHTML = `<span class="fc-name">${UI.escapeHtml(f.name)}${count ? ` · ${count}` : ''}</span>${f.id === state.currentFloorId ? '<span class="fc-menu">⋮</span>' : ''}`;
      chip.querySelector('.fc-name').onclick = () => setFloor(f.id);
      const menu = chip.querySelector('.fc-menu');
      if (menu) menu.onclick = (e) => { e.stopPropagation(); floorMenu(f); };
      bar.appendChild(chip);
    });
    const add = document.createElement('div');
    add.className = 'floor-chip add';
    add.textContent = '＋ Floor';
    add.onclick = addFloor;
    bar.appendChild(add);
  });
}

async function setFloor(id) {
  state.currentFloorId = id;
  state.project.currentFloorId = id;
  await DB.putProject(state.project);
  // Keep the map selection on this floor.
  const onFloor = scenesOnFloor(id);
  if (!onFloor.some((s) => s.id === state.selectedForMap)) state.selectedForMap = onFloor[0] ? onFloor[0].id : null;
  renderFloorBars();
  renderGrid();
  refreshMap();
}

async function addFloor() {
  const name = await UI.promptText({ title: 'Add floor', label: 'Floor name', placeholder: 'e.g. Level 3 / Roof / Basement', ok: 'Add' });
  if (name === null) return;
  const floor = { id: DB.uid('f_'), name: name || `Level ${state.project.floors.length + 1}`, floorImageId: null };
  state.project.floors.push(floor);
  await DB.putProject(state.project);
  await setFloor(floor.id);
  UI.toast('Floor added — import shots to put them here');
}

async function floorMenu(floor) {
  const { close, q } = UI.customModal(`
    <h2>${UI.escapeHtml(floor.name)}</h2>
    <div class="row spread">
      <button class="btn small" data-a="rename">Rename</button>
      <button class="btn small" data-a="image">${floor.floorImageId ? 'Change' : 'Set'} plan image</button>
      <button class="btn small danger" data-a="del">Delete floor</button>
    </div>
    <div class="row"><button class="btn" data-a="close">Close</button></div>`);
  q('[data-a=close]').onclick = close;
  q('[data-a=rename]').onclick = async () => {
    close();
    const name = await UI.promptText({ title: 'Rename floor', value: floor.name, ok: 'Save' });
    if (name) { floor.name = name; await DB.putProject(state.project); renderFloorBars(); }
  };
  q('[data-a=image]').onclick = () => { close(); el('fileFloor').click(); };
  q('[data-a=del]').onclick = async () => {
    close();
    if (state.project.floors.length < 2) { UI.toast('Keep at least one floor'); return; }
    const others = state.project.floors.filter((f) => f.id !== floor.id);
    const moveTo = others[0];
    const n = scenesOnFloor(floor.id).length;
    const ok = await UI.confirmDialog({
      title: 'Delete floor?',
      message: n ? `${n} shot(s) will move to "${moveTo.name}".` : `Delete "${floor.name}"?`,
      ok: 'Delete', danger: true,
    });
    if (!ok) return;
    for (const s of scenesOnFloor(floor.id)) { s.floorId = moveTo.id; await DB.putScene(s); }
    if (floor.floorImageId) { forgetUrl(floor.floorImageId); await DB.deleteBlob(floor.floorImageId); }
    state.project.floors = others;
    if (state.currentFloorId === floor.id) state.currentFloorId = moveTo.id;
    state.project.currentFloorId = state.currentFloorId;
    await DB.putProject(state.project);
    renderFloorBars(); renderGrid(); refreshMap();
    UI.toast('Floor deleted');
  };
}

function currentFloor() { return (state.project.floors || []).find((f) => f.id === state.currentFloorId) || state.project.floors[0]; }
function currentScene() { return state.scenes.find((s) => s.id === state.currentSceneId) || null; }

async function refreshCurrentScene(view) {
  const scene = currentScene();
  const hud = el('viewerHud'), empty = el('viewerEmpty');
  if (!scene) { empty.hidden = false; hud.hidden = true; viewer.stop(); return; }
  empty.hidden = true; hud.hidden = false;
  el('sceneName').textContent = scene.name || 'Untitled';
  updateBackButton();
  const blob = await DB.getBlob(scene.imageId);
  if (!blob) { UI.toast('Image missing for this shot'); return; }
  await viewer.loadPanorama(blob, {
    initYaw: view ? view.yaw : (scene.initYaw || 0),
    initPitch: view ? view.pitch : (scene.initPitch || 0),
  });
  viewer.setHotspots(scene.hotspots || []);
  if (state.tab === 'tour') viewer.start();
}

async function goToScene(id, view, { record = true } = {}) {
  if (record && state.currentSceneId && state.currentSceneId !== id) state.history.push(state.currentSceneId);
  state.currentSceneId = id;
  state.selectedForMap = id;
  // Follow the shot to its floor so the map/grid context stays in sync.
  const sc = state.scenes.find((s) => s.id === id);
  if (sc && sc.floorId && sc.floorId !== state.currentFloorId) {
    state.currentFloorId = sc.floorId;
    state.project.currentFloorId = sc.floorId;
    await DB.putProject(state.project);
    renderFloorBars();
  }
  await refreshCurrentScene(view);
  if (state.tab !== 'tour') switchTab('tour');
  if (floorMap) floorMap.setSelected(id);
}

function navBack() {
  if (!state.history.length) return;
  const prev = state.history.pop();
  goToScene(prev, undefined, { record: false });
}
function updateBackButton() { el('btnNavBack').hidden = state.history.length === 0; }

/* ---------- hotspot activation ---------- */
async function onHotspotActivate(data) {
  if (data.type === 'nav') {
    if (data.targetSceneId) {
      const view = (data.landingYaw != null) ? { yaw: data.landingYaw, pitch: data.landingPitch } : undefined;
      goToScene(data.targetSceneId, view);
    }
  } else if (data.type === 'note') {
    noteViewModal(data);
  } else if (data.type === 'measure') {
    measureViewModal(data);
  }
}

/* Long-press on a hotspot — quick delete for arrows, edit menu for the rest. */
async function onHotspotMenu(data) {
  if (data.type === 'note') return noteViewModal(data);
  if (data.type === 'measure') return measureViewModal(data);
  // nav arrow
  const scene = currentScene();
  const target = state.scenes.find((s) => s.id === data.targetSceneId);
  const tname = target ? (target.name || 'Untitled') : 'deleted shot';
  const { close, q } = UI.customModal(`
    <h2>Path arrow → ${UI.escapeHtml(tname)}</h2>
    <p class="muted">Delete this arrow?</p>
    <div class="row spread">
      <button class="btn small" data-a="one">This direction</button>
      <button class="btn small danger" data-a="both">Both directions</button>
      <button class="btn" data-a="cancel">Cancel</button>
    </div>`);
  q('[data-a=cancel]').onclick = close;
  q('[data-a=one]').onclick = async () => { close(); await removeHotspot(data.id); };
  q('[data-a=both]').onclick = async () => {
    close();
    if (target) {
      target.hotspots = (target.hotspots || []).filter((h) => !(h.type === 'nav' && h.targetSceneId === scene.id));
      await DB.putScene(target);
    }
    await removeHotspot(data.id);
  };
}

/* ============================================================
   Placement
   ============================================================ */
function startPlace(type) {
  if (!currentScene()) return;
  placeType = type;
  viewer.setPlaceMode(type);
  const banner = el('placeBanner');
  banner.hidden = false;
  banner.textContent =
    type === 'nav' ? 'Tap the floor where the path arrow should go — tap here to cancel'
    : type === 'note' ? 'Tap the spot to pin a note — tap here to cancel'
    : 'Tap the FIRST point, then the second point — tap here to cancel';
}
function cancelPlace() {
  placeType = null;
  if (viewer) viewer.setPlaceMode(null);
  el('placeBanner').hidden = true;
}

async function onPlace(mode, payload) {
  if (mode === 'nav') return placeNav(payload);
  if (mode === 'note') return placeNote(payload);
  if (mode === 'measure') return placeMeasure(payload);
}

/* ---------- nav: build a two-way path with landing views ---------- */
async function placeNav(payload) {
  cancelPlace();
  const origin = currentScene();
  if (!origin) return;
  const originView = viewer.getLook();

  const linked = new Set((origin.hotspots || []).filter((h) => h.type === 'nav').map((h) => h.targetSceneId));
  const others = state.scenes.filter((s) => s.id !== origin.id && !linked.has(s.id));
  if (!others.length) {
    UI.toast(state.scenes.length < 2 ? 'Add another shot first, then link to it.' : 'Every other shot is already linked from here.');
    return;
  }
  const items = [];
  for (const s of others) items.push({ id: s.id, label: s.name || 'Untitled', thumb: await blobUrl(s.thumbId) });
  const targetId = await UI.chooseFromList({ title: 'Walk to which shot?', items });
  if (!targetId) return;
  const target = state.scenes.find((s) => s.id === targetId);

  // Choose the arrival view in the target.
  const arrival = await aimView(target, `Turn to the view you'll see when you ARRIVE at "${target.name}", then confirm`);
  if (!arrival) { await refreshCurrentScene(originView); return; }

  // Forward arrow in origin.
  origin.hotspots = origin.hotspots || [];
  origin.hotspots.push({
    id: DB.uid('h_'), type: 'nav', yaw: payload.yaw, pitch: payload.pitch,
    targetSceneId: target.id, landingYaw: arrival.yaw, landingPitch: arrival.pitch,
  });
  await DB.putScene(origin);

  // Return arrow in target (default position behind the arrival view; landing = origin's current view).
  target.hotspots = target.hotspots || [];
  target.hotspots.push({
    id: DB.uid('h_'), type: 'nav', yaw: arrival.yaw + Math.PI, pitch: FLOOR_PITCH,
    targetSceneId: origin.id, landingYaw: originView.yaw, landingPitch: originView.pitch,
  });
  await DB.putScene(target);
  await DB.putProject(state.project);

  await refreshCurrentScene(originView);
  UI.toast('Two-way path created ✓  (fine-tune with ☰)');
}

/* ---------- note ---------- */
async function placeNote(payload) {
  cancelPlace();
  const scene = currentScene();
  const res = await noteDialog({ text: '', priority: 'medium' }, 'New note');
  if (!res) return;
  scene.hotspots = scene.hotspots || [];
  scene.hotspots.push({ id: DB.uid('h_'), type: 'note', yaw: payload.yaw, pitch: payload.pitch, text: res.text, priority: res.priority });
  await saveScene(scene);
  UI.toast('Note added');
}

/* ---------- measure ---------- */
async function placeMeasure(payload) {
  cancelPlace();
  const scene = currentScene();
  const res = await measureDialog({ num: '', unit: 'ft', label: '' }, 'New measurement');
  if (!res) return;
  scene.hotspots = scene.hotspots || [];
  scene.hotspots.push({
    id: DB.uid('h_'), type: 'measure', a: payload.a, b: payload.b,
    value: `${res.num} ${res.unit}`, num: res.num, unit: res.unit, label: res.label,
  });
  await saveScene(scene);
  UI.toast('Measurement stored');
}

async function saveScene(scene) {
  await DB.putScene(scene);
  await DB.putProject(state.project);
  if (scene.id === state.currentSceneId) viewer.setHotspots(scene.hotspots || []);
}

/* ============================================================
   Aim mode (choose the landing view in a scene)
   ============================================================ */
async function aimView(scene, text) {
  const blob = await DB.getBlob(scene.imageId);
  if (!blob) return null;
  await viewer.loadPanorama(blob, { initYaw: scene.initYaw || 0, initPitch: scene.initPitch || 0 });
  viewer.setHotspots([]);
  viewer.setPlaceMode(null);
  viewer.start();
  el('sceneName').textContent = `${scene.name} — set view`;
  el('aimText').textContent = text;
  el('aimBar').hidden = false;
  el('placeBanner').hidden = true;
  return new Promise((resolve) => { aimResolver = resolve; });
}
function finishAim(ok) {
  el('aimBar').hidden = true;
  const cb = aimResolver; aimResolver = null;
  if (cb) cb(ok ? viewer.getLook() : null);
}

/* ============================================================
   View modals for notes & measurements
   ============================================================ */
async function noteViewModal(data) {
  const color = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e' }[data.priority] || '#f59e0b';
  const { close, q } = UI.customModal(`
    <h2><span class="dot" style="background:${color}"></span> Note</h2>
    <p style="white-space:pre-wrap;line-height:1.5">${UI.escapeHtml(data.text || '(empty)')}</p>
    <div class="row spread">
      <button class="btn small danger" data-a="del">Delete</button>
      <div><button class="btn small" data-a="edit">Edit</button>
        <button class="btn primary small" data-a="close">Close</button></div>
    </div>`);
  q('[data-a=close]').onclick = close;
  q('[data-a=edit]').onclick = async () => {
    close();
    const res = await noteDialog(data, 'Edit note');
    if (res) { data.text = res.text; data.priority = res.priority; await saveScene(currentScene()); }
  };
  q('[data-a=del]').onclick = async () => { close(); await removeHotspot(data.id); };
}

async function measureViewModal(data) {
  const { close, q } = UI.customModal(`
    <h2>📏 Measurement</h2>
    <p style="font-size:20px;font-weight:700">${UI.escapeHtml(data.value || '')}</p>
    ${data.label ? `<p class="muted">${UI.escapeHtml(data.label)}</p>` : ''}
    <div class="row spread">
      <button class="btn small danger" data-a="del">Delete</button>
      <div><button class="btn small" data-a="edit">Edit</button>
        <button class="btn primary small" data-a="close">Close</button></div>
    </div>`);
  q('[data-a=close]').onclick = close;
  q('[data-a=edit]').onclick = async () => {
    close();
    const res = await measureDialog({ num: data.num, unit: data.unit, label: data.label }, 'Edit measurement');
    if (res) { data.num = res.num; data.unit = res.unit; data.value = `${res.num} ${res.unit}`; data.label = res.label; await saveScene(currentScene()); }
  };
  q('[data-a=del]').onclick = async () => { close(); await removeHotspot(data.id); };
}

/* ---------- reusable dialogs ---------- */
function noteDialog(cur, title) {
  return new Promise((resolve) => {
    const prio = cur.priority || 'medium';
    const { close, q, wrap } = UI.customModal(`
      <h2>${UI.escapeHtml(title)}</h2>
      <div class="field"><label>Note</label>
        <textarea id="_nt" placeholder="e.g. Cracked tile — needs repair">${UI.escapeHtml(cur.text || '')}</textarea></div>
      <div class="field"><label>Priority</label>
        <div class="prio-row">
          <div class="prio-opt prio-high ${prio === 'high' ? 'sel' : ''}" data-p="high">High</div>
          <div class="prio-opt prio-medium ${prio === 'medium' ? 'sel' : ''}" data-p="medium">Medium</div>
          <div class="prio-opt prio-low ${prio === 'low' ? 'sel' : ''}" data-p="low">Low</div>
        </div></div>
      <div class="row"><button class="btn" data-a="cancel">Cancel</button>
        <button class="btn primary" data-a="ok">Save</button></div>`);
    let chosen = prio;
    wrap.querySelectorAll('.prio-opt').forEach((o) => {
      o.onclick = () => { chosen = o.dataset.p; wrap.querySelectorAll('.prio-opt').forEach((x) => x.classList.remove('sel')); o.classList.add('sel'); };
    });
    q('[data-a=ok]').onclick = () => { const text = q('#_nt').value.trim(); close(); resolve({ text, priority: chosen }); };
    q('[data-a=cancel]').onclick = () => { close(); resolve(null); };
  });
}

function measureDialog(cur, title) {
  return new Promise((resolve) => {
    const opts = UNITS.map((u) => `<option value="${u}" ${cur.unit === u ? 'selected' : ''}>${u}</option>`).join('');
    const { close, q } = UI.customModal(`
      <h2>${UI.escapeHtml(title)}</h2>
      <p class="muted tiny">Measure with your tape/laser, then log it here against the two points you tapped.</p>
      <div class="field"><label>Measurement</label>
        <div style="display:flex;gap:8px">
          <input id="_mv" type="text" inputmode="decimal" value="${UI.escapeAttr(cur.num || '')}" placeholder="e.g. 12.5" style="flex:2" />
          <select id="_mu" style="flex:1">${opts}</select>
        </div></div>
      <div class="field"><label>Label (optional)</label>
        <input id="_ml" type="text" value="${UI.escapeAttr(cur.label || '')}" placeholder="e.g. Doorway width" /></div>
      <div class="row"><button class="btn" data-a="cancel">Cancel</button>
        <button class="btn primary" data-a="ok">Save</button></div>`);
    q('[data-a=ok]').onclick = () => {
      const num = q('#_mv').value.trim(); const unit = q('#_mu').value; const label = q('#_ml').value.trim();
      if (!num) { UI.toast('Enter a measurement'); return; }
      close(); resolve({ num, unit, label });
    };
    q('[data-a=cancel]').onclick = () => { close(); resolve(null); };
  });
}

async function removeHotspot(hotspotId) {
  const scene = currentScene();
  if (!scene) return;
  scene.hotspots = (scene.hotspots || []).filter((h) => h.id !== hotspotId);
  await saveScene(scene);
  UI.toast('Removed');
}

/* ============================================================
   Manage panel — arrows, notes & measurements for this stop
   ============================================================ */
async function manageStop() {
  const scene = currentScene();
  if (!scene) return;
  const hs = scene.hotspots || [];
  const navs = hs.filter((h) => h.type === 'nav');
  const notes = hs.filter((h) => h.type === 'note');
  const meas = hs.filter((h) => h.type === 'measure');
  const nameOf = (id) => { const s = state.scenes.find((x) => x.id === id); return s ? (s.name || 'Untitled') : '(deleted)'; };

  const section = (label, rows) => rows.length ? `<div class="section-label">${label}</div><div class="manage-list">${rows.join('')}</div>` : '';
  const navRows = navs.map((h) => `
    <div class="manage-row" data-id="${h.id}">
      <div class="m-ico">➤</div>
      <div class="m-body"><div class="m-title">to ${UI.escapeHtml(nameOf(h.targetSceneId))}</div>
        <div class="m-sub">arrival view saved</div></div>
      <div class="m-act"><button class="btn small" data-a="aim">Arrival view</button>
        <button class="btn small danger" data-a="del">✕</button></div>
    </div>`);
  const noteRows = notes.map((h) => {
    const color = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e' }[h.priority] || '#f59e0b';
    return `<div class="manage-row" data-id="${h.id}">
      <div class="m-ico"><span class="dot" style="background:${color}"></span></div>
      <div class="m-body"><div class="m-title">${UI.escapeHtml(h.text || '(empty)')}</div>
        <div class="m-sub">${h.priority || 'medium'} priority</div></div>
      <div class="m-act"><button class="btn small" data-a="edit">Edit</button>
        <button class="btn small danger" data-a="del">✕</button></div>
    </div>`;
  });
  const measRows = meas.map((h) => `
    <div class="manage-row" data-id="${h.id}">
      <div class="m-ico">📏</div>
      <div class="m-body"><div class="m-title">${UI.escapeHtml(h.value || '')}</div>
        <div class="m-sub">${UI.escapeHtml(h.label || '')}</div></div>
      <div class="m-act"><button class="btn small" data-a="edit">Edit</button>
        <button class="btn small danger" data-a="del">✕</button></div>
    </div>`);

  const body = (navRows.length || noteRows.length || measRows.length)
    ? section('Path arrows', navRows) + section('Notes', noteRows) + section('Measurements', measRows)
    : `<p class="muted">Nothing here yet. Use ➤ 📌 📏 to add path arrows, notes and measurements.</p>`;

  const { close, wrap } = UI.customModal(`
    <h2>${UI.escapeHtml(scene.name || 'This stop')}</h2>
    ${body}
    <div class="row"><button class="btn" data-a="close">Close</button></div>`);
  wrap.querySelector('[data-a=close]').onclick = close;

  wrap.querySelectorAll('.manage-row').forEach((row) => {
    const id = row.dataset.id;
    const h = hs.find((x) => x.id === id);
    const act = (a) => row.querySelector(`[data-a=${a}]`);
    if (act('del')) act('del').onclick = async () => { close(); await removeHotspot(id); manageStop(); };
    if (act('edit')) act('edit').onclick = async () => {
      close();
      if (h.type === 'note') { const r = await noteDialog(h, 'Edit note'); if (r) { h.text = r.text; h.priority = r.priority; await saveScene(scene); } }
      else if (h.type === 'measure') { const r = await measureDialog({ num: h.num, unit: h.unit, label: h.label }, 'Edit measurement'); if (r) { h.num = r.num; h.unit = r.unit; h.value = `${r.num} ${r.unit}`; h.label = r.label; await saveScene(scene); } }
      manageStop();
    };
    if (act('aim')) act('aim').onclick = async () => {
      close();
      const target = state.scenes.find((s) => s.id === h.targetSceneId);
      if (!target) { UI.toast('Target shot was deleted'); return; }
      const view = await aimView(target, `Turn to the view you'll see when arriving at "${target.name}", then confirm`);
      if (view) { h.landingYaw = view.yaw; h.landingPitch = view.pitch; await DB.putScene(scene); UI.toast('Arrival view updated'); }
      await refreshCurrentScene();
    };
  });
}

/* ---------- gyro / fullscreen ---------- */
async function toggleGyro() {
  const btn = el('btnGyro');
  if (viewer.gyroEnabled) { viewer.disableGyro(); btn.classList.remove('active'); }
  else {
    const ok = await viewer.enableGyro();
    if (ok) { btn.classList.add('active'); UI.toast('Move your phone to look around'); }
    else UI.toast('Motion access not available');
  }
}
function toggleFullscreen() {
  const wrap = el('viewerWrap');
  if (!document.fullscreenElement) (wrap.requestFullscreen || wrap.webkitRequestFullscreen || (() => {})).call(wrap);
  else (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
  setTimeout(() => viewer && viewer._resize(), 300);
}

/* ============================================================
   Shots grid
   ============================================================ */
async function renderGrid() {
  const grid = el('shotGrid');
  const floorScenes = state.currentFloorId ? scenesOnFloor(state.currentFloorId) : state.scenes;
  if (!floorScenes.length) {
    const fname = currentFloor() ? currentFloor().name : '';
    grid.innerHTML = `<div class="empty-note" style="grid-column:1/-1">No shots on <strong>${UI.escapeHtml(fname)}</strong> yet.<br/>Tap <strong>+</strong> to import 360° photos onto this floor.</div>`;
    return;
  }
  grid.innerHTML = '';
  for (const s of floorScenes) {
    const thumb = await blobUrl(s.thumbId);
    const nav = (s.hotspots || []).filter((h) => h.type === 'nav').length;
    const notes = (s.hotspots || []).filter((h) => h.type === 'note').length;
    const meas = (s.hotspots || []).filter((h) => h.type === 'measure').length;
    const badges = [nav && `➤${nav}`, notes && `📌${notes}`, meas && `📏${meas}`].filter(Boolean).join('  ');
    const cell = document.createElement('div');
    cell.className = 'shot-cell' + (s.id === state.selectedForMap ? ' selected' : '');
    cell.innerHTML = `
      <div class="sh-thumb" ${thumb ? `style="background-image:url('${thumb}')"` : ''}></div>
      <div class="sh-meta"><div class="sh-name">${UI.escapeHtml(s.name || 'Untitled')}</div><div class="del">⋮</div></div>
      ${badges ? `<div class="sh-badges">${badges}</div>` : ''}`;
    cell.querySelector('.sh-thumb').onclick = () => goToScene(s.id);
    cell.querySelector('.sh-name').onclick = () => goToScene(s.id);
    cell.querySelector('.del').onclick = (e) => { e.stopPropagation(); sceneMenu(s); };
    grid.appendChild(cell);
  }
}

async function sceneMenu(scene) {
  const { close, q } = UI.customModal(`
    <h2>${UI.escapeHtml(scene.name || 'Untitled')}</h2>
    <div class="row spread">
      <button class="btn small" data-a="open">Open</button>
      <button class="btn small" data-a="rename">Rename</button>
      <button class="btn small" data-a="cover">Set as cover</button>
    </div>
    <div class="row spread" style="margin-top:8px">
      <button class="btn small" data-a="replace">Replace photo</button>
      <button class="btn small" data-a="view">Set start view</button>
    </div>
    <div class="row spread" style="margin-top:8px">
      <button class="btn small danger" data-a="del">Delete</button>
      <button class="btn" data-a="close">Close</button>
    </div>`);
  q('[data-a=close]').onclick = close;
  q('[data-a=open]').onclick = () => { close(); goToScene(scene.id); };
  q('[data-a=rename]').onclick = async () => {
    close();
    const name = await UI.promptText({ title: 'Rename shot', value: scene.name, ok: 'Save' });
    if (name) { scene.name = name; await DB.putScene(scene); renderGrid(); if (scene.id === state.currentSceneId) el('sceneName').textContent = name; }
  };
  q('[data-a=cover]').onclick = async () => { close(); state.project.coverSceneId = scene.id; await DB.putProject(state.project); UI.toast('Cover set'); };
  q('[data-a=replace]').onclick = () => { close(); replaceTargetId = scene.id; el('fileReplace').click(); };
  q('[data-a=view]').onclick = async () => {
    close();
    if (scene.id !== state.currentSceneId) await goToScene(scene.id);
    const look = viewer.getLook();
    scene.initYaw = look.yaw; scene.initPitch = look.pitch;
    await DB.putScene(scene);
    UI.toast('Start view saved to current angle');
  };
  q('[data-a=del]').onclick = async () => {
    close();
    const ok = await UI.confirmDialog({ title: 'Delete shot?', message: `"${scene.name || 'Untitled'}" will be removed.`, ok: 'Delete', danger: true });
    if (!ok) return;
    await DB.deleteScene(scene);
    state.scenes = await DB.listScenes(state.project.id);
    state.history = state.history.filter((h) => h !== scene.id);
    if (state.currentSceneId === scene.id) {
      state.currentSceneId = state.scenes[0] ? state.scenes[0].id : null;
      await refreshCurrentScene();
    }
    renderGrid(); refreshMap();
  };
}

/* ============================================================
   File handling
   ============================================================ */
async function handleSceneFiles(fileList) {
  const files = Array.from(fileList || []);
  el('fileScene').value = '';
  if (!files.length || !state.project) return;
  UI.toast(`Importing ${files.length} photo${files.length === 1 ? '' : 's'}…`, 4000);
  let warned = false;
  for (const file of files) {
    try {
      const { full, thumb, equirect } = await processPanorama(file);
      if (!equirect && !warned) { UI.toast('Heads up: a photo isn\'t 2:1 equirectangular — it may look distorted.', 3500); warned = true; }
      const imageId = await DB.putBlob(DB.uid('b_'), full);
      const thumbId = await DB.putBlob(DB.uid('b_'), thumb);
      const scene = {
        id: DB.uid('s_'), projectId: state.project.id,
        name: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Shot',
        order: state.scenes.length, imageId, thumbId,
        floorId: state.currentFloorId,
        initYaw: 0, initPitch: 0, map: null, hotspots: [],
      };
      await DB.putScene(scene);
      state.scenes.push(scene);
      if (!state.project.coverSceneId) state.project.coverSceneId = scene.id;
      if (!state.currentSceneId) state.currentSceneId = scene.id;
    } catch (err) { console.error(err); UI.toast(`Couldn't import ${file.name}`); }
  }
  await DB.putProject(state.project);
  state.selectedForMap = state.currentSceneId;
  renderGrid();
  await refreshCurrentScene();
  refreshMap();
  UI.toast('Done. Open a shot and tap ➤ to connect the walk.', 3500);
}

async function handleReplaceFile(file) {
  el('fileReplace').value = '';
  const scene = state.scenes.find((s) => s.id === replaceTargetId);
  replaceTargetId = null;
  if (!file || !scene) return;
  try {
    UI.toast('Replacing photo…');
    const { full, thumb } = await processPanorama(file);
    forgetUrl(scene.imageId); forgetUrl(scene.thumbId);
    if (scene.imageId) await DB.deleteBlob(scene.imageId);
    if (scene.thumbId) await DB.deleteBlob(scene.thumbId);
    scene.imageId = await DB.putBlob(DB.uid('b_'), full);
    scene.thumbId = await DB.putBlob(DB.uid('b_'), thumb);
    await DB.putScene(scene);
    renderGrid();
    if (scene.id === state.currentSceneId) await refreshCurrentScene();
    UI.toast('Photo replaced (arrows & notes kept)');
  } catch (e) { console.error(e); UI.toast('Couldn\'t replace that photo'); }
}

async function handleFloorFile(file) {
  el('fileFloor').value = '';
  if (!file || !state.project) return;
  const floor = currentFloor();
  if (!floor) return;
  try {
    const { blob } = await processImage(file, 3000);
    if (floor.floorImageId) { forgetUrl(floor.floorImageId); await DB.deleteBlob(floor.floorImageId); }
    floor.floorImageId = await DB.putBlob(DB.uid('b_'), blob);
    await DB.putProject(state.project);
    refreshMap();
    UI.toast(`Floor plan set for ${floor.name}`);
  } catch (e) { UI.toast('Couldn\'t load that image'); }
}

/* ============================================================
   Map
   ============================================================ */
function ensureMap() {
  if (floorMap) return;
  floorMap = new FloorMap(el('mapCanvas'));
  floorMap.onOpenScene = (id) => goToScene(id);
  floorMap.onMoveScene = async (id, pos) => { const s = state.scenes.find((x) => x.id === id); if (s) { s.map = pos; await DB.putScene(s); } };
  floorMap.onPlaceScene = async (id, pos) => {
    const s = state.scenes.find((x) => x.id === id);
    if (s) { s.map = pos; await DB.putScene(s); floorMap.setData(scenesOnFloor(state.currentFloorId), floorMap.floorImage, state.selectedForMap); UI.toast('Placed'); }
  };
}
async function refreshMap() {
  if (!floorMap) return;
  const floor = currentFloor();
  let img = null;
  if (floor && floor.floorImageId) {
    const url = await blobUrl(floor.floorImageId);
    if (url) img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
  }
  floorMap.setData(scenesOnFloor(state.currentFloorId), img, state.selectedForMap);
}

/* ============================================================
   Export / import
   ============================================================ */
async function exportProject(id) {
  UI.toast('Preparing export…');
  const data = await DB.exportProject(id);
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = (data.project.name || 'tour').replace(/[^\w\-]+/g, '_') + '.sitewalk';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function exportTasks() {
  if (!state.project) return;
  const totalAll = state.scenes.reduce((n, s) => n + (s.hotspots || []).filter((h) => h.type === 'note').length, 0);
  if (!totalAll) { UI.toast('No pinned tasks yet — add notes with 📌'); return; }
  const onFloor = scenesOnFloor(state.currentFloorId).reduce((n, s) => n + (s.hotspots || []).filter((h) => h.type === 'note').length, 0);
  const fname = currentFloor() ? currentFloor().name : 'this floor';
  const { close, q } = UI.customModal(`
    <h2>Export tasks to PDF</h2>
    <p class="muted">Each pinned task becomes a page with its photo, priority and location.</p>
    <div class="row spread">
      <button class="btn small" data-a="floor">${UI.escapeHtml(fname)} (${onFloor})</button>
      <button class="btn primary small" data-a="all">All floors (${totalAll})</button>
      <button class="btn" data-a="cancel">Cancel</button>
    </div>`);
  q('[data-a=cancel]').onclick = close;
  const run = async (floorId) => {
    close();
    UI.toast('Building PDF…', 60000);
    try {
      const n = await exportTasksPDF({
        project: state.project, scenes: state.scenes, floors: state.project.floors,
        getBlob: DB.getBlob, floorId,
        onProgress: (i, t) => UI.toast(`Rendering task ${i} of ${t}…`, 60000),
      });
      UI.toast(n ? `PDF ready — ${n} task(s)` : 'No tasks to export');
    } catch (e) { console.error(e); UI.toast('PDF export failed'); }
  };
  q('[data-a=floor]').onclick = () => run(state.currentFloorId);
  q('[data-a=all]').onclick = () => run(null);
}

async function handleImportFile(file) {
  el('fileImport').value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const p = await DB.importProject(data);
    UI.toast('Imported');
    await openProject(p.id);
  } catch (e) { console.error(e); UI.toast('That file could not be imported'); }
}

boot();
