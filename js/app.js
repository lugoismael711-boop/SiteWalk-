/* ============================================================
   app.js — SiteWalk main controller
   ============================================================ */

import * as DB from './db.js';
import { processPanorama, processImage } from './image.js';
import { PanoramaViewer } from './viewer.js';
import { FloorMap } from './map.js';
import * as UI from './ui.js';

/* -------------------- object-URL cache -------------------- */
const urlCache = new Map(); // blobId -> objectURL
async function blobUrl(blobId) {
  if (!blobId) return null;
  if (urlCache.has(blobId)) return urlCache.get(blobId);
  const blob = await DB.getBlob(blobId);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(blobId, url);
  return url;
}
function clearUrlCache() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

/* -------------------- app state -------------------- */
const state = {
  view: 'projects',       // 'projects' | 'project'
  tab: 'tour',            // 'tour' | 'map' | 'grid'
  project: null,
  scenes: [],
  currentSceneId: null,
  selectedForMap: null,   // scene id highlighted for map placement
};

let viewer = null;
let floorMap = null;

/* -------------------- element refs -------------------- */
const el = (id) => document.getElementById(id);
const topbarTitle = el('title');
const btnBack = el('btnBack');

/* ============================================================
   Boot
   ============================================================ */
async function boot() {
  registerSW();
  wireGlobal();
  await renderProjects();
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

function wireGlobal() {
  el('btnHelp').onclick = () => UI.showHelp();
  btnBack.onclick = () => { if (state.view === 'project') goProjects(); };

  el('btnNewProject').onclick = newProject;
  el('btnAddFirst').onclick = () => el('fileScene').click();
  el('btnAddShot').onclick = () => el('fileScene').click();

  // tabs
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => switchTab(t.dataset.tab);
  });

  // file inputs
  el('fileScene').onchange = (e) => handleSceneFiles(e.target.files);
  el('fileFloor').onchange = (e) => handleFloorFile(e.target.files[0]);
  el('fileImport').onchange = (e) => handleImportFile(e.target.files[0]);

  // viewer HUD
  el('btnGyro').onclick = toggleGyro;
  el('btnAddHotspot').onclick = () => startPlace('nav');
  el('btnAddNote').onclick = () => startPlace('note');
  el('btnFullscreen').onclick = toggleFullscreen;
  el('placeBanner').onclick = cancelPlace;

  // map
  el('btnMapUpload').onclick = () => el('fileFloor').click();
}

/* ============================================================
   Navigation between views
   ============================================================ */
