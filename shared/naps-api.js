// shared/naps-api.js
//
// Naps: close tabs now, open them later. Napping saves tabs' addresses and titles
// to a list and closes the tabs, freeing their memory; waking opens them
// again.
//
// The lists are kept by one of two stores (naps-store.js): this computer's
// extension storage, or, with Settings → "Sync naps" on, a bookmarks folder
// that Chrome Sync copies to your other computers.
//   Nap  = { id, title, createdAt, color?, links: Link[] }
//          (title '' = named by its date; color = the tab group it came from)
//   Link = { id, url, title, favIconUrl }
// The Naps options (keepAfterWaking, napPinned, syncNaps) are in settings-api.js.
//
// All open Tabbies views hear about changes (chrome.storage.onChanged or
// chrome.bookmarks events, see subscribe() in chrome-api.js) and refresh.
//
// Functions that change things return an "undo" object; pass it to the
// matching undo function to reverse the change.

import { formatNapText, isRestorableUrl, napName, parseNapText } from './nap-data.js';
import { readSettings, saveSettings } from './settings-api.js';
import { bookmarkStore, localStore } from './naps-store.js';
// Waking links at a drop spot reuses the tab-moving code. (chrome-api.js
// imports this file too; that's fine because moveTabs is only used later,
// inside a function, not while the files are loading.)
import { moveTabs } from './chrome-api.js';

const NO_GROUP = -1;
// Tabbies' own pages, e.g. chrome-extension://<id>/tabbies.html
const OWN_PAGES = chrome.runtime.getURL('');
// Empty new tabs aren't worth keeping.
const BLANK_PAGES = ['chrome://newtab/', 'chrome://new-tab-page/', 'about:blank'];

// ---- Reading and writing --------------------------------------------------------------------

/** The store in use: bookmarks while syncing (and allowed to), otherwise this computer. */
async function store() {
  const { syncNaps } = await readSettings();
  // chrome.bookmarks only exists while the optional "bookmarks" permission is granted.
  return syncNaps && chrome.bookmarks ? bookmarkStore : localStore;
}

/** @returns {Promise<{naps: object[]}>} */
export async function readNaps() {
  return { naps: await (await store()).read() };
}

// ---- Syncing through bookmarks -------------------------------------------------------------

/**
 * Asks for the "bookmarks" permission. Chrome only shows the request in direct
 * response to a click, so call this right in the click/change handler.
 * @returns {Promise<boolean>} whether it was granted
 */
export function requestSyncPermission() {
  // chrome.permissions.request asks for a permission listed under
  // "optional_permissions" in manifest.json; Chrome shows the user a prompt.
  return chrome.permissions.request({ permissions: ['bookmarks'] });
}

/**
 * Turns nap syncing on: moves this computer's naps into the synced bookmarks
 * folder (on top of any that arrived from other computers).
 */
export async function startNapSync() {
  const local = await localStore.read();
  for (const [index, nap] of local.entries()) await bookmarkStore.addNap(nap, index);
  await chrome.storage.local.remove('naps');
  await saveSettings({ syncNaps: true });
}

/**
 * Turns nap syncing off: copies the synced naps to this computer and gives
 * the "bookmarks" permission back. The bookmarks folder stays, so your other
 * computers keep their naps; delete it in the bookmark manager if you like.
 */
export async function stopNapSync() {
  if (chrome.bookmarks) {
    const synced = await bookmarkStore.read();
    for (const nap of synced) {
      const links = nap.links.map(({ id, ...link }) => link);
      await localStore.addNap({ ...nap, id: undefined, links }, -1);
    }
  }
  await saveSettings({ syncNaps: false });
  // chrome.permissions.remove gives an optional permission back.
  await chrome.permissions.remove({ permissions: ['bookmarks'] }).catch(() => {});
}

// ---- Napping -------------------------------------------------------------------------------

/**
 * Saves tabs to a nap and closes them. Tabbies' own pages, empty new tabs and
 * incognito tabs are skipped (incognito addresses are never written to disk).
 * @param {number[]} tabIds
 * @param {object} [options]
 * @param {string} [options.intoNapId]  add to the end of this nap instead of making a new one
 * @param {string} [options.title]      name for a new nap ('' = its date)
 * @param {string} [options.color]      tab group color, when napping a whole group
 * @returns {Promise<object|null>} undo info for undoNap(), or null if nothing was napped
 */
