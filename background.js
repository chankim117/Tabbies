// Tabbies background service worker.
//
// In Manifest V3 the extension's background code runs as a *service worker*:
// it has no page or DOM, Chrome starts it when one of its events fires, and
// stops it again after ~30 seconds of inactivity. Because it can be stopped at
// any moment, event listeners must be registered right away at the top level
// of this file (not inside a callback or after an `await`), so Chrome finds
// them every time it wakes the worker up.
//
// The toolbar icon needs no code here: manifest.json's "default_popup" makes
// Chrome open popup.html by itself. This worker only handles keyboard shortcuts.
//
// "type": "module" in manifest.json lets this file import shared code.

import { openFullTab, openSidePanel } from './shared/chrome-api.js';

// chrome.commands.onCommand fires for keyboard shortcuts declared under
// "commands" in manifest.json. Users can set or change the keys at
// chrome://extensions/shortcuts. `tab` is the active tab of the focused window.
// ("_execute_action", the popup shortcut, is handled by Chrome itself.)
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
