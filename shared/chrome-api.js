// shared/chrome-api.js
//
// Every Chrome API call Tabbies makes lives in this file. The explorer UI
// (explorer.js, drag-drop.js) never calls chrome.* itself: it only sees the
// plain objects returned here and calls the functions below. That split lets
// the same explorer run in all three views (full tab, popup, side panel), and
// later be fed from a saved tab list.
//
// Used by the explorer:
//   getSnapshot()                     → Promise<Snapshot>  windows → groups → tabs, as plain data
//   subscribe(onChange)               → unsubscribe()      calls onChange (debounced) on any change
//   activateTab(tab)                  → Promise            switch to a tab and focus its window
//   closeTab(tab)                     → Promise
//   duplicateTabs(tabs)               → Promise<ids>       copies, for undoDuplicate(ids)
//   openNewTab({ windowId, afterTabId }), openNewWindow()
//   setTabsPinned(tabs, pinned), reloadTabs(tabs), sleepTabs(tabs), sleepOtherTabs(windowId)
//   closeDuplicates(windowId?)        → Promise<undo>      for undoClose()
//   setTabMuted(tab, muted)           → Promise
//   moveTabs(tabs, target)            → Promise            see MoveTarget below
//   groupTabs(tabs)                   → Promise<undo>      puts tabs in a new tab group
//   undoGroup(undo), renameGroup(groupId, title), recolorGroup(groupId, color)
//   ungroup(groupId), ungroupTabs(tabIds) → Promise<undo>  for undoUngroup()
//   recolorGroups(groupIds, color)
//   moveGroup(group, target)          → Promise
//   mergeWindow(window, intoWindowId) → Promise
//   sortWindow(windowId, orderId)     → Promise<Layout>    returns the old order, for Undo
//   arrangeWindow(windowId, layout)   → Promise            puts tabs back in a saved order
//   napTabs, wakeNap, … (Naps)        see naps-api.js, re-exported below
//
// Used by the views and background.js:
//   openFullTab(fromWindowId), openSidePanel(windowId), getCurrentWindowId(),
//   getShortcut(commandName)
//
// Data shapes (plain objects, not chrome.tabs.Tab):
//
// @typedef {object} TabNode
// @property {'tab'} kind
// @property {number} id
// @property {number} windowId
// @property {number} groupId     -1 when the tab isn't in a group
// @property {string} title
// @property {string} url
// @property {string} favIconUrl  may be empty, or a URL the page can't load
// @property {boolean} active     the selected tab of its window
// @property {boolean} pinned
// @property {boolean} audible    currently playing sound
// @property {boolean} muted
// @property {boolean} discarded  "asleep": Chrome unloaded it to save memory
// @property {boolean} incognito
// @property {boolean} highlighted  multi-selected in Chrome's tab strip (Ctrl+click there)
// @property {number} copies      how many open tabs show this same page (1 = no duplicates)
//
// @typedef {object} GroupNode
// @property {'group'} kind
// @property {number} id
// @property {number} windowId
// @property {string} title       may be empty (Chrome allows unnamed groups)
// @property {string} color       grey | blue | red | yellow | green | pink | purple | cyan | orange
// @property {TabNode[]} tabs
//
// @typedef {object} WindowNode
// @property {'window'} kind
// @property {number} id
// @property {boolean} isCurrent  the window this Tabbies view belongs to
// @property {boolean} incognito
// @property {number} tabCount
// @property {Array<GroupNode|TabNode>} children  in tab-strip order
//
// @typedef {object} Snapshot
// @property {WindowNode[]} windows
// @property {object[]} naps         saved lists, see naps-api.js
// @property {object} settings       see settings-api.js
//
// @typedef {object} MoveTarget  Where moveTab / moveGroup put things. One of:
//   { windowId }               at the end of that window
//   { windowId, beforeTabId }  just before that tab
//   { windowId, afterTabId }   just after that tab
//   { newWindow: true }        into a brand-new window
// For moveTabs, `groupId` says which group the tabs end up in (-1 = none).
//
// @typedef {Array<{groupId: number, tabIds: number[]}>} Layout
//   A window's unpinned tabs from left to right, as blocks: each block is one
//   tab group, or a run of ungrouped tabs (groupId -1).

import { SORT_ORDERS } from './sorting.js';
import { closeTabs, readNaps } from './naps-api.js';
import { readSettings } from './settings-api.js';

// Naps (tabs closed and saved for later) and settings live in their own files; the
// pages get them through this module like everything else.
export * from './naps-api.js';
export * from './settings-api.js';

const TABBIES_URL = chrome.runtime.getURL('tabbies.html');

// chrome.tabGroups.TAB_GROUP_ID_NONE: the groupId of tabs that aren't in a group.
const NO_GROUP = -1;

// A quiet period of REFRESH_DELAY_MS ends a burst of events; during a long
// burst (e.g. restoring a session) we still refresh every REFRESH_MAX_DELAY_MS.
const REFRESH_DELAY_MS = 100;
const REFRESH_MAX_DELAY_MS = 400;

// chrome.tabs.onUpdated fires many times while a page loads (status,
// title, favicon, ...). Only these properties change what the tree shows.
const DISPLAYED_TAB_PROPERTIES = [
  'title',
  'url',
  'favIconUrl',
  'pinned',
  'audible',
  'mutedInfo',
  'discarded',
  'groupId',
];

// ---- Reading tabs ------------------------------------------------------------------

/**
 * Reads all windows, tab groups and tabs and returns them as a tree.
 * @returns {Promise<Snapshot>}
 */