export async function napTabs(tabIds, { intoNapId, title = '', color } = {}) {
  // chrome.tabs.get fails for a tab that has closed meanwhile; skip those.
  const tabs = (await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(
    (tab) => tab && isNappable(tab),
  );
  if (tabs.length === 0) return null;

  const naps = await store();
  const groups = await groupsOf(tabs);
  // Save first, then close: if closing fails, the tabs are both open and saved.
  const existing = intoNapId && (await naps.read()).some((nap) => nap.id === intoNapId);
  const links = existing
    ? await naps.appendLinks(intoNapId, tabs.map(toLink))
    : (await naps.addNap({ title, color, createdAt: Date.now(), links: tabs.map(toLink) }, 0)).links;
  // chrome.tabs.remove closes tabs; it takes one id or a list of ids.
  await chrome.tabs.remove(tabs.map((tab) => tab.id));

  return {
    count: tabs.length,
    linkIds: links.map((link) => link.id),
    // Where each tab was, so undoNap() can put it back.
    tabs: tabs.map((tab) => ({
      url: tab.url || tab.pendingUrl,
      windowId: tab.windowId,
      index: tab.index,
      pinned: tab.pinned,
      group: groups.get(tab.groupId) ?? null,
    })),
  };
}

/**
 * Naps the tabs of a window. Pinned tabs stay open unless
 * the "Nap pinned tabs too" setting is on.
 */
export async function napWindow(windowId) {
  const [tabs, { napPinned }] = await Promise.all([chrome.tabs.query({ windowId }), readSettings()]);
  return napTabs(tabs.filter((tab) => napPinned || !tab.pinned).map((tab) => tab.id));
}

/** Naps the tabs of every window into one nap (pinned ones as in napWindow). */
export async function napAllWindows() {
  const [tabs, { napPinned }] = await Promise.all([
    // windowType: 'normal' leaves out popups, app windows and DevTools.
    chrome.tabs.query({ windowType: 'normal' }),
    readSettings(),
  ]);
  return napTabs(tabs.filter((tab) => napPinned || !tab.pinned).map((tab) => tab.id));
}

/** Reverses napTabs(): takes the links out of the nap and reopens the tabs where they were. */
export async function undoNap(undo) {
  await (await store()).removeLinks(undo.linkIds);
  await reopenTabs(undo.tabs);
}

// ---- Waking --------------------------------------------------------------------------------

/**
 * Opens a nap's links again, in their saved order.
 * @param {string} napId
 * @param {object} [options]
 * @param {string[]} [options.linkIds]  only these links (default: all)
 * @param {'here'|'group'|'window'} [options.where]
 *   here: at the end of the current window; group: the same, as one tab group
 *   named after the nap; window: in a new window
 * @param {boolean} [options.activate]  switch to the (first) woken tab
 * @returns {Promise<object|null>} undo info for undoWake()
 */
export async function wakeNap(napId, { linkIds, where = 'here', activate = false } = {}) {
  const [naps, settings] = await Promise.all([store().then((s) => s.read()), readSettings()]);
  const index = naps.findIndex((nap) => nap.id === napId);
  if (index === -1) return null;
  const nap = naps[index];
  const links = linkIds ? nap.links.filter((link) => linkIds.includes(link.id)) : nap.links;
  if (links.length === 0) return null;

  let windowId;
  let opened = [];
  if (where === 'window') {
    // chrome.windows.create opens a new window, here with the first link in it.
    const win = await chrome.windows.create({ url: links[0].url, focused: true });
    windowId = win.id;
    opened = [{ link: links[0], tabId: win.tabs[0].id }];
    opened.push(...(await openLinks(links.slice(1), windowId, false)));
  } else {
    // "Here" is the window this Tabbies view belongs to.
    windowId = (await chrome.windows.getCurrent()).id;
    opened = await openLinks(links, windowId, activate);
  }
  const tabIds = opened.map((item) => item.tabId);

  if (where === 'group' && tabIds.length > 0) {
    // chrome.tabs.group with createProperties makes a new group in that window;
    // chrome.tabGroups.update names and colors it.
    const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title: napName(nap), color: nap.color ?? 'grey' });
  }
  if (activate) await chrome.windows.update(windowId, { focused: true });

  // Links that opened leave the nap (unless the setting says to keep them);
  // a nap with no links left disappears.
  if (!settings.keepAfterWaking) {
    await (await store()).removeLinks(opened.map((item) => item.link.id));
  }
  return { count: tabIds.length, tabIds, before: [{ nap, index }] };
}

/**
 * Wakes links (from one or more naps) right where they were dropped: a spot
 * in a window, a tab group, the end of a window, or a new window. `target` is
 * a MoveTarget (see chrome-api.js); a target without windowId means the
 * current window. With `group`, the woken tabs become a tab group with that
 * { title, color } (used for a nap that was napped from a group).
 * @returns {Promise<object|null>} undo info for undoWake()
 */
