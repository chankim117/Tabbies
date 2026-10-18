// Tabbies background service worker.
//
// In Manifest V3 the extension's background code runs as a *service worker*:
// it has no page or DOM, Chrome starts it when one of its events fires, and
// stops it again after ~30 seconds of inactivity. Because it can be stopped at
// any moment, event listeners must be registered right away at the top level
// of this file (not inside a callback or after an `await`), so Chrome finds
// them every time it wakes the worker up.
//
// Its jobs: make the toolbar icon do what Settings says, and handle the
// keyboard shortcuts.
//
// "type": "module" in manifest.json lets this file import shared code.

import {
  applyFullTabPin,
  applyToolbarAction,
  napAllWindows,
  napTabs,
  napWindow,
  onSettingsChanged,
  openFullTab,
} from './shared/chrome-api.js';

// The "Toolbar icon opens" setting (side panel by default). Applied every
// time the worker starts, so it's right after installs, updates and restarts,
// and again whenever the setting changes.
applyToolbarAction().catch((error) => console.error('Tabbies: could not set up the toolbar icon', error));
onSettingsChanged((settings) => {
  applyToolbarAction(settings).catch((error) => console.error('Tabbies: could not set up the toolbar icon', error));
  // "Keep the Tabbies tab pinned": pin or unpin a Tabbies tab that's already open.
  applyFullTabPin(settings).catch((error) => console.error('Tabbies: could not pin the Tabbies tab', error));
});

// chrome.action.onClicked fires when the toolbar icon is clicked, but only
// while it opens neither a popup nor the side panel: that is the "A full tab"
// setting. `tab` is the active tab of the window whose toolbar was clicked.
chrome.action.onClicked.addListener((tab) => {
  // Clicking it again while on the Tabbies tab goes back to your previous tab.
  openFullTab(tab?.windowId, { toggle: true }).catch((error) => console.error('Tabbies: could not open the Tabbies tab', error));
});

// Keyboard shortcuts ("commands" in manifest.json; keys can be changed at
// chrome://extensions/shortcuts):
//   Alt+T is "_execute_action", Chrome's own shortcut for clicking the Tabbies
//   icon. Chrome handles it, so it always does what the icon does (Settings →
//   Toolbar icon): by default, switch to the Tabbies tab, or back again.
//   Alt+N ("nap-tab") and Alt+W ("nap-current-window") arrive here
//   through chrome.commands.onCommand; `tab` is the active tab of the window
//   they were pressed in.
chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab) return;
  if (command === 'nap-tab') showNapped(napTabs([tab.id]));
  else if (command === 'nap-current-window') showNapped(napWindow(tab.windowId));
});

// ---- Right-click menu on the Tabbies icon --------------------------------------------------
// chrome.contextMenus ("contextMenus" permission) adds items to menus;
// contexts: ['action'] puts them on the menu of the toolbar icon. Menu items
// are remembered by Chrome, so they're created once, when Tabbies is installed
// or updated (chrome.runtime.onInstalled).
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'nap-tab', title: 'Nap this tab', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'nap-window', title: 'Nap all tabs in this window', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'nap-all', title: 'Nap all tabs in every window', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'open-full-tab', title: 'Open Tabbies in a tab', contexts: ['action'] });
  });
});

// `tab` is the active tab of the window whose icon was right-clicked.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'nap-tab' && tab) showNapped(napTabs([tab.id]));
  else if (info.menuItemId === 'nap-window' && tab) showNapped(napWindow(tab.windowId));
  else if (info.menuItemId === 'nap-all') showNapped(napAllWindows());
  else if (info.menuItemId === 'open-full-tab') openFullTab(tab?.windowId).catch(() => {});
});

/**
 * Napping from the shortcut or the icon's menu happens without a Tabbies page
 * to show "Napped 5 tabs · Undo", so the toolbar icon shows the number for a
 * few seconds instead. (Napped tabs can be woken from Naps any time.)
 */
async function showNapped(napping) {
  try {
    const { count } = await napping;
    // chrome.action.setBadgeText puts a short text on the toolbar icon.
    await chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '0' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
  } catch (error) {
    console.error('Tabbies: could not nap', error);
  }
}