export async function getSnapshot() {
  const [windows, groups, currentWindowId, incognitoAllowed, { naps }, settings] = await Promise.all([
    // chrome.windows.getAll lists the open windows. `populate: true` includes
    // each window's tabs (chrome.tabs.Tab objects, already in tab-strip order).
    // The "tabs" permission is what makes each tab's url, title and favIconUrl
    // readable. windowTypes: ['normal'] skips popups, app windows and DevTools.
    chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
    // chrome.tabGroups.query({}) lists every tab group ("tabGroups" permission).
    // Tabs only carry a groupId, so names and colors come from here.
    chrome.tabGroups.query({}),
    getCurrentWindowId().catch(() => null),
    isIncognitoAllowed(),
    readNaps(),
    readSettings(),
  ]);

  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const shown = windows.filter((win) => incognitoAllowed || !win.incognito);
  const names = await windowNamesFor(shown);
  // How many tabs show each page, so duplicates can be marked.
  const copies = new Map();
  for (const tab of shown.flatMap((win) => win.tabs ?? [])) {
    const key = duplicateKey(tab);
    if (key) copies.set(key, (copies.get(key) ?? 0) + 1);
  }
  return {
    windows: shown.map((win) => ({ ...toWindowNode(win, groupsById, currentWindowId, copies), name: names.get(win.id) ?? '' })),
    naps,
    settings,
  };
}

// ---- Window names ---------------------------------------------------------------------------
//
// Chrome doesn't let extensions read or set the names from its own "Name
// window…" menu, so Tabbies keeps its own, in chrome.storage.local:
//   windowNames: { [windowId]: { name, urls, seen } }
// Window ids change every time Chrome restarts. So each name also remembers
// its window's tab addresses, and a window Tabbies doesn't know yet gets the
// name whose addresses match its tabs best (at least half of them). After a
// restart, Chrome brings the same tabs back, so the names follow.

const NAME_MATCH = 0.5; // share of tabs that must match to reattach a name
const NAME_KEEP_DAYS = 30; // names of windows not seen for this long are forgotten

/** Sets (or, with '', removes) the name of a window. */
export async function renameWindow(windowId, name) {
  const { windowNames = {} } = await chrome.storage.local.get('windowNames');
  if (name) {
    const tabs = await windowTabs(windowId);
    windowNames[windowId] = { name, urls: tabs.map(tabUrl).slice(0, 100), seen: Date.now() };
  } else {
    delete windowNames[windowId];
  }
  await chrome.storage.local.set({ windowNames });
}

/** Map of window id → name, for the given (open) windows. */
async function windowNamesFor(windows) {
  const { windowNames: stored = {} } = await chrome.storage.local.get('windowNames');
  // Skip anything damaged (no name, or no list of addresses) rather than fail.
  const windowNames = Object.fromEntries(
    Object.entries(stored).filter(([, entry]) => entry && typeof entry.name === 'string' && entry.name && Array.isArray(entry.urls)),
  );
  let changed = Object.keys(windowNames).length !== Object.keys(stored).length;
  const open = new Set(windows.map((win) => String(win.id)));
  // Names whose window isn't open: closed, or from before a restart.
  const unclaimed = new Map(Object.entries(windowNames).filter(([id]) => !open.has(id)));
  const names = new Map();

  for (const win of windows) {
    const urls = (win.tabs ?? []).map(tabUrl).slice(0, 100);
    let entry = windowNames[win.id];
    if (!entry) {
      // Is this a named window from before Chrome restarted?
      let bestId = null;
      let bestScore = NAME_MATCH;
      for (const [id, old] of unclaimed) {
        const score = overlap(urls, old.urls);
        if (score >= bestScore) [bestId, bestScore] = [id, score];
      }
      if (bestId === null) continue;
      entry = unclaimed.get(bestId);
      unclaimed.delete(bestId);
      delete windowNames[bestId];
      changed = true;
    }
    names.set(win.id, entry.name);
    // Keep its addresses up to date for the next restart.
    if (urls.join('\n') !== entry.urls.join('\n') || windowNames[win.id] !== entry) changed = true;
    windowNames[win.id] = { name: entry.name, urls, seen: Date.now() };
  }

  // Forget names of windows that haven't been around for a long time.
  for (const [id, entry] of unclaimed) {
    if (Date.now() - (entry.seen ?? 0) > NAME_KEEP_DAYS * 86_400_000) {
      delete windowNames[id];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ windowNames });
  return names;
}

function tabUrl(tab) {
  return tab.url || tab.pendingUrl || '';
}

/** Share of addresses two windows have in common: 0 (none) to 1 (all). */
function overlap(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  const set = new Set(b);
  return a.filter((url) => set.has(url)).length / Math.max(a.length, b.length);
}

/**
 * The window this page belongs to: the window holding the Tabbies tab, or the
 * window a popup or side panel is attached to.
 */
export async function getCurrentWindowId() {
  // chrome.windows.getCurrent returns "the window this code is running in".
  const win = await chrome.windows.getCurrent();
  return win.id;
}

/**
 * Calls `onChange` whenever tabs, groups or windows change. Calls are
 * debounced, so a burst of events (closing a window with 30 tabs fires 30+
 * events) leads to a single refresh.
 * @param {() => void} onChange
 * @returns {() => void} call to stop listening
 */