export async function wakeLinks(linkIds, target = {}, { group } = {}) {
  const [naps, settings] = await Promise.all([store().then((s) => s.read()), readSettings()]);
  const all = naps.flatMap((nap) => nap.links);
  const links = linkIds.map((id) => all.find((link) => link.id === id)).filter(Boolean);
  if (links.length === 0) return null;
  const before = naps
    .map((nap, index) => ({ nap, index }))
    .filter(({ nap }) => nap.links.some((link) => linkIds.includes(link.id)));

  let windowId;
  let opened;
  if (target.newWindow) {
    const win = await chrome.windows.create({ url: links[0].url, focused: false });
    windowId = win.id;
    opened = [{ link: links[0], tabId: win.tabs[0].id }, ...(await openLinks(links.slice(1), windowId, false))];
  } else {
    windowId = target.windowId ?? (await chrome.windows.getCurrent()).id;
    // Open them at the end of the window, then move them into place with the
    // same code that moves tabs when you drag them (it handles tab groups).
    opened = await openLinks(links, windowId, false);
    const placed =
      target.beforeTabId !== undefined || target.afterTabId !== undefined || (target.groupId ?? NO_GROUP) !== NO_GROUP;
    if (placed) {
      await moveTabs(
        opened.map((item) => ({ id: item.tabId, pinned: false, incognito: false })),
        { ...target, windowId },
      );
    }
  }
  const tabIds = opened.map((item) => item.tabId);

  if (group && tabIds.length > 0 && (target.groupId ?? NO_GROUP) === NO_GROUP) {
    const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title: group.title, color: group.color ?? 'grey' });
  }
  if (!settings.keepAfterWaking) {
    await (await store()).removeLinks(opened.map((item) => item.link.id));
  }
  return { count: tabIds.length, tabIds, before };
}

/** Reverses wakeNap(): closes the woken tabs and puts the nap back as it was. */
export async function undoWake(undo) {
  await chrome.tabs.remove(undo.tabIds).catch(() => {}); // some may be closed already
  await putBackNaps(undo);
}

/** Opens links as tabs at the end of a window. A link that fails to open is skipped. */
async function openLinks(links, windowId, activateFirst) {
  const opened = [];
  for (const link of links) {
    try {
      // chrome.tabs.create opens a new tab; `active: false` keeps you where you are.
      const tab = await chrome.tabs.create({ windowId, url: link.url, active: activateFirst && opened.length === 0 });
      opened.push({ link, tabId: tab.id });
    } catch (error) {
      console.warn('Tabbies: could not open', link.url, error);
    }
  }
  return opened;
}

// ---- Editing -------------------------------------------------------------------------------

/** Deletes some links of a nap, or the whole nap when linkIds is omitted. Returns undo info. */
export async function deleteFromNap(napId, linkIds) {
  const naps = await store();
  const all = await naps.read();
  const index = all.findIndex((nap) => nap.id === napId);
  if (index === -1) return null;
  if (linkIds) await naps.removeLinks(linkIds);
  else await naps.removeNap(napId);
  return { nap: all[index], index };
}

/** Undo for deleteFromNap() and wakeNap(): puts the nap back as it was, at its old place. */
export async function putBackNap({ nap, index }) {
  const naps = await store();
  await naps.removeNap(nap.id); // whatever is left of it
  const count = (await naps.read()).length;
  // (In the bookmarks store the nap gets new ids; nothing refers to the old ones any more.)
  await naps.addNap(nap, Math.min(index, count));
}

/** Deletes links from whichever naps hold them. Returns undo info for putBackNaps(). */
export async function deleteLinks(linkIds) {
  const naps = await store();
  const all = await naps.read();
  const before = all
    .map((nap, index) => ({ nap, index }))
    .filter(({ nap }) => nap.links.some((link) => linkIds.includes(link.id)));
  await naps.removeLinks(linkIds);
  return { before, count: linkIds.length };
}

/** Puts several naps back as they were (undo for deleteLinks and waking). */
export async function putBackNaps({ before }) {
  for (const item of [...before].sort((a, b) => a.index - b.index)) await putBackNap(item);
}

/** Moves links to another spot in the naps: { napId, beforeLinkId? | afterLinkId? } or { newNap: true }. */
export async function moveNapLinks(linkIds, to) {
  await (await store()).moveLinks(linkIds, to);
}

