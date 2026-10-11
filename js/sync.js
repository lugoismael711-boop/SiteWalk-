/* ============================================================
   sync.js — optional cloud sync via Firebase (Auth + Firestore + Storage)
   ------------------------------------------------------------
   Opt-in: does nothing unless js/firebase-config.js is filled in.
   The app stays fully local/offline; when signed in, projects and
   their photos sync to the cloud so phone and desktop share one
   account.

   Model (per user uid):
     Firestore  users/{uid}/projects/{projectId}   project doc
                users/{uid}/scenes/{sceneId}        scene doc (has projectId)
     Storage    users/{uid}/blobs/{blobId}          each image/thumb/plan

   Strategy: offline-first, last-write-wins by project.updatedAt.
   Each cycle pulls remote-newer projects then pushes local-newer ones.
   NOTE (v1): deletions are not propagated across devices.
   ============================================================ */

import * as DB from './db.js';
import { FIREBASE_CONFIG, FIREBASE_SDK_VERSION, firebaseEnabled } from './firebase-config.js';

let mods = null;      // loaded Firebase SDK namespaces
let fb = null;        // { app, auth, db, storage }
let user = null;
let running = false;
let autoTimer = null;
let uploaded = new Set(); // blobIds known to be in Storage (per uid)

const listeners = { auth: [], status: [], changed: [] };
export function onAuth(cb) { listeners.auth.push(cb); }
export function onStatus(cb) { listeners.status.push(cb); }
export function onChanged(cb) { listeners.changed.push(cb); }
function emit(kind, arg) { listeners[kind].forEach((cb) => { try { cb(arg); } catch (_) {} }); }

export function available() { return firebaseEnabled(); }
export function currentUser() { return user; }

/* ---------- lazy-load the Firebase SDK from Google's CDN ---------- */
async function loadSdk() {
  if (mods) return mods;
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
  const [app, auth, fs, st] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`),
    import(`${base}/firebase-storage.js`),
  ]);
  mods = { app, auth, fs, st };
  return mods;
}

export async function init() {
  if (!available()) return;
  const m = await loadSdk();
  const app = m.app.initializeApp(FIREBASE_CONFIG);
  const auth = m.auth.getAuth(app);
  const db = m.fs.getFirestore(app);
  const storage = m.st.getStorage(app);
  fb = { app, auth, db, storage };
  m.auth.onAuthStateChanged(auth, (u) => {
    user = u;
    loadUploadedSet();
    emit('auth', u);
    if (u) startAuto(); else stopAuto();
  });
}

/* ---------- auth ---------- */
export async function signUp(email, password) {
  const m = await loadSdk();
  return m.auth.createUserWithEmailAndPassword(fb.auth, email, password);
}
export async function signIn(email, password) {
  const m = await loadSdk();
  return m.auth.signInWithEmailAndPassword(fb.auth, email, password);
}
export async function signInGoogle() {
  const m = await loadSdk();
  const provider = new m.auth.GoogleAuthProvider();
  return m.auth.signInWithPopup(fb.auth, provider);
}
export async function signOutUser() {
  const m = await loadSdk();
  stopAuto();
  return m.auth.signOut(fb.auth);
}

/* ---------- auto sync ---------- */
function startAuto() {
  if (autoTimer) return;
  run();
  autoTimer = setInterval(run, 20000);
  window.addEventListener('focus', run);
}
function stopAuto() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; window.removeEventListener('focus', run); }
}

/* localStorage cache of uploaded blob ids, per user. */
function uploadedKey() { return `sw_uploaded_${user ? user.uid : 'anon'}`; }
function loadUploadedSet() {
  uploaded = new Set();
  try { const raw = localStorage.getItem(uploadedKey()); if (raw) uploaded = new Set(JSON.parse(raw)); } catch (_) {}
}
function saveUploadedSet() {
  try { localStorage.setItem(uploadedKey(), JSON.stringify([...uploaded])); } catch (_) {}
}

const clean = (obj) => JSON.parse(JSON.stringify(obj)); // drop undefined / functions for Firestore

/* ---------- the sync cycle ---------- */
export async function run() {
  if (running || !user || !fb) return;
  running = true; emit('status', 'syncing');
  let changed = false;
  try {
    changed = (await pull()) || changed;
    await push();
    emit('status', 'idle');
    if (changed) emit('changed');
  } catch (e) {
    console.error('[sync] failed', e);
    emit('status', 'error');
  } finally {
    running = false;
  }
}

async function pull() {
  const { fs, st } = mods;
  const uid = user.uid;
  const projSnap = await fs.getDocs(fs.collection(fb.db, `users/${uid}/projects`));
  let changed = false;
  for (const d of projSnap.docs) {
    const rp = d.data();
    const lp = await DB.getProject(rp.id);
    if (lp && (lp.updatedAt || 0) >= (rp.updatedAt || 0)) continue;

    // Scenes for this project.
    const sSnap = await fs.getDocs(fs.query(
      fs.collection(fb.db, `users/${uid}/scenes`), fs.where('projectId', '==', rp.id)));
    const scenes = sSnap.docs.map((x) => x.data());

    // Blobs referenced by this project.
    const blobIds = new Set();
    scenes.forEach((s) => { if (s.imageId) blobIds.add(s.imageId); if (s.thumbId) blobIds.add(s.thumbId); });
    (rp.floors || []).forEach((f) => { if (f.floorImageId) blobIds.add(f.floorImageId); });
    if (rp.floorImageId) blobIds.add(rp.floorImageId);
    for (const bid of blobIds) {
      if (await DB.getBlob(bid)) { uploaded.add(bid); continue; }
      try {
        const ab = await st.getBytes(st.ref(fb.storage, `users/${uid}/blobs/${bid}`));
        await DB.putBlob(bid, new Blob([ab]));
        uploaded.add(bid);
      } catch (e) { console.warn('[sync] blob download failed', bid, e); }
    }
    saveUploadedSet();

    await DB.putProjectRaw(rp);
    for (const s of scenes) await DB.putScene(s);
    changed = true;
  }
  return changed;
}

async function push() {
  const { fs, st } = mods;
  const uid = user.uid;
  const remoteSnap = await fs.getDocs(fs.collection(fb.db, `users/${uid}/projects`));
  const remoteMap = {};
  remoteSnap.forEach((d) => { remoteMap[d.id] = d.data(); });

  const localProjects = await DB.listProjects();
  for (const lp of localProjects) {
    const rp = remoteMap[lp.id];
    if (rp && (rp.updatedAt || 0) >= (lp.updatedAt || 0)) continue;

    const scenes = await DB.listScenes(lp.id);
    const blobIds = new Set();
    scenes.forEach((s) => { if (s.imageId) blobIds.add(s.imageId); if (s.thumbId) blobIds.add(s.thumbId); });
    (lp.floors || []).forEach((f) => { if (f.floorImageId) blobIds.add(f.floorImageId); });
    if (lp.floorImageId) blobIds.add(lp.floorImageId);
    for (const bid of blobIds) {
      if (uploaded.has(bid)) continue;
      const blob = await DB.getBlob(bid);
      if (!blob) continue;
      try { await st.uploadBytes(st.ref(fb.storage, `users/${uid}/blobs/${bid}`), blob); uploaded.add(bid); }
      catch (e) { console.warn('[sync] blob upload failed', bid, e); }
    }
    saveUploadedSet();

    for (const s of scenes) await fs.setDoc(fs.doc(fb.db, `users/${uid}/scenes/${s.id}`), clean(s));
    await fs.setDoc(fs.doc(fb.db, `users/${uid}/projects/${lp.id}`), clean(lp));
  }
}