export function subscribe(onChange) {
  const changed = debounce(onChange, REFRESH_DELAY_MS, REFRESH_MAX_DELAY_MS);

  const tabUpdated = (tabId, changeInfo) => {
    // changeInfo only contains the properties that changed in this update.
    if (DISPLAYED_TAB_PROPERTIES.some((property) => property in changeInfo)) changed();
  };

  // chrome.storage.onChanged fires when any page of the extension saves
  // something, e.g. the popup napping tabs while the full tab is open.
  // chrome.storage.sync changes can also arrive from another computer.
  const storageChanged = (changes, areaName) => {
    if (areaName === 'sync' && 'settings' in changes) changed();
    if (areaName === 'local' && ['naps', 'deviceSettings', 'napIcons', 'windowNames'].some((key) => key in changes)) {
      changed();
    }
  };

  // While naps sync through bookmarks, bookmark changes (here, or arriving
  // through Chrome Sync from another computer) can change the naps.
  // chrome.bookmarks only exists while the optional "bookmarks" permission is
  // granted, so these listeners are added whenever it is (chrome.permissions.onAdded).
  const bookmarkListeners = [];
  const listenToBookmarks = () => {
    if (!chrome.bookmarks || bookmarkListeners.length > 0) return;
    for (const event of [
      chrome.bookmarks.onCreated,
      chrome.bookmarks.onRemoved,
      chrome.bookmarks.onChanged,
      chrome.bookmarks.onMoved,
      chrome.bookmarks.onChildrenReordered,
    ]) {
      event.addListener(changed);
      bookmarkListeners.push(event);
    }
  };
  const permissionsChanged = () => {
    listenToBookmarks();
    changed();
  };
  listenToBookmarks();

  // Each chrome.*.onXxx object is an event: addListener(fn) starts calling fn
  // when the event fires, removeListener(fn) stops it. Listeners added from an
  // extension page like this one live as long as the page is open.
  const listeners = [
    [chrome.tabs.onCreated, changed], // a tab was opened
    [chrome.tabs.onRemoved, changed], // a tab was closed
    [chrome.tabs.onUpdated, tabUpdated], // title, URL, favicon, sound, pin, sleep or group changed
    [chrome.tabs.onMoved, changed], // a tab moved within its window
    [chrome.tabs.onAttached, changed], // a tab was moved into a window...
    [chrome.tabs.onDetached, changed], // ...out of another window
    [chrome.tabs.onActivated, changed], // a different tab became the selected one
    [chrome.tabs.onReplaced, changed], // Chrome swapped a tab for a new one (e.g. when it sleeps)
    [chrome.tabGroups.onCreated, changed],
    [chrome.tabGroups.onUpdated, changed], // renamed, recolored, collapsed in the tab strip
    [chrome.tabGroups.onMoved, changed],
    [chrome.tabGroups.onRemoved, changed],
    [chrome.windows.onCreated, changed],
    [chrome.windows.onRemoved, changed],
    [chrome.storage.onChanged, storageChanged], // naps or settings changed
    [chrome.permissions.onAdded, permissionsChanged], // nap sync was turned on...
    [chrome.permissions.onRemoved, permissionsChanged], // ...or off
  ];
  for (const [event, listener] of listeners) event.addListener(listener);

  return function unsubscribe() {
    for (const [event, listener] of listeners) event.removeListener(listener);
    for (const event of bookmarkListeners) event.removeListener(changed);
    changed.cancel();
  };
}

// ---- Tab actions --------------------------------------------------------------------

/** Switches to `tab` and brings its window to the front. */
export async function activateTab(tab) {
  // chrome.tabs.update with `active: true` selects the tab in its window...
  await chrome.tabs.update(tab.id, { active: true });
  // ...and chrome.windows.update with `focused: true` raises that window.
  await chrome.windows.update(tab.windowId, { focused: true });
}

/** Closes `tab`. chrome.tabs.remove accepts one tab id or an array of ids. */
export function closeTab(tab) {
  return chrome.tabs.remove(tab.id);
}

/**
 * Duplicates tabs: each copy opens right after its original, with the same
 * page and back/forward history. The tab you're looking at stays the same.
 * @returns {Promise<number[]>} ids of the copies, for undoDuplicate()
 */
export async function duplicateTabs(tabs) {
  const copies = [];
  for (const windowId of new Set(tabs.map((tab) => tab.windowId))) {
    await keepingActiveTab(windowId, async () => {
      for (const tab of tabs.filter((t) => t.windowId === windowId)) {
        // chrome.tabs.duplicate copies a tab (and selects the copy, which
        // keepingActiveTab undoes).
        const copy = await chrome.tabs.duplicate(tab.id);
        if (copy) copies.push(copy.id);
      }
    });
  }
  return copies;
}

/** Pins or unpins tabs. Pinned tabs move to the start of their window (and leave their group). */
export async function setTabsPinned(tabs, pinned) {
  // chrome.tabs.update with `pinned` pins or unpins one tab.
  for (const tab of tabs) await chrome.tabs.update(tab.id, { pinned });
}

/** Reloads tabs. chrome.tabs.reload loads the page again (like pressing F5). */
export async function reloadTabs(tabs) {
  for (const tab of tabs) await chrome.tabs.reload(tab.id);
}

/**
 * Puts tabs to sleep: chrome.tabs.discard unloads a tab to free memory but
 * keeps it in the tab strip; it loads again when you switch to it. The tab
 * you're looking at in each window can't sleep, and tabs playing sound are
 * left awake. (Chrome gives a sleeping tab a new id.)
 * @returns {Promise<{count: number, skipped: number}>}
 */
export async function sleepTabs(tabs) {
  let count = 0;
  let skipped = 0;
  for (const tab of tabs) {
    const now = await chrome.tabs.get(tab.id).catch(() => null);
    if (!now || now.discarded) continue;
    if (now.active || now.audible) {
      skipped++;
      continue;
    }
    if (await chrome.tabs.discard(now.id).catch(() => null)) count++;
    else skipped++;
  }
  return { count, skipped };
}

/** Puts every tab of a window to sleep except the one you're looking at (and ones playing sound). */
export async function sleepOtherTabs(windowId) {
  const tabs = await chrome.tabs.query({ windowId, active: false, discarded: false });
  return sleepTabs(tabs.filter((tab) => !tab.audible));
}

/**
 * Closes duplicate tabs (the same page open more than once): in one window,
 * or everywhere when no window is given. For each page one tab stays open:
 * a pinned one, else the one you're looking at, else the first one.
 * @returns {Promise<object>} undo info for undoClose()
 */
export async function closeDuplicates(windowId) {
  const tabs = await chrome.tabs.query(windowId === undefined ? { windowType: 'normal' } : { windowId });
  const byPage = new Map();
  for (const tab of tabs) {
    const key = duplicateKey(tab);
    if (!key) continue;
    byPage.set(key, [...(byPage.get(key) ?? []), tab]);
  }
  const extra = [];
  for (const same of byPage.values()) {
    if (same.length < 2) continue;
    const keep = same.find((tab) => tab.pinned) ?? same.find((tab) => tab.active) ?? same[0];
    extra.push(...same.filter((tab) => tab !== keep).map((tab) => tab.id));
  }
  return extra.length > 0 ? closeTabs(extra) : { count: 0, tabs: [] };
}