function goProjects() {
  if (viewer) { viewer.stop(); }
  state.view = 'projects';
  state.project = null;
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
  state.view = 'project';
  state.project = project;
  state.scenes = await DB.listScenes(id);
  state.currentSceneId = project.coverSceneId || (state.scenes[0] && state.scenes[0].id) || null;
  state.selectedForMap = state.currentSceneId;

  el('view-projects').classList.remove('active');
  el('view-project').classList.add('active');
  btnBack.hidden = false;
  topbarTitle.textContent = project.name;

  ensureViewer();
  ensureMap();
  switchTab('tour');
  await refreshCurrentScene();
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
  // append an import affordance at the bottom
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
  const { wrap, close, q } = UI.customModal(`
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
  ['tour', 'map', 'grid'].forEach((name) => {
    el('pane-' + name).classList.toggle('active', name === tab);
  });
  if (tab === 'tour') {
    if (viewer) { viewer.start(); setTimeout(() => viewer._resize(), 30); }
  } else if (viewer) {
    viewer.stop();
  }
  if (tab === 'map') refreshMap();
  if (tab === 'grid') renderGrid();
}

/* ============================================================
   Viewer / current scene
   ============================================================ */
function ensureViewer() {
  if (viewer) return;
  viewer = new PanoramaViewer(el('viewer'));
  viewer.onHotspotActivate = onHotspotActivate;
  viewer.onPlace = onPlace;
}

function currentScene() {
  return state.scenes.find((s) => s.id === state.currentSceneId) || null;
}

async function refreshCurrentScene() {
  const scene = currentScene();
  const hud = el('viewerHud');
  const empty = el('viewerEmpty');
  if (!scene) {
    empty.hidden = false;
    hud.hidden = true;
    viewer.stop();
    return;
  }
  empty.hidden = true;
  hud.hidden = false;
  el('sceneName').textContent = scene.name || 'Untitled';

  const blob = await DB.getBlob(scene.imageId);
  if (!blob) { UI.toast('Image missing for this shot'); return; }
  await viewer.loadPanorama(blob, { initYaw: scene.initYaw || 0, initPitch: scene.initPitch || 0 });
  viewer.setHotspots(scene.hotspots || []);
  if (state.tab === 'tour') viewer.start();
}

async function goToScene(id) {
  state.currentSceneId = id;
  state.selectedForMap = id;
  await refreshCurrentScene();
  if (state.tab !== 'tour') switchTab('tour');
  if (floorMap) floorMap.setSelected(id);
}

/* ---------- hotspot activation ---------- */
async function onHotspotActivate(data) {
  if (data.type === 'nav') {
    if (data.targetSceneId) goToScene(data.targetSceneId);
  } else if (data.type === 'note') {
    noteModal(data);
  }
}

async function noteModal(data) {
  const { wrap, close, q } = UI.customModal(`
    <h2>Note</h2>
    <p style="white-space:pre-wrap;line-height:1.5">${UI.escapeHtml(data.text || '(empty)')}</p>
    <div class="row spread">
      <button class="btn small danger" data-a="del">Delete</button>
      <div>
        <button class="btn small" data-a="edit">Edit</button>
        <button class="btn primary small" data-a="close">Close</button>
      </div>
    </div>`);
  q('[data-a=close]').onclick = close;
  q('[data-a=edit]').onclick = async () => {
    close();
    const text = await UI.promptText({ title: 'Edit note', label: 'Note', value: data.text, multiline: true, ok: 'Save' });
    if (text !== null) { data.text = text; await saveCurrentSceneHotspots(); }
  };
  q('[data-a=del]').onclick = async () => {
    close();
    await removeHotspot(data.id);
  };
}

/* ---------- placement flow ---------- */
let placeType = null;
function startPlace(type) {
  const scene = currentScene();
  if (!scene) return;
  placeType = type;
  viewer.setPlaceMode(type);
  const banner = el('placeBanner');
  banner.hidden = false;
  banner.textContent = type === 'nav'
    ? 'Tap where you can walk to (e.g. a doorway) — tap here to cancel'
    : 'Tap the spot to pin a note — tap here to cancel';
}
function cancelPlace() {
  placeType = null;
  viewer.setPlaceMode(null);
  el('placeBanner').hidden = true;
}

async function onPlace(yaw, pitch) {
  const type = placeType;
  cancelPlace();
  const scene = currentScene();
  if (!scene) return;
  scene.hotspots = scene.hotspots || [];

  if (type === 'nav') {
    const others = state.scenes.filter((s) => s.id !== scene.id);
    if (!others.length) { UI.toast('Add another shot first, then link to it.'); return; }
    const items = [];
    for (const s of others) items.push({ id: s.id, label: s.name || 'Untitled', thumb: await blobUrl(s.thumbId) });
    const target = await UI.chooseFromList({ title: 'Walk to which shot?', items });
    if (!target) return;
    scene.hotspots.push({ id: DB.uid('h_'), type: 'nav', yaw, pitch, targetSceneId: target });
    await saveCurrentSceneHotspots();
    UI.toast('Arrow added');
  } else {
    const text = await UI.promptText({ title: 'New note', label: 'Note text', placeholder: 'e.g. Cracked tile — needs repair', multiline: true, ok: 'Add' });
    if (text === null) return;
    scene.hotspots.push({ id: DB.uid('h_'), type: 'note', yaw, pitch, text: text || '' });
    await saveCurrentSceneHotspots();
    UI.toast('Note added');
  }
}

async function saveCurrentSceneHotspots() {
  const scene = currentScene();
  if (!scene) return;
  await DB.putScene(scene);
  viewer.setHotspots(scene.hotspots || []);
  await DB.putProject(state.project);
}

async function removeHotspot(hotspotId) {
  const scene = currentScene();
  if (!scene) return;
  scene.hotspots = (scene.hotspots || []).filter((h) => h.id !== hotspotId);
  await saveCurrentSceneHotspots();
  UI.toast('Removed');
}

/* ---------- gyro / fullscreen ---------- */
async function toggleGyro() {
  const btn = el('btnGyro');
  if (viewer.gyroEnabled) {
    viewer.disableGyro();
    btn.classList.remove('active');
  } else {
    const ok = await viewer.enableGyro();
    if (ok) { btn.classList.add('active'); UI.toast('Move your phone to look around'); }
    else UI.toast('Motion access not available');
  }
}
function toggleFullscreen() {
  const wrap = el('viewerWrap');
  if (!document.fullscreenElement) {
    (wrap.requestFullscreen || wrap.webkitRequestFullscreen || (() => {})).call(wrap);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
  }
  setTimeout(() => viewer && viewer._resize(), 300);
}

/* ============================================================
   Shots grid
   ============================================================ */
async function renderGrid() {
  const grid = el('shotGrid');
  if (!state.scenes.length) {
    grid.innerHTML = `<div class="empty-note" style="grid-column:1/-1">No shots yet.<br/>Tap <strong>+</strong> to import 360° photos.</div>`;
    return;
  }
  grid.innerHTML = '';
  for (const s of state.scenes) {
    const thumb = await blobUrl(s.thumbId);
    const cell = document.createElement('div');
    cell.className = 'shot-cell' + (s.id === state.selectedForMap ? ' selected' : '');
    cell.innerHTML = `
      <div class="sh-thumb" ${thumb ? `style="background-image:url('${thumb}')"` : ''}></div>
      <div class="sh-meta"><div class="sh-name">${UI.escapeHtml(s.name || 'Untitled')}</div><div class="del">⋮</div></div>`;
    cell.querySelector('.sh-thumb').onclick = () => goToScene(s.id);
    cell.querySelector('.sh-name').onclick = () => goToScene(s.id);
    cell.querySelector('.del').onclick = (e) => { e.stopPropagation(); sceneMenu(s); };
    grid.appendChild(cell);
  }
}

async function sceneMenu(scene) {
  const { wrap, close, q } = UI.customModal(`
    <h2>${UI.escapeHtml(scene.name || 'Untitled')}</h2>
    <div class="row spread">
      <button class="btn small" data-a="open">Open</button>
      <button class="btn small" data-a="rename">Rename</button>
      <button class="btn small" data-a="cover">Set as cover</button>
    </div>
    <div class="row spread" style="margin-top:8px">
      <button class="btn small" data-a="view">Set start view</button>
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
  q('[data-a=view]').onclick = async () => {
    close();
    if (scene.id !== state.currentSceneId) { await goToScene(scene.id); }
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
      if (!equirect && !warned) { UI.toast('Heads up: photo isn\'t 2:1 equirectangular — it may look distorted.', 3500); warned = true; }
      const imageId = await DB.putBlob(DB.uid('b_'), full);
      const thumbId = await DB.putBlob(DB.uid('b_'), thumb);
      const scene = {
        id: DB.uid('s_'),
        projectId: state.project.id,
        name: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Shot',
        order: state.scenes.length,
        imageId, thumbId,
        initYaw: 0, initPitch: 0,
        map: null,
        hotspots: [],
      };
      await DB.putScene(scene);
      state.scenes.push(scene);
      if (!state.project.coverSceneId) { state.project.coverSceneId = scene.id; }
      if (!state.currentSceneId) state.currentSceneId = scene.id;
    } catch (err) {
      console.error(err);
      UI.toast(`Couldn't import ${file.name}`);
    }
  }
  await DB.putProject(state.project);
  state.selectedForMap = state.currentSceneId;
  renderGrid();
  await refreshCurrentScene();
  refreshMap();
  UI.toast('Done. Open a shot and tap ➤ to connect the walk.', 3500);
}

