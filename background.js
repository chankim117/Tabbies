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

import { applyToolbarAction, onSettingsChanged, openFullTab, openSidePanel } from './shared/chrome-api.js';

// The "Toolbar icon opens" setting (side panel by default). Applied every
// time the worker starts, so it's right after installs, updates and restarts,
// and again whenever the setting changes.
applyToolbarAction().catch((error) => console.error('Tabbies: could not set up the toolbar icon', error));
onSettingsChanged((settings) => {
  applyToolbarAction(settings).catch((error) => console.error('Tabbies: could not set up the toolbar icon', error));
});

// chrome.action.onClicked fires when the toolbar icon is clicked, but only
// while it opens neither a popup nor the side panel: that is the "A full tab"
// setting. `tab` is the active tab of the window whose toolbar was clicked.
chrome.action.onClicked.addListener((tab) => {
  openFullTab(tab?.windowId).catch((error) => console.error('Tabbies: could not open the Tabbies tab', error));
});

// chrome.commands.onCommand fires for keyboard shortcuts declared under
// "commands" in manifest.json. Users can set or change the keys at
// chrome://extensions/shortcuts. `tab` is the active tab of the focused window.
// ("_execute_action" is handled by Chrome itself: it acts like a click on the icon.)
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-tabbies') {
    // Alt+T: switch to the Tabbies tab, or open one.
    openFullTab(tab?.windowId).catch((error) => console.error('Tabbies: could not open the Tabbies tab', error));
  } else if (command === 'open-side-panel' && tab) {
    // Must be called right here, not after an `await`: Chrome only lets a
    // side panel open as a direct response to the key press.
    openSidePanel(tab.windowId).catch((error) => console.error('Tabbies: could not open the side panel', error));
  }
});