/** Closes the copies made by duplicateTabs(). */
export async function undoDuplicate(copyIds) {
  const open = (await Promise.all(copyIds.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
  if (open.length > 0) await chrome.tabs.remove(open.map((tab) => tab.id));
}

/**
 * Opens a new tab (Chrome's New Tab page) and switches to it: at the end of
 * a window, or right after a tab (joining that tab's group, if any).
 */
export async function openNewTab({ windowId, afterTabId } = {}) {
  let index;
  let groupId = NO_GROUP;
  if (afterTabId !== undefined) {
    const after = await chrome.tabs.get(afterTabId);
    windowId = after.windowId;
    index = after.index + 1;
    groupId = after.groupId;
  }
  // chrome.tabs.create with no url opens the New Tab page.
  const tab = await chrome.tabs.create({ windowId, index, active: true });
  if (groupId !== NO_GROUP) await chrome.tabs.group({ groupId, tabIds: [tab.id] });
  await chrome.windows.update(tab.windowId, { focused: true });
  return tab;
}

/** Opens a new, empty browser window (with a New Tab page) and switches to it. */
export async function openNewWindow() {
  await chrome.windows.create({ focused: true });
}

/**
 * Mutes or unmutes just this tab. (Chrome's own right-click "Mute site" mutes
 * every tab of that site instead.)
 */
export function setTabMuted(tab, muted) {
  return chrome.tabs.update(tab.id, { muted });
}

// ---- Moving tabs, groups and windows --------------------------------------------------
//
// Moving never reloads anything: chrome.tabs.move, chrome.tabGroups.move and
// chrome.windows.create({ tabId }) all carry the live page over, with its
// scroll position, form contents and sound.
//
// Two Chrome quirks are smoothed over here:
// - A pinned tab that moves to another window arrives unpinned, so we pin it again.
// - chrome.tabGroups.move into another window makes the group's tab the active
//   one there, so we switch that window back to the tab you were looking at.

/**
 * Moves one or more tabs (e.g. a Ctrl/Shift-click selection) to one spot,
 * keeping them in the order given. See MoveTarget at the top of this file.
 * Pinned tabs stay pinned: if the selection mixes pinned and unpinned tabs,
 * the unpinned ones go to the drop spot and the pinned ones to the end of the
 * target window's pinned tabs (pinned tabs can't be in groups).
 * @param {TabNode[]} tabs
 * @param {object} target
 */
export async function moveTabs(tabs, target) {
  if (target.newWindow) {
    await moveTabsToNewWindow(tabs);
    return;
  }

  const unpinned = tabs.filter((tab) => !tab.pinned);
  const pinned = tabs.filter((tab) => tab.pinned);
  const toSpot = unpinned.length > 0 ? unpinned : pinned;

  // The first tab goes to the drop spot, each next one right after the one
  // before, so they arrive as a block in their original order.
  let spot = target;
  for (const tab of toSpot) {
    await moveOneTab(tab, spot);
    spot = { windowId: target.windowId, afterTabId: tab.id, groupId: target.groupId };
  }
  if (toSpot !== pinned) {
    for (const tab of pinned) await moveOneTab(tab, { windowId: target.windowId });
  }
}

async function moveTabsToNewWindow(tabs) {
  const [first, ...rest] = tabs;
  // chrome.windows.create with `tabId` moves that existing tab into a new
  // window. `focused: false` leaves you where you are, so you can keep
  // organizing. Incognito tabs can only live in incognito windows.
  const win = await chrome.windows.create({ tabId: first.id, focused: false, incognito: first.incognito });
  if (rest.length > 0) {
    await chrome.tabs.move(rest.map((tab) => tab.id), { windowId: win.id, index: -1 });
  }
  for (const tab of tabs) {
    if (tab.pinned) await chrome.tabs.update(tab.id, { pinned: true });
  }
}

async function moveOneTab(tab, target) {
  const anchorId = target.beforeTabId ?? target.afterTabId;
  const groupId = target.groupId ?? NO_GROUP;

  if (groupId !== NO_GROUP) {
    // Chrome refuses to drop a tab into the middle of a group, so first add
    // it to the group (at the end), then move it to its spot inside the group.
    await addToGroup(tab.id, groupId);
    if (anchorId !== undefined && anchorId !== tab.id) {
      await chrome.tabs.move(tab.id, { index: await tabIndexFor(tab.id, target) });
    }
    return;
  }

  if (anchorId !== tab.id) {
    // chrome.tabs.move moves tabs within a window or to another window.
    // `index` is the position the tab ends up at; -1 means "at the end".
    await chrome.tabs.move(tab.id, { windowId: target.windowId, index: await tabIndexFor(tab.id, target) });
  }

  if (tab.pinned && !(await chrome.tabs.get(tab.id)).pinned) {
    // It lost its pin moving windows. chrome.tabs.update({ pinned: true })
    // pins it at the end of the pinned tabs; then put it back by its anchor.
    await chrome.tabs.update(tab.id, { pinned: true });
    if (anchorId !== undefined) await chrome.tabs.move(tab.id, { index: await tabIndexFor(tab.id, target) });
  }

  // A tab moved right next to its old group can still be in it.
  // chrome.tabs.ungroup takes it out (an emptied group disappears).
  if ((await chrome.tabs.get(tab.id)).groupId !== NO_GROUP) await chrome.tabs.ungroup(tab.id);
}

/** Adds a tab to a group from wherever it is (any window), at the group's end. */
async function addToGroup(tabId, groupId) {
  if ((await chrome.tabs.get(tabId)).groupId === groupId) return;
  const groupTabs = await chrome.tabs.query({ groupId });
  const last = groupTabs.reduce((a, b) => (b.index > a.index ? b : a));
  // Right after the group's last tab is the group's edge, which Chrome allows...
  await chrome.tabs.move(tabId, {
    windowId: last.windowId,
    index: await tabIndexFor(tabId, { afterTabId: last.id }),
  });
  // ...and chrome.tabs.group with `groupId` then adds it to that group.
  await chrome.tabs.group({ groupId, tabIds: [tabId] });
}

/**
 * Puts tabs (e.g. a Ctrl/Shift-click selection) into a new, unnamed tab group,
 * gathered next to the first one, in its window, in the order given. Pinned
 * tabs get unpinned, as Chrome doesn't allow pinned tabs in groups.
 * @param {TabNode[]} tabs
 * @returns {Promise<object|null>} { groupId, count, places } for undoGroup()
 */
export async function groupTabs(tabs) {
  // Read the tabs fresh: they may have moved since the explorer's snapshot.
  const fresh = (await Promise.all(tabs.map((tab) => chrome.tabs.get(tab.id).catch(() => null)))).filter(Boolean);
  if (fresh.length === 0) return null;
  const [first] = fresh;
  // Tabs can't move between incognito and regular windows.
  const together = fresh.filter((tab) => tab.incognito === first.incognito);
  const places = together.map((tab) => ({
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    pinned: tab.pinned,
    groupId: tab.groupId,
  }));

  let groupId;
  await keepingActiveTab(first.windowId, async () => {
    for (const tab of together) {
      if (tab.pinned) await chrome.tabs.update(tab.id, { pinned: false });
    }
    // Line the others up right after the first tab...
    let afterTabId = first.id;
    for (const tab of together.slice(1)) {
      await moveOneTab({ ...tab, pinned: false }, { windowId: first.windowId, afterTabId });
      afterTabId = tab.id;
    }
    // ...then chrome.tabs.group (no groupId) makes a new group of them and
    // returns its id. Chrome picks the group's color.
    groupId = await chrome.tabs.group({ tabIds: together.map((tab) => tab.id) });
  });
  return { groupId, count: together.length, places };
}

/** Reverses groupTabs(): takes the tabs out of the group and puts each back where it was. */
export async function undoGroup(undo) {
  const alive = (await Promise.all(undo.places.map((place) => chrome.tabs.get(place.id).catch(() => null)))).filter(Boolean);
  const aliveIds = new Set(alive.map((tab) => tab.id));
  if (aliveIds.size === 0) return;
  // chrome.tabs.ungroup takes tabs out of their group (an emptied group disappears).
  await chrome.tabs.ungroup([...aliveIds]);

  const windowIds = new Set((await chrome.windows.getAll()).map((win) => win.id));
  const newWindowFor = new Map(); // a window that has closed since → its replacement
  // Lowest positions first, so each move leaves the earlier ones in place.
  const places = undo.places.filter((place) => aliveIds.has(place.id)).sort((a, b) => a.index - b.index);
  for (const place of places) {
    let windowId = windowIds.has(place.windowId) ? place.windowId : newWindowFor.get(place.windowId);
    if (windowId === undefined) {
      // All of that window's tabs were grouped away, so Chrome closed it.
      windowId = (await chrome.windows.create({ tabId: place.id, focused: false })).id;
      newWindowFor.set(place.windowId, windowId);
    }
    if (place.pinned) await chrome.tabs.update(place.id, { pinned: true });
    const groupStillThere = place.groupId !== NO_GROUP && (await chrome.tabGroups.get(place.groupId).catch(() => null));
    if (groupStillThere) {
      await addToGroup(place.id, place.groupId);
      await chrome.tabs.move(place.id, { index: place.index }).catch(() => {});
    } else {
      // A spot inside someone else's group is refused; the tab then stays near by.
      await chrome.tabs.move(place.id, { windowId, index: place.index }).catch(() => {});
    }
  }
}

/** Sets a tab group's name ('' for none). chrome.tabGroups.update changes a group's title or color. */
export async function renameGroup(groupId, title) {
  await chrome.tabGroups.update(groupId, { title });
}

/** Sets a tab group's color: grey, blue, red, yellow, green, pink, purple, cyan or orange. */
export async function recolorGroup(groupId, color) {
  await chrome.tabGroups.update(groupId, { color });
}

/** Sets the color of several tab groups at once (e.g. the groups of the selected tabs). */
export async function recolorGroups(groupIds, color) {
  for (const groupId of groupIds) await chrome.tabGroups.update(groupId, { color });
}

/** Dissolves a tab group: its tabs stay open where they are, just not grouped. */
export async function ungroup(groupId) {
  // chrome.tabs.query with `groupId` lists the tabs of one group.
  return ungroupTabs((await chrome.tabs.query({ groupId })).map((tab) => tab.id));
}

/**
 * Takes tabs out of their groups (tabs not in a group are left alone). A group
 * that loses all its tabs disappears.
 * @returns {Promise<object>} { count, groups } for undoUngroup()
 */
export async function ungroupTabs(tabIds) {
  const tabs = (await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => null))))
    .filter((tab) => tab && tab.groupId !== NO_GROUP)
    .sort((a, b) => a.index - b.index);
  if (tabs.length === 0) return { count: 0, groups: [] };
  // Remember each group's name and color, and where each tab was, for Undo.
  // chrome.tabGroups.get returns a group's title and color.
  const groups = new Map();
  for (const tab of tabs) {
    if (!groups.has(tab.groupId)) {
      const group = await chrome.tabGroups.get(tab.groupId);
      groups.set(tab.groupId, { groupId: tab.groupId, title: group.title, color: group.color, tabs: [] });
    }
    groups.get(tab.groupId).tabs.push({ id: tab.id, index: tab.index });
  }
  // chrome.tabs.ungroup takes tabs out of their group. Chrome moves a tab
  // from the middle of a group to just outside it.
  await chrome.tabs.ungroup(tabs.map((tab) => tab.id));
  return { count: tabs.length, groups: [...groups.values()] };
}

