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
//   setTabMuted(tab, muted)           → Promise
//   moveTabs(tabs, target)            → Promise            see MoveTarget below
//   moveGroup(group, target)          → Promise
//   mergeWindow(window, intoWindowId) → Promise
//   sortWindow(windowId, orderId)     → Promise<Layout>    returns the old order, for Undo
//   arrangeWindow(windowId, layout)   → Promise            puts tabs back in a saved order
//   napTabs, wakeNap, … (Naps)        see naps-api.js, re-exported below
//
// Used by the views and background.js:
//   openFullTab(fromWindowId), openSidePanel(windowId), getCurrentWindowId(),
//   getOpenTabbiesShortcut()
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
import { readNaps } from './naps-api.js';
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
  return {
    windows: windows
      .filter((win) => incognitoAllowed || !win.incognito)
      .map((win) => toWindowNode(win, groupsById, currentWindowId)),
    naps,
    settings,
  };
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
    if (areaName === 'local' && ('naps' in changes || 'deviceSettings' in changes || 'napIcons' in changes)) changed();
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
 * window (or the best regular window). Used by the Alt+T shortcut and the
 * "open in a tab" buttons.
 */
export function openFullTab(fromWindowId) {
  // Pressing Alt+T twice quickly could otherwise run two lookups at once and
  // open two Tabbies tabs, so overlapping calls share one in-flight promise.
  openFullTabInFlight ??= focusOrCreateFullTab(fromWindowId).finally(() => {
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

/**
 * Returns the key currently assigned to the "Open Tabbies" command, e.g.
 * "Alt+T", or '' if none. chrome.commands.getAll reports what the user really
 * has: the key can be changed at chrome://extensions/shortcuts, and it is left
 * empty when another extension already uses it.
 */
export async function getOpenTabbiesShortcut() {
  const commands = await chrome.commands.getAll();
  return commands.find((command) => command.name === 'open-tabbies')?.shortcut ?? '';
}

async function focusOrCreateFullTab(fromWindowId) {
  // chrome.tabs.query({}) returns every tab in every window. A tab that hasn't
  // finished its first navigation has its address in `pendingUrl`, not `url`.
  const allTabs = await chrome.tabs.query({});
  const existing = allTabs.filter((tab) => (tab.url || tab.pendingUrl || '').startsWith(TABBIES_URL));
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
  const tab = await chrome.tabs.create({ windowId: target.id, url: TABBIES_URL, active: true });
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

function toWindowNode(win, groupsById, currentWindowId) {
  const children = [];
  let openGroup = null; // the group node that consecutive grouped tabs go into

  for (const tab of win.tabs ?? []) {
    const tabNode = toTabNode(tab);

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

function toTabNode(tab) {
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
  };
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
