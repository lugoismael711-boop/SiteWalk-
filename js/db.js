/* ============================================================
   db.js — IndexedDB persistence layer for SiteWalk
   ------------------------------------------------------------
   Data model
     projects : { id, name, createdAt, updatedAt, floorImageId, coverSceneId }
     scenes   : { id, projectId, name, order, imageId, thumbId,
                  initYaw, initPitch, map:{x,y},
                  hotspots:[{id,type,yaw,pitch,targetSceneId,text}] }
     blobs    : { id, blob }   // full images, thumbnails, floor plans
   ============================================================ */

const DB_NAME = 'sitewalk';
const DB_VERSION = 1;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('scenes')) {
        const s = db.createObjectStore('scenes', { keyPath: 'id' });
        s.createIndex('byProject', 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(store, mode = 'readonly') {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- Blobs ---------- */
export async function putBlob(id, blob) {
  const store = await tx('blobs', 'readwrite');
  await reqAsPromise(store.put({ id, blob }));
  return id;
}
export async function getBlob(id) {
  if (!id) return null;
  const store = await tx('blobs');
  const rec = await reqAsPromise(store.get(id));
  return rec ? rec.blob : null;
}
export async function deleteBlob(id) {
  if (!id) return;
  const store = await tx('blobs', 'readwrite');
  await reqAsPromise(store.delete(id));
}

/* ---------- Projects ---------- */
export async function listProjects() {
  const store = await tx('projects');
  const all = await reqAsPromise(store.getAll());
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
export async function getProject(id) {
  const store = await tx('projects');
  return reqAsPromise(store.get(id));
}
export async function putProject(project) {
  project.updatedAt = Date.now();
  const store = await tx('projects', 'readwrite');
  await reqAsPromise(store.put(project));
  return project;
}
export async function createProject(name) {
  const project = {
    id: uid('p_'),
    name: name || 'Untitled tour',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    floorImageId: null,
    coverSceneId: null,
  };
  return putProject(project);
}
export async function deleteProject(id) {
  const scenes = await listScenes(id);
  for (const sc of scenes) await deleteScene(sc);
  const project = await getProject(id);
  if (project && project.floorImageId) await deleteBlob(project.floorImageId);
  const store = await tx('projects', 'readwrite');
  await reqAsPromise(store.delete(id));
}

/* ---------- Scenes ---------- */
export async function listScenes(projectId) {
  const store = await tx('scenes');
  const idx = store.index('byProject');
  const all = await reqAsPromise(idx.getAll(projectId));
  return all.sort((a, b) => (a.order || 0) - (b.order || 0));
}
export async function getScene(id) {
  const store = await tx('scenes');
  return reqAsPromise(store.get(id));
}
export async function putScene(scene) {
  const store = await tx('scenes', 'readwrite');
  await reqAsPromise(store.put(scene));
  return scene;
}
export async function deleteScene(scene) {
  if (scene.imageId) await deleteBlob(scene.imageId);
  if (scene.thumbId) await deleteBlob(scene.thumbId);
  // Remove hotspots in other scenes that point at this one.
  const siblings = await listScenes(scene.projectId);
  for (const s of siblings) {
    if (s.id === scene.id) continue;
    const before = (s.hotspots || []).length;
    s.hotspots = (s.hotspots || []).filter((h) => h.targetSceneId !== scene.id);
    if (s.hotspots.length !== before) await putScene(s);
  }
  const store = await tx('scenes', 'readwrite');
  await reqAsPromise(store.delete(scene.id));
}

/* ---------- Whole-project export / import ---------- */
export async function exportProject(projectId) {
  const project = await getProject(projectId);
  const scenes = await listScenes(projectId);
  const blobIds = new Set();
  scenes.forEach((s) => { if (s.imageId) blobIds.add(s.imageId); if (s.thumbId) blobIds.add(s.thumbId); });
  if (project.floorImageId) blobIds.add(project.floorImageId);

  const blobs = {};
  for (const id of blobIds) {
    const blob = await getBlob(id);
    if (blob) blobs[id] = await blobToDataURL(blob);
  }
  return { version: 1, project, scenes, blobs };
}

export async function importProject(data) {
  if (!data || !data.project) throw new Error('Not a SiteWalk file.');
  const idMap = {};
  // Re-key blobs to avoid collisions with existing data.
  for (const [oldId, dataUrl] of Object.entries(data.blobs || {})) {
    const newId = uid('b_');
    idMap[oldId] = newId;
    await putBlob(newId, dataURLtoBlob(dataUrl));
  }
  const p = data.project;
  const newProject = {
    ...p,
    id: uid('p_'),
    name: (p.name || 'Imported tour') + ' (imported)',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    floorImageId: idMap[p.floorImageId] || null,
  };
  const sceneIdMap = {};
  const newScenes = (data.scenes || []).map((s) => {
    const nid = uid('s_');
    sceneIdMap[s.id] = nid;
    return { ...s, id: nid, projectId: newProject.id,
      imageId: idMap[s.imageId] || null, thumbId: idMap[s.thumbId] || null };
  });
  // Fix hotspot targets & cover to new scene ids.
  newScenes.forEach((s) => {
    (s.hotspots || []).forEach((h) => {
      if (h.targetSceneId) h.targetSceneId = sceneIdMap[h.targetSceneId] || null;
    });
  });
  newProject.coverSceneId = sceneIdMap[p.coverSceneId] || (newScenes[0] && newScenes[0].id) || null;

  await putProject(newProject);
  for (const s of newScenes) await putScene(s);
  return newProject;
}

/* ---------- helpers ---------- */
export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
export function dataURLtoBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(head)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/* Rough storage estimate for the UI. */
export async function estimateStorage() {
  if (navigator.storage && navigator.storage.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  }
  return null;
}