/** Reverses ungroupTabs(): back into the same group, or a new one with the same name and color. */
export async function undoUngroup(undo) {
  for (const group of undo.groups) {
    const alive = (await Promise.all(group.tabs.map((t) => chrome.tabs.get(t.id).catch(() => null)))).filter(Boolean);
    if (alive.length === 0) continue;
    const stillThere = await chrome.tabGroups.get(group.groupId).catch(() => null);
    if (stillThere) {
      // Only some of its tabs were taken out: put each back in its old spot.
      for (const saved of group.tabs) {
        if (!alive.some((tab) => tab.id === saved.id)) continue;
        await addToGroup(saved.id, group.groupId);
        await chrome.tabs.move(saved.id, { index: saved.index }).catch(() => {});
      }
    } else {
      const groupId = await chrome.tabs.group({ tabIds: alive.map((tab) => tab.id) });
      await chrome.tabGroups.update(groupId, { title: group.title, color: group.color });
    }
  }
}

/**
 * Moves a whole tab group, keeping its name, color and tab order.
 * @param {GroupNode} group
 * @param {object} target  MoveTarget (groupId is ignored)
 */
export async function moveGroup(group, target) {
  if (target.newWindow) {
    await moveGroupToNewWindow(group);
    return;
  }
  const index = await groupIndexFor(group.id, target);
  await keepingActiveTab(target.windowId, () =>
    // chrome.tabGroups.move moves a group within its window or to another one.
    // Groups can't be placed among pinned tabs or inside another group.
    chrome.tabGroups.move(group.id, { windowId: target.windowId, index }),
  );
}

/**
 * Moves every tab of `win` to the end of another window. Each group moves as a
 * whole and each run of ungrouped tabs moves together, so the tabs keep their
 * original order and grouping. Pinned tabs stay pinned, after the target
 * window's own pinned tabs. Chrome closes the emptied window by itself.
 * @param {WindowNode} win
 * @param {number} intoWindowId
 */
export async function mergeWindow(win, intoWindowId) {
  // chrome.windows.get with `populate: true` returns the window with its tabs.
  const source = await chrome.windows.get(win.id, { populate: true });
  const pinnedIds = source.tabs.filter((tab) => tab.pinned).map((tab) => tab.id);

  await keepingActiveTab(intoWindowId, async () => {
    for (const block of tabBlocks(source.tabs)) {
      if (block.groupId !== NO_GROUP) {
        await chrome.tabGroups.move(block.groupId, { windowId: intoWindowId, index: -1 });
      } else {
        // chrome.tabs.move also accepts an array: the tabs stay in that order.
        await chrome.tabs.move(block.tabIds, { windowId: intoWindowId, index: -1 });
      }
    }
  });
  // Pinning them again, in their old order, lines them up after the pinned
  // tabs already in the window.
  for (const id of pinnedIds) await chrome.tabs.update(id, { pinned: true });
}

// ---- Sorting a window ---------------------------------------------------------------------

/**
 * Sorts the tabs of one window (see sorting.js for the orders). Groups stay
 * together and keep their order: tabs are sorted inside each group, and the
 * ungrouped tabs are sorted and placed after the groups. Pinned tabs don't move.
 * @returns {Promise<Layout>} the order before sorting, for arrangeWindow (Undo)
 */
export async function sortWindow(windowId, orderId) {
  const { compare } = SORT_ORDERS.find((order) => order.id === orderId);
  const blocks = tabBlocks((await windowTabs(windowId)).filter((tab) => !tab.pinned));
  const sortedIds = (tabs) => [...tabs].sort(compare).map((tab) => tab.id);

  const groups = blocks
    .filter((block) => block.groupId !== NO_GROUP)
    .map((block) => ({ groupId: block.groupId, tabIds: sortedIds(block.tabs) }));
  const ungrouped = blocks.filter((block) => block.groupId === NO_GROUP).flatMap((block) => block.tabs);

  await arrangeWindow(windowId, [...groups, { groupId: NO_GROUP, tabIds: sortedIds(ungrouped) }]);
  return blocks.map(({ groupId, tabIds }) => ({ groupId, tabIds }));
}

/**
 * Puts a window's unpinned tabs into the order given by `layout`, block by
 * block from left to right. Each group is moved as a whole first and then
 * its tabs are ordered inside it, so no tab ever leaves or joins a group on
 * the way. Tabs that were closed, pinned or regrouped since are skipped.
 * @param {number} windowId
 * @param {Layout} layout
 */
export async function arrangeWindow(windowId, layout) {
  await keepingActiveTab(windowId, async () => {
    const tabs = await windowTabs(windowId);
    const byId = new Map(tabs.map((tab) => [tab.id, tab]));
    let index = tabs.filter((tab) => tab.pinned).length; // pinned tabs stay at the front

    for (const block of layout) {
      const ids = block.tabIds.filter((id) => byId.get(id)?.groupId === block.groupId && !byId.get(id).pinned);
      if (ids.length === 0) continue;
      if (block.groupId !== NO_GROUP) {
        await chrome.tabGroups.move(block.groupId, { index });
        await chrome.tabs.move(ids, { index });
        index += tabs.filter((tab) => tab.groupId === block.groupId).length;
      } else {
        await chrome.tabs.move(ids, { index });
        index += ids.length;
      }
    }
  });
}

/** A window's tabs in tab-strip order. */
async function windowTabs(windowId) {
  // chrome.tabs.query({ windowId }) lists one window's tabs; `index` is each
  // tab's position in the tab strip.
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.sort((a, b) => a.index - b.index);
}

/** Runs `work`, then re-selects whichever tab was active in `windowId` before. */
async function keepingActiveTab(windowId, work) {
  // chrome.tabs.query with `active: true` finds the selected tab of a window.
  const [active] = await chrome.tabs.query({ windowId, active: true });
  await work();
  if (active) await chrome.tabs.update(active.id, { active: true });
}

/** Where `tabId` has to be moved to so it lands just before/after the anchor tab. */
async function tabIndexFor(tabId, target) {
  const anchorId = target.beforeTabId ?? target.afterTabId;
  if (anchorId === undefined) return -1;

  // chrome.tabs.get returns a tab's current state, including its `index`
  // (position in its window). We read it now, not from the explorer's last
  // snapshot, because tabs may have moved since.
  const [anchor, tab] = await Promise.all([chrome.tabs.get(anchorId), chrome.tabs.get(tabId)]);
  let index = target.beforeTabId !== undefined ? anchor.index : anchor.index + 1;
  // Within one window, `index` is where the tab ends up *after* being taken
  // out of its old spot, so a tab moving right shifts the target left by one.
  if (tab.windowId === anchor.windowId && tab.index < index) index -= 1;
  return index;
}

/** Same as tabIndexFor, for a whole group (which shifts by its size). */
async function groupIndexFor(groupId, target) {
  const anchorId = target.beforeTabId ?? target.afterTabId;
  if (anchorId === undefined) return -1;

  // chrome.tabs.query({ groupId }) lists the tabs in a group.
  const [anchor, groupTabs] = await Promise.all([chrome.tabs.get(anchorId), chrome.tabs.query({ groupId })]);
  const first = Math.min(...groupTabs.map((tab) => tab.index));
  let index = target.beforeTabId !== undefined ? anchor.index : anchor.index + 1;
  if (groupTabs[0].windowId === anchor.windowId && first < index) index -= groupTabs.length;
  return index;
}

async function moveGroupToNewWindow(group) {
  const tabs = (await chrome.tabs.query({ groupId: group.id })).sort((a, b) => a.index - b.index);
  // chrome.tabGroups.get returns a group's title, color and collapsed state.
  const { title, color } = await chrome.tabGroups.get(group.id);
  const [first, ...rest] = tabs;

  // A new window can only be created around one existing tab, which leaves
  // that tab's group. So: start the window with the first tab...
  const win = await chrome.windows.create({ tabId: first.id, focused: false, incognito: first.incognito });
  if (rest.length > 0) {
    // ...move the rest of the group in after it, still as a group...
    await chrome.tabGroups.move(group.id, { windowId: win.id, index: -1 });
    // ...and add the first tab back in front of it.
    const { groupId } = await chrome.tabs.get(rest[0].id);
    await chrome.tabs.group({ groupId, tabIds: [first.id] });
  } else {
    // A one-tab group vanished when its only tab left: rebuild it in the new window.
    const groupId = await chrome.tabs.group({ tabIds: [first.id], createProperties: { windowId: win.id } });
    // chrome.tabGroups.update sets a group's title, color or collapsed state.
    await chrome.tabGroups.update(groupId, { title, color });
  }
}

/** Splits a window's tabs into blocks: each group, and each run of ungrouped tabs. */
function tabBlocks(tabs) {
  const blocks = [];
  for (const tab of tabs) {
    const last = blocks.at(-1);
    if (last && last.groupId === tab.groupId) {
      last.tabs.push(tab);
      last.tabIds.push(tab.id);
    } else {
      blocks.push({ groupId: tab.groupId, tabs: [tab], tabIds: [tab.id] });
    }
  }
  return blocks;
}

// ---- Opening the Tabbies views --------------------------------------------------------

let openFullTabInFlight = null;

/**
 * Switches to the Tabbies tab if one is open, otherwise opens one in the given
 * window (or the best regular window). Used by the "Open Tabbies in a tab" shortcut and the
 * "open in a tab" buttons.
 */
export function openFullTab(fromWindowId, { toggle = false } = {}) {
  // Pressing the shortcut twice quickly could otherwise run two lookups at once and
  // open two Tabbies tabs, so overlapping calls share one in-flight promise.
  openFullTabInFlight ??= focusOrCreateFullTab(fromWindowId, toggle).finally(() => {
    openFullTabInFlight = null;
  });
  return openFullTabInFlight;
}

/**
 * Opens Tabbies in Chrome's side panel of the given window. The panel's page is
 * set by "side_panel" in manifest.json. Chrome only allows this as a direct
 * response to a user action (a click or a keyboard shortcut), so call it right
 * away in the event handler, before any `await`.
 */
export function openSidePanel(windowId) {
  return chrome.sidePanel.open({ windowId });
}

/** Closes Tabbies' side panel in that window, if it's open there. */
export async function closeSidePanel(windowId) {
  // chrome.sidePanel.close (Chrome 141+) closes the extension's side panel;
  // it fails when the panel isn't open, which is fine here.
  await chrome.sidePanel.close?.({ windowId }).catch(() => {});
}

/**
 * The key currently assigned to one of the "commands" in manifest.json, e.g.
 * "Alt+T", or '' if none. chrome.commands.getAll reports what the user really
 * has: keys can be changed at chrome://extensions/shortcuts, and a suggested
 * key is left empty when another extension already uses it.
 */
export async function getShortcut(commandName) {
  const commands = await chrome.commands.getAll();
  return commands.find((command) => command.name === commandName)?.shortcut ?? '';
}

/**
 * Pins or unpins every open Tabbies tab to match Settings → "Keep the Tabbies
 * tab pinned". background.js calls this when the setting changes.
 */
export async function applyFullTabPin(settings) {
  const { pinFullTab } = settings ?? (await readSettings());
  const tabs = (await chrome.tabs.query({})).filter((tab) => (tab.url || tab.pendingUrl || '').startsWith(TABBIES_URL));
  for (const tab of tabs) {
    // chrome.tabs.update with `pinned` pins or unpins a tab.
    if (tab.pinned !== pinFullTab) await chrome.tabs.update(tab.id, { pinned: pinFullTab });
  }
}

