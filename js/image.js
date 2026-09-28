/* ============================================================
   image.js — decode, validate and downscale imported photos
   ============================================================ */

// Max texture edge. Most phones/GPUs handle 4096 safely; Insta360 stills are
// often 5760×2880 or larger, which can blow past WebGL limits, so we cap.
const MAX_EDGE = 4096;
const THUMB_W = 480;

function loadImageBitmap(blob) {
  if (window.createImageBitmap) {
    return createImageBitmap(blob).catch(() => loadImageEl(blob));
  }
  return loadImageEl(blob);
}
function loadImageEl(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function drawToBlob(src, w, h, quality = 0.9) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, 0, w, h);
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
  });
}

/**
 * Process a user-picked file into a panorama blob + thumbnail blob.
 * Returns { full, thumb, width, height, equirect }.
 */
export async function processPanorama(file) {
  const src = await loadImageBitmap(file);
  const width = src.width;
  const height = src.height;
  // Equirectangular panoramas are 2:1. Warn (not block) otherwise.
  const ratio = width / height;
  const equirect = ratio > 1.85 && ratio < 2.15;

  // Downscale the full image if needed (keeps 2:1 or original ratio).
  let fw = width, fh = height;
  if (Math.max(fw, fh) > MAX_EDGE) {
    const scale = MAX_EDGE / Math.max(fw, fh);
    fw = Math.round(fw * scale);
    fh = Math.round(fh * scale);
  }
  const full = (fw === width && fh === height && file.type === 'image/jpeg')
    ? file
    : await drawToBlob(src, fw, fh, 0.92);

  const th = Math.round(THUMB_W * (height / width));
  const thumb = await drawToBlob(src, THUMB_W, th, 0.8);

  if (src.close) src.close();
  return { full, thumb, width, height, equirect };
}

/** Process an arbitrary image (floor plan) — just cap size. */
export async function processImage(file, maxEdge = 2048) {
  const src = await loadImageBitmap(file);
  let w = src.width, h = src.height;
  if (Math.max(w, h) > maxEdge) {
    const scale = maxEdge / Math.max(w, h);
    w = Math.round(w * scale); h = Math.round(h * scale);
  }
  const blob = await drawToBlob(src, w, h, 0.9);
  if (src.close) src.close();
  return { blob, width: w, height: h };
}
