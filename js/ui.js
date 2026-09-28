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
      <p><strong>1. Shoot your 360s.</strong> Use the Insta360 app to capture each spot. Stand in the middle of a room or hallway, one shot every few metres.</p>
      <p><strong>2. Export as equirectangular.</strong> In the Insta360 app, export/share each shot as a flat <em>equirectangular</em> photo (the 2:1 "stretched" image) to your phone's photos.</p>
      <p><strong>3. Import here.</strong> Open a tour → <em>Shots</em> → <strong>+</strong>, and pick the photos (several at once is fine).</p>
      <p><strong>4. Connect the walk (two-way).</strong> In a shot, tap <code>➤</code>, tap the floor toward a doorway, pick the shot through it, then turn to the view you'll see when you arrive and hit <em>✓ Set view</em>. SiteWalk creates the arrow <em>and</em> a matching arrow back. Tap a floor arrow to walk; tap <code>↩</code> (top-left) to step back.</p>
      <p><strong>5. Notes with priority.</strong> Tap <code>📌</code>, place it, type the note and pick <span style="color:#ef4444">High</span> / <span style="color:#f59e0b">Medium</span> / <span style="color:#22c55e">Low</span> — the pin takes that color.</p>
      <p><strong>6. Measurements.</strong> Tap <code>📏</code>, tap the two ends of what you measured, and log the number + label. It's stored on the shot with a labeled line.</p>
      <p><strong>7. Delete an arrow.</strong> Long-press a floor arrow to delete it (this direction, or both directions). You can also manage everything from <code>☰</code>.</p>
      <p><strong>8. Manage a stop.</strong> Tap <code>☰</code> to edit/delete any arrow, note or measurement, or to re-set an arrow's arrival view.</p>
      <p><strong>9. Revise a photo.</strong> <em>Shots</em> → ⋮ on a shot → <em>Replace photo</em> keeps all its arrows, notes and floor-plan spot.</p>
      <p><strong>10. Floors.</strong> Use the floor tabs (bookmarks) on <em>Shots</em> and <em>Floor plan</em> to keep each level separate. Tap <em>＋ Floor</em> to add one, then import shots — they land on the floor you're viewing, so levels never get mixed up. Give each floor its own plan image.</p>
      <p><strong>11. Floor plan.</strong> On <em>Floor plan</em>, set that floor's plan image, then place each shot as a dot; tap a dot to jump there.</p>
      <p><strong>12. Punch list PDF.</strong> On <em>Shots</em>, tap <em>Tasks → PDF</em> to export every pinned note as a PDF — each task with a photo of the exact spot, its priority and location.</p>
      <p class="muted tiny">Everything is stored on your phone and works offline. Use ⋮ on a tour to export one file you can back up or send.</p>
      <p class="muted tiny">Note: measurements are the values you record with your own tape/laser (a single 360 photo has no depth to auto-measure). SiteWalk can't control the Insta360 directly, and it doesn't build a 3D dollhouse mesh — it builds a fast, connected 360° walkthrough.</p>
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
