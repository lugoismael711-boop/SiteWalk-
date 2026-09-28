/* ============================================================
   ui.js — lightweight modal / toast / prompt helpers
   ============================================================ */

const root = () => document.getElementById('modalRoot');

let _toastTimer = null;
export function toast(msg, ms = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function mount(html) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal">${html}</div>`;
  root().appendChild(wrap);
  // click backdrop to dismiss
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(wrap); });
  return wrap;
}
function close(wrap) { if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap); }

/* Text prompt. Resolves to string or null. */
export function promptText({ title, label = 'Name', value = '', placeholder = '', ok = 'Save', multiline = false }) {
  return new Promise((resolve) => {
    const input = multiline
      ? `<textarea id="_pt" placeholder="${escapeAttr(placeholder)}">${escapeHtml(value)}</textarea>`
      : `<input id="_pt" type="text" value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}" />`;
    const wrap = mount(`
      <h2>${escapeHtml(title)}</h2>
      <div class="field">
        <label>${escapeHtml(label)}</label>
        ${input}
      </div>
      <div class="row">
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="ok">${escapeHtml(ok)}</button>
      </div>`);
    const field = wrap.querySelector('#_pt');
    field.focus();
    if (!multiline) field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { resolve(field.value.trim()); close(wrap); } });
    wrap.querySelector('[data-act=ok]').onclick = () => { resolve(field.value.trim()); close(wrap); };
    wrap.querySelector('[data-act=cancel]').onclick = () => { resolve(null); close(wrap); };
  });
}

/* Confirm dialog. Resolves boolean. */
export function confirmDialog({ title, message, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const wrap = mount(`
      <h2>${escapeHtml(title)}</h2>
      <p class="muted">${escapeHtml(message)}</p>
      <div class="row">
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${escapeHtml(ok)}</button>
      </div>`);
    wrap.querySelector('[data-act=ok]').onclick = () => { resolve(true); close(wrap); };
    wrap.querySelector('[data-act=cancel]').onclick = () => { resolve(false); close(wrap); };
  });
}

/* Generic list chooser. items:[{id,label,thumb}] -> resolves id or null. */
export function chooseFromList({ title, items, empty = 'Nothing to choose.' }) {
  return new Promise((resolve) => {
    const body = items.length
      ? `<div class="list-choice">${items.map((it) => `
          <div class="choice" data-id="${escapeAttr(it.id)}">
            ${it.thumb ? `<div class="c-thumb" style="background-image:url('${it.thumb}')"></div>` : ''}
            <div>${escapeHtml(it.label)}</div>
          </div>`).join('')}</div>`
      : `<p class="muted">${escapeHtml(empty)}</p>`;
    const wrap = mount(`
      <h2>${escapeHtml(title)}</h2>
      ${body}
      <div class="row"><button class="btn" data-act="cancel">Cancel</button></div>`);
    wrap.querySelectorAll('.choice').forEach((c) => {
      c.onclick = () => { resolve(c.dataset.id); close(wrap); };
    });
    wrap.querySelector('[data-act=cancel]').onclick = () => { resolve(null); close(wrap); };
  });
}

/* Custom modal with arbitrary body + buttons. Returns { wrap, close }. */
export function customModal(html) {
  const wrap = mount(html);
  return { wrap, close: () => close(wrap), q: (sel) => wrap.querySelector(sel) };
}

export function showHelp() {
  const wrap = mount(`
    <h2>How SiteWalk works</h2>
    <div class="help-body">
      <p><strong>1. Shoot your 360s.</strong> Use the Insta360 app to capture each spot in your space. Stand in the middle of a room or hallway, one shot every few metres.</p>
      <p><strong>2. Export as equirectangular.</strong> In the Insta360 app, export/share each shot as a flat <em>equirectangular</em> photo (the 2:1 "stretched" image) to your phone's photos.</p>
      <p><strong>3. Import here.</strong> Open a tour → <em>Shots</em> tab → <strong>+</strong>, and pick the photos. You can select several at once.</p>
      <p><strong>4. Connect the walk.</strong> Open a shot, aim at a doorway, tap <code>➤</code> and choose the shot that's through it. Those arrows let you walk the space.</p>
      <p><strong>5. Lay out the floor plan.</strong> On the <em>Floor plan</em> tab, optionally set a floor-plan image, then place each shot as a dot. Tap a dot to jump there.</p>
      <p><strong>6. Add notes.</strong> Tap <code>📌</code> to drop a note on a wall, defect, or piece of equipment.</p>
      <p class="muted tiny">Everything is stored on your phone and works offline. Use the ⋮ menu on a tour to export a single file you can back up or send to someone.</p>
      <p class="muted tiny">Note: SiteWalk can't control the Insta360 camera directly (that's Insta360's own app), and it doesn't build an automatic 3D mesh like Matterport's dollhouse — it builds a fast, connected 360° walkthrough from your photos.</p>
    </div>
    <div class="row"><button class="btn primary" data-act="ok">Got it</button></div>`);
  wrap.querySelector('[data-act=ok]').onclick = () => close(wrap);
}

/* ---------- escaping ---------- */
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
export function escapeAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }
