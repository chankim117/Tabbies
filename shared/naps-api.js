// shared/naps-api.js
//
// Naps: Tabbies' version of OneTab. Napping saves tabs' addresses and titles
// to a list and closes the tabs, freeing their memory; waking opens them
// again. The lists live in chrome.storage.local, the extension's own storage
// on this computer ("storage" permission). Nothing leaves your browser.
//
// chrome.storage.local holds two keys:
//   naps:     Nap[], newest first
//             Nap  = { id, title, createdAt, color?, links: Link[] }
//                    (title '' = named by its date; color = the tab group it came from)
//             Link = { id, url, title, favIconUrl }
//   settings: { keepAfterWaking: boolean }
//
// Every change is a read-modify-write of the whole list. All open Tabbies
// views hear about it through chrome.storage.onChanged (see subscribe() in
// chrome-api.js) and refresh.
//
// Functions that change things return an "undo" object; pass it to the
// matching undo function to reverse the change.

import { formatOneTab, isRestorableUrl, napName, parseOneTab } from './nap-data.js';

const NO_GROUP = -1;
// Tabbies' own pages, e.g. chrome-extension://<id>/tabbies.html
const OWN_PAGES = chrome.runtime.getURL('');
// Empty new tabs aren't worth keeping.
const BLANK_PAGES = ['chrome://newtab/', 'chrome://new-tab-page/', 'about:blank'];

// ---- Reading and writing --------------------------------------------------------------------

/** @returns {Promise<{naps: object[], settings: {keepAfterWaking: boolean}}>} */
export async function readNaps() {
  // chrome.storage.local.get returns the stored values for the keys asked for
  // (missing keys are simply absent, hence the defaults).
  const { naps = [], settings = {} } = await chrome.storage.local.get(['naps', 'settings']);
  return { naps, settings: { keepAfterWaking: false, ...settings } };
}

async function writeNaps(naps) {
  // chrome.storage.local.set saves values (as JSON) under their keys.
  await chrome.storage.local.set({ naps });
}

export async function setNapSettings(changes) {
  const { settings } = await readNaps();
  await chrome.storage.local.set({ settings: { ...settings, ...changes } });
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

  const links = tabs.map(toLink);
  const { naps } = await readNaps();
  const into = intoNapId ? naps.findIndex((nap) => nap.id === intoNapId) : -1;
  const next =
    into === -1
      ? [{ id: crypto.randomUUID(), title, color, createdAt: Date.now(), links }, ...naps]
      : naps.with(into, { ...naps[into], links: [...naps[into].links, ...links] });

  // Save first, then close: if closing fails, the tabs are both open and saved.
  const groups = await groupsOf(tabs);
  await writeNaps(next);
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

/** Naps every unpinned tab of a window (pinned tabs are kept, like in OneTab). */
export async function napWindow(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  return napTabs(tabs.filter((tab) => !tab.pinned).map((tab) => tab.id));
}

/** Naps every unpinned tab in every window, into one nap. */
export async function napAllWindows() {
  // windowType: 'normal' leaves out popups, app windows and DevTools.
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  return napTabs(tabs.filter((tab) => !tab.pinned).map((tab) => tab.id));
}

/** Reverses napTabs(): takes the links out of the nap and reopens the tabs where they were. */
export async function undoNap(undo) {
  await removeLinks(undo.linkIds);
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
  const { naps, settings } = await readNaps();
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
    const wokenIds = new Set(opened.map((item) => item.link.id));
    const remaining = nap.links.filter((link) => !wokenIds.has(link.id));
    await writeNaps(remaining.length > 0 ? naps.with(index, { ...nap, links: remaining }) : naps.toSpliced(index, 1));
  }
  return { count: tabIds.length, tabIds, nap, index };
}

/** Reverses wakeNap(): closes the woken tabs and puts the nap back as it was. */
export async function undoWake(undo) {
  await chrome.tabs.remove(undo.tabIds).catch(() => {}); // some may be closed already
  await putBackNap(undo);
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
  const { naps } = await readNaps();
  const index = naps.findIndex((nap) => nap.id === napId);
  if (index === -1) return null;
  const nap = naps[index];
  const remaining = linkIds ? nap.links.filter((link) => !linkIds.includes(link.id)) : [];
  await writeNaps(remaining.length > 0 ? naps.with(index, { ...nap, links: remaining }) : naps.toSpliced(index, 1));
  return { nap, index };
}

/** Undo for deleteFromNap(): puts the nap back exactly as it was. */
export async function putBackNap({ nap, index }) {
  const { naps } = await readNaps();
  const at = naps.findIndex((other) => other.id === nap.id);
  await writeNaps(at === -1 ? naps.toSpliced(Math.min(index, naps.length), 0, nap) : naps.with(at, nap));
}

export async function renameNap(napId, title) {
  const { naps } = await readNaps();
  await writeNaps(naps.map((nap) => (nap.id === napId ? { ...nap, title } : nap)));
}

// ---- OneTab import / export ----------------------------------------------------------------

/** Adds the lists from OneTab text (see nap-data.js) after the existing naps. */
export async function importOneTab(text) {
  const lists = parseOneTab(text);
  const now = Date.now();
  const imported = lists.map((list) => ({
    id: crypto.randomUUID(),
    title: 'Imported from OneTab',
    createdAt: now,
    links: list.links.map((link) => ({ id: crypto.randomUUID(), url: link.url, title: link.title, favIconUrl: '' })),
  }));
  if (imported.length > 0) {
    const { naps } = await readNaps();
    await writeNaps([...naps, ...imported]);
  }
  return {
    lists: imported.length,
    count: imported.reduce((sum, nap) => sum + nap.links.length, 0),
    napIds: imported.map((nap) => nap.id),
  };
}

/** Undo for importOneTab(). */
export async function removeImported({ napIds }) {
  const { naps } = await readNaps();
  await writeNaps(naps.filter((nap) => !napIds.includes(nap.id)));
}

/** All naps as OneTab text. */
export async function exportOneTab() {
  const { naps } = await readNaps();
  return formatOneTab(naps);
}

// ---- Internals ----------------------------------------------------------------------------

function isNappable(tab) {
  const url = tab.url || tab.pendingUrl || '';
  return !tab.incognito && isRestorableUrl(url) && !url.startsWith(OWN_PAGES) && !BLANK_PAGES.includes(url);
}

function toLink(tab) {
  const url = tab.url || tab.pendingUrl;
  return {
    id: crypto.randomUUID(),
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

/** Removes links (by id) from whichever naps hold them; emptied naps disappear. */
async function removeLinks(linkIds) {
  const ids = new Set(linkIds);
  const { naps } = await readNaps();
  await writeNaps(
    naps
      .map((nap) => ({ ...nap, links: nap.links.filter((link) => !ids.has(link.id)) }))
      .filter((nap) => nap.links.length > 0),
  );
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