async function handleFloorFile(file) {
  el('fileFloor').value = '';
  if (!file || !state.project) return;
  try {
    const { blob } = await processImage(file, 2048);
    if (state.project.floorImageId) await DB.deleteBlob(state.project.floorImageId);
    const id = await DB.putBlob(DB.uid('b_'), blob);
    state.project.floorImageId = id;
    await DB.putProject(state.project);
    urlCache.delete(id);
    refreshMap();
    UI.toast('Floor plan set');
  } catch (e) { UI.toast('Couldn\'t load that image'); }
}

/* ============================================================
   Map
   ============================================================ */
function ensureMap() {
  if (floorMap) return;
  floorMap = new FloorMap(el('mapCanvas'));
  floorMap.onOpenScene = (id) => goToScene(id);
  floorMap.onMoveScene = async (id, pos) => {
    const s = state.scenes.find((x) => x.id === id);
    if (s) { s.map = pos; await DB.putScene(s); }
  };
  floorMap.onPlaceScene = async (id, pos) => {
    const s = state.scenes.find((x) => x.id === id);
    if (s) { s.map = pos; await DB.putScene(s); floorMap.setData(state.scenes, floorMap.floorImage, state.selectedForMap); UI.toast('Placed'); }
  };
}

async function refreshMap() {
  if (!floorMap) return;
  let img = null;
  if (state.project.floorImageId) {
    const url = await blobUrl(state.project.floorImageId);
    if (url) {
      img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
    }
  }
  floorMap.setData(state.scenes, img, state.selectedForMap);
}

/* ============================================================
   Export / import
   ============================================================ */
async function exportProject(id) {
  UI.toast('Preparing export…');
  const data = await DB.exportProject(id);
  const json = JSON.stringify(data);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (data.project.name || 'tour').replace(/[^\w\-]+/g, '_') + '.sitewalk';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function handleImportFile(file) {
  el('fileImport').value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const p = await DB.importProject(data);
    UI.toast('Imported');
    await openProject(p.id);
  } catch (e) {
    console.error(e);
    UI.toast('That file could not be imported');
  }
}

/* -------------------- go -------------------- */
boot();