async function focusOrCreateFullTab(fromWindowId, toggle) {
  // chrome.tabs.query({}) returns every tab in every window. A tab that hasn't
  // finished its first navigation has its address in `pendingUrl`, not `url`.
  const allTabs = await chrome.tabs.query({});
  const isTabbies = (tab) => (tab.url || tab.pendingUrl || '').startsWith(TABBIES_URL);
  const existing = allTabs.filter(isTabbies);

  // Clicking the icon (or Alt+T) while already looking at Tabbies "closes" it:
  // you go back to the tab you came from. chrome.storage.session keeps that
  // tab's id until Chrome quits (it survives the background script sleeping).
  const here = allTabs.find((tab) => tab.windowId === fromWindowId && tab.active);
  if (toggle && here && isTabbies(here)) {
    const { tabbiesCameFrom } = await chrome.storage.session.get('tabbiesCameFrom');
    const previous =
      allTabs.find((tab) => tab.id === tabbiesCameFrom) ??
      // Otherwise the tab used most recently: `lastAccessed` is when a tab
      // was last the active one (milliseconds, Chrome 121+).
      allTabs
        .filter((tab) => tab.windowId === fromWindowId && !isTabbies(tab))
        .sort((x, y) => (y.lastAccessed ?? 0) - (x.lastAccessed ?? 0))[0];
    if (previous) await activateTab(previous);
    return;
  }
  if (here && !isTabbies(here)) await chrome.storage.session.set({ tabbiesCameFrom: here.id });

  if (existing.length > 0) {
    // Prefer a Tabbies tab in the window the user is in, otherwise the first one.
    const tab = existing.find((t) => t.windowId === fromWindowId) ?? existing[0];
    await activateTab(tab);
    return;
  }

  // Extension pages can't open inside incognito windows (Chrome's default
  // "spanning" incognito mode), so Tabbies always goes into a regular window:
  // the one the user is in if possible, else the focused one, else any.
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const regular = windows.filter((w) => !w.incognito);
  const target = regular.find((w) => w.id === fromWindowId) ?? regular.find((w) => w.focused) ?? regular[0];

  if (!target) {
    // No regular window is open, so chrome.windows.create opens a new one.
    await chrome.windows.create({ url: TABBIES_URL, focused: true });
    return;
  }
  // chrome.tabs.create opens a new tab; `active: true` selects it.
  // Pinned right away if Settings → "Keep the Tabbies tab pinned" is on.
  const { pinFullTab } = await readSettings();
  const tab = await chrome.tabs.create({ windowId: target.id, url: TABBIES_URL, active: true, pinned: pinFullTab });
  await activateTab(tab);
}

// ---- Internals ----------------------------------------------------------------------------

let incognitoAllowedPromise = null;

function isIncognitoAllowed() {
  // chrome.extension.isAllowedIncognitoAccess tells us whether the user turned
  // on "Allow in Incognito" for Tabbies. Chrome already hides incognito windows
  // from extensions that aren't allowed in them; checking here keeps the rule
  // explicit. Changing that setting reloads the extension, so asking once is enough.
  incognitoAllowedPromise ??= chrome.extension.isAllowedIncognitoAccess();
  return incognitoAllowedPromise;
}

function toWindowNode(win, groupsById, currentWindowId, copies) {
  const children = [];
  let openGroup = null; // the group node that consecutive grouped tabs go into

  for (const tab of win.tabs ?? []) {
    const tabNode = toTabNode(tab, copies);

    if (tab.groupId === NO_GROUP) {
      openGroup = null;
      children.push(tabNode);
      continue;
    }

    // Chrome always keeps a group's tabs next to each other in the tab strip,
    // so a group starts at its first tab and ends where the groupId changes.
    if (openGroup?.id !== tab.groupId) {
      const group = groupsById.get(tab.groupId);
      openGroup = {
        kind: 'group',
        id: tab.groupId,
        windowId: win.id,
        title: group?.title ?? '',
        color: group?.color ?? 'grey',
        tabs: [],
      };
      children.push(openGroup);
    }
    openGroup.tabs.push(tabNode);
  }

  return {
    kind: 'window',
    id: win.id,
    isCurrent: win.id === currentWindowId,
    incognito: win.incognito,
    tabCount: win.tabs?.length ?? 0,
    children,
  };
}

function toTabNode(tab, copies) {
  return {
    kind: 'tab',
    id: tab.id,
    windowId: tab.windowId,
    groupId: tab.groupId,
    // A tab that is still loading may not have a title yet.
    title: tab.title || tab.url || tab.pendingUrl || 'New Tab',
    url: tab.url || tab.pendingUrl || '',
    favIconUrl: tab.favIconUrl || '',
    active: tab.active,
    pinned: tab.pinned,
    audible: Boolean(tab.audible),
    // mutedInfo also says *why* a tab is muted (user, capture, extension).
    muted: Boolean(tab.mutedInfo?.muted),
    discarded: tab.discarded,
    incognito: tab.incognito,
    highlighted: tab.highlighted,
    copies: copies?.get(duplicateKey(tab)) ?? 1,
  };
}

/**
 * Which page a tab shows, for spotting duplicates: its address without the
 * #part (which only scrolls within a page). New Tab pages and Tabbies itself
 * don't count.
 */
function duplicateKey(tab) {
  const url = tab.url || tab.pendingUrl || '';
  if (!url || url.startsWith(TABBIES_URL) || /^chrome:\/\/(newtab|new-tab-page)\/?$/.test(url) || url === 'about:blank') return '';
  return url.split('#')[0];
}

/**
 * Returns a function that runs `fn` once calls have stopped for `wait` ms, but
 * no later than `maxWait` ms after the first call of a burst.
 */
function debounce(fn, wait, maxWait) {
  let timer = null;
  let burstStart = 0;

  function run() {
    timer = null;
    burstStart = 0;
    fn();
  }

  function debounced() {
    const now = Date.now();
    if (!burstStart) burstStart = now;
    clearTimeout(timer);
    timer = setTimeout(run, Math.min(wait, maxWait - (now - burstStart)));
  }

  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
    burstStart = 0;
  };
  return debounced;
}
