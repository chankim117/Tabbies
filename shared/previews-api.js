// shared/previews-api.js
//
// Optional page previews (Settings → Page previews, off by default).
//
// Chrome can only take a picture of the tab that is showing in a window
// (chrome.tabs.captureVisibleTab); it can't photograph tabs in the
// background. So while previews are on, background.js takes a small snapshot
// of each page a moment after you switch to it (or after it finishes
// loading), and the hover card shows the last snapshot of a tab when you
// point at it in Tabbies. A tab you haven't looked at since has no preview.
//
// Taking snapshots needs permission to read the pages you visit ("Read and
// change all your data on all websites"), so it's an optional host permission
// in manifest.json, asked for only when you turn the setting on, and given
// back when you turn it off.
//
// Snapshots are kept in chrome.storage.session: in memory only, on this
// computer, forgotten when Chrome closes. Each is a WebP picture of about
// 40-60 KB, sharp at the size the hover card shows it (on high-density
// screens too), and only the most recent ones are kept.

const ORIGINS = ['<all_urls>'];
const CARD_WIDTH = 320; // CSS pixels: how wide the hover card shows a snapshot
const MAX_DENSITY = 2.5; // screen pixels per CSS pixel we keep detail for
const KEEP = 50; // snapshots kept; the oldest go first
const ORDER_KEY = 'previewOrder'; // tab ids, oldest snapshot first
const ERROR_KEY = 'previewError'; // why the last snapshot failed, for Settings
const key = (tabId) => `preview:${tabId}`;

/** Whether Tabbies currently has the permission (it can be taken back at chrome://extensions). */
export function hasPreviewPermission() {
  return chrome.permissions.contains({ origins: ORIGINS });
}

/** How many snapshots are kept, and why the last one failed (if it did). For Settings. */
export async function previewStatus() {
  const { [ORDER_KEY]: order = [], [ERROR_KEY]: lastError = '' } = await chrome.storage.session.get([ORDER_KEY, ERROR_KEY]);
  return { count: order.length, lastError };
}

/** Asks for the permission to take snapshots (call it right in a click handler). */
export function requestPreviewPermission() {
  // chrome.permissions.request with `origins` asks for host permissions
  // listed under "optional_host_permissions"; Chrome shows a prompt.
  return chrome.permissions.request({ origins: ORIGINS });
}

/** Turns previews off: forgets every snapshot and gives the permission back. */
export async function stopPreviews() {
  await clearPreviews();
  // chrome.permissions.remove gives up an optional permission again.
  await chrome.permissions.remove({ origins: ORIGINS }).catch(() => false);
}

/** Forgets every snapshot. */
export async function clearPreviews() {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((name) => name.startsWith('preview:') || name === ORDER_KEY || name === ERROR_KEY);
  if (keys.length > 0) await chrome.storage.session.remove(keys);
}

/**
 * The last snapshot of a tab. `samePage` is false when the tab has moved on
 * to another page of the same site since (sites like YouTube or Gmail change
 * their address as you use them); a snapshot of another site isn't returned.
 * @returns {Promise<{image: string, at: number, samePage: boolean}|null>} image is a data: URL
 */
export async function getPreview(tab) {
  const { [key(tab.id)]: preview } = await chrome.storage.session.get(key(tab.id));
  if (!preview) return null;
  if (samePage(preview.url, tab.url)) return { ...preview, samePage: true };
  return sameSite(preview.url, tab.url) ? { ...preview, samePage: false } : null;
}

/** Takes a snapshot of the tab showing in a window (background.js calls this). */
export async function capturePreview(windowId) {
  const [tab] = await chrome.tabs.query({ windowId, active: true });
  // Only web pages: Chrome doesn't allow pictures of chrome:// pages or other
  // extensions' pages, and incognito tabs are left alone.
  if (!tab || tab.incognito || !/^(https?|file):/.test(tab.url ?? '')) return;
  try {
    // chrome.tabs.captureVisibleTab returns a picture of what the window
    // shows, as a data: URL. Chrome allows only a couple of these per second.
    // PNG, so the picture isn't compressed twice (that makes text blotchy).
    const shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    const [still] = await chrome.tabs.query({ windowId, active: true });
    if (still?.id !== tab.id) return; // you switched tabs while it was being taken
    await save(tab.id, { url: tab.url, image: await shrink(shot, tab.width), at: Date.now() });
    await chrome.storage.session.remove(ERROR_KEY);
  } catch (error) {
    // Kept so Settings can say what's wrong (e.g. the permission is missing).
    await chrome.storage.session.set({ [ERROR_KEY]: String(error?.message ?? error) });
    throw error;
  }
}

/** A tab was closed: its snapshot goes too. */
export async function forgetPreview(tabId) {
  const { [ORDER_KEY]: order = [] } = await chrome.storage.session.get(ORDER_KEY);
  await chrome.storage.session.remove(key(tabId));
  await chrome.storage.session.set({ [ORDER_KEY]: order.filter((id) => id !== tabId) });
}

/** Chrome gave a tab a new id (e.g. when it was put to sleep): keep its snapshot. */
export async function movePreview(fromTabId, toTabId) {
  const { [key(fromTabId)]: preview } = await chrome.storage.session.get(key(fromTabId));
  if (!preview) return;
  await forgetPreview(fromTabId);
  await save(toTabId, preview);
}

async function save(tabId, preview) {
  const { [ORDER_KEY]: order = [] } = await chrome.storage.session.get(ORDER_KEY);
  const next = [...order.filter((id) => id !== tabId), tabId];
  const dropped = next.splice(0, Math.max(0, next.length - KEEP));
  await chrome.storage.session.set({ [key(tabId)]: preview, [ORDER_KEY]: next });
  if (dropped.length > 0) await chrome.storage.session.remove(dropped.map(key));
}

/**
 * Scales a screenshot down to the hover card's size, keeping the screen's
 * pixel density (a 150% display gets 1.5x the pixels), as a WebP data: URL.
 * `cssWidth` is the tab's width in CSS pixels (chrome.tabs.Tab.width).
 */
async function shrink(dataUrl, cssWidth) {
  // These all work in the background service worker, which has no DOM:
  // fetch reads the data: URL and createImageBitmap decodes it.
  const blob = await (await fetch(dataUrl)).blob();
  const full = await createImageBitmap(blob);
  // The screenshot has one pixel per screen pixel, so comparing it with the
  // tab's CSS width tells us the screen's density.
  const density = Math.min(MAX_DENSITY, Math.max(1, cssWidth ? full.width / cssWidth : 1));
  const width = Math.min(full.width, Math.round(CARD_WIDTH * density));
  const height = Math.round((full.height * width) / full.width);
  full.close();
  // resizeQuality 'high' scales smoothly (the default is fast and jagged).
  const bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  const small = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  // Back to a data: URL (storage keeps text, not blobs).
  const bytes = new Uint8Array(await small.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/webp;base64,${btoa(binary)}`;
}

/** Same page, ignoring the #part (which only scrolls within it). */
function samePage(a = '', b = '') {
  return a.split('#')[0] === b.split('#')[0];
}

/** Same site (scheme and host). */
function sameSite(a = '', b = '') {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