/** Reorders a nap: { beforeNapId } or { afterNapId }. */
export async function moveNap(napId, to) {
  await (await store()).moveNap(napId, to);
}

export async function renameNap(napId, title) {
  await (await store()).rename(napId, title);
}

// ---- Import / export as text --------------------------------------------------------------

/** Adds the lists from text (see nap-data.js) after the existing naps. */
export async function importNaps(text) {
  const lists = parseNapText(text);
  const naps = await store();
  const imported = [];
  for (const list of lists) {
    const links = list.links.map((link) => ({ url: link.url, title: link.title, favIconUrl: '' }));
    imported.push(await naps.addNap({ title: 'Imported', createdAt: Date.now(), links }, -1));
  }
  return {
    lists: imported.length,
    count: imported.reduce((sum, nap) => sum + nap.links.length, 0),
    napIds: imported.map((nap) => nap.id),
  };
}

/** Undo for importNaps(). */
export async function removeImported({ napIds }) {
  const naps = await store();
  for (const id of napIds) await naps.removeNap(id);
}

/** All naps as text. */
export async function exportNaps() {
  const { naps } = await readNaps();
  return formatNapText(naps);
}

// ---- Internals ----------------------------------------------------------------------------

function isNappable(tab) {
  const url = tab.url || tab.pendingUrl || '';
  return !tab.incognito && isRestorableUrl(url) && !url.startsWith(OWN_PAGES) && !BLANK_PAGES.includes(url);
}

function toLink(tab) {
  const url = tab.url || tab.pendingUrl;
  return {
    url,
    title: tab.title || url,
    // Keep web icons only; data: icons can be large and chrome:// ones can't be shown.
    favIconUrl: /^https?:/.test(tab.favIconUrl ?? '') && tab.favIconUrl.length < 1000 ? tab.favIconUrl : '',
  };
}

/** Title and color of the groups these tabs are in, by group id. */
async function groupsOf(tabs) {
  const ids = [...new Set(tabs.map((tab) => tab.groupId).filter((id) => id !== NO_GROUP))];
  // chrome.tabGroups.get returns one group's title, color and collapsed state.
  const groups = await Promise.all(ids.map((id) => chrome.tabGroups.get(id).catch(() => null)));
  return new Map(groups.filter(Boolean).map((g) => [g.id, { id: g.id, title: g.title, color: g.color }]));
}

/**
 * Reopens tabs where they were (for undo): in their old window and position
 * if that window is still open, otherwise together in a new window. Pins and
 * tab groups are restored too. The pages load fresh.
 */
async function reopenTabs(tabs) {
  const byWindow = new Map();
  for (const tab of tabs) byWindow.set(tab.windowId, [...(byWindow.get(tab.windowId) ?? []), tab]);

  for (const [oldWindowId, list] of byWindow) {
    list.sort((a, b) => a.index - b.index);
    // chrome.windows.get fails if the window has closed since.
    const stillOpen = await chrome.windows.get(oldWindowId).catch(() => null);
    const created = [];
    let windowId = oldWindowId;
    for (const tab of list) {
      if (!stillOpen && created.length === 0) {
        const win = await chrome.windows.create({ url: tab.url, focused: false });
        windowId = win.id;
        created.push({ tabId: win.tabs[0].id, saved: tab });
        continue;
      }
      const options = { windowId, url: tab.url, active: false };
      // Back at its old position; Chrome may refuse a spot inside a tab group,
      // in which case it goes at the end and regrouping below fixes it.
      const opened = await chrome.tabs
        .create({ ...options, index: stillOpen ? tab.index : undefined })
        .catch(() => chrome.tabs.create(options));
      created.push({ tabId: opened.id, saved: tab });
    }

    for (const { tabId, saved } of created) {
      if (saved.pinned) await chrome.tabs.update(tabId, { pinned: true });
    }
    // Regroup: into the old group if it still exists, otherwise a new one like it.
    const byGroup = new Map();
    for (const item of created.filter((c) => c.saved.group)) {
      byGroup.set(item.saved.group.id, [...(byGroup.get(item.saved.group.id) ?? []), item]);
    }
    for (const items of byGroup.values()) {
      const { id, title, color } = items[0].saved.group;
      const tabIds = items.map((item) => item.tabId);
      const existing = stillOpen ? await chrome.tabGroups.get(id).catch(() => null) : null;
      if (existing && existing.windowId === windowId) {
        await chrome.tabs.group({ groupId: id, tabIds });
      } else {
        const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
        await chrome.tabGroups.update(groupId, { title, color });
      }
    }
  }
}
