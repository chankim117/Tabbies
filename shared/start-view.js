// shared/start-view.js
//
// Start-up shared by the three Tabbies views: the full tab (tabbies.html), the
// mini popup (popup.html) and the side panel (sidepanel.html). It mounts the
// explorer into <main id="explorer"> and wires the header buttons that switch
// to another view, e.g. <button data-open="side-panel" data-icon="sidePanel">.
// Each view's own .js file only calls startView() with its preferences.

import { createExplorer } from './explorer.js';
import { icon } from './icons.js';
import * as chromeApi from './chrome-api.js';

/**
 * @param {object} [options]
 * @param {boolean} [options.closeAfterNavigating]  close this page after switching
 *   to a tab or opening another view (what a popup should do)
 * @returns the explorer (see createExplorer)
 */
export function startView({ closeAfterNavigating = false } = {}) {
  const done = () => {
    if (closeAfterNavigating) window.close();
  };

  const explorer = createExplorer(document.getElementById('explorer'), chromeApi, {
    autofocus: true,
    onTabActivated: done,
  });

  // chrome.sidePanel.open only works as a direct response to a click, so we
  // can't look up the window id *after* the click; keep it ready beforehand.
  // (Refreshed on focus because a Tabbies tab can be dragged to another window.)
  let windowId;
  const rememberWindow = async () => {
    windowId = await chromeApi.getCurrentWindowId();
  };
  rememberWindow();
  window.addEventListener('focus', rememberWindow);

  for (const button of document.querySelectorAll('[data-open]')) {
    button.prepend(icon(button.dataset.icon));
    button.addEventListener('click', async () => {
      try {
        // Both calls start before the first `await`, while the click still counts.
        if (button.dataset.open === 'side-panel') await chromeApi.openSidePanel(windowId);
        else await chromeApi.openFullTab(windowId);
        done();
      } catch (error) {
        console.error('Tabbies: could not open that view', error);
      }
    });
  }

  return explorer;
}
