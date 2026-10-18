// shared/start-view.js
//
// Start-up shared by the three Tabbies views: the full tab (tabbies.html), the
// mini popup (popup.html) and the side panel (sidepanel.html). It mounts the
// explorer into <main id="explorer">, shows Settings in its place when asked,
// applies the Theme setting, and wires the header buttons, e.g.
// <button data-open="side-panel" data-icon="sidePanel">.
// Each view's own .js file only calls startView() with its preferences.

import { createExplorer } from './explorer.js';
import { createSettings } from './settings.js';
import { icon } from './icons.js';
import * as chromeApi from './chrome-api.js';

/**
 * @param {object} [options]
 * @param {boolean} [options.closeAfterNavigating]  close this page after switching
 *   to a tab or opening another view (what a popup should do)
 * @returns the explorer (see createExplorer)
 */
export function startView({ closeAfterNavigating = false } = {}) {
  followThemeSetting();

  const done = () => {
    if (closeAfterNavigating) window.close();
  };

  const explorerElement = document.getElementById('explorer');
  const explorer = createExplorer(explorerElement, chromeApi, {
    autofocus: location.hash !== '#settings',
    onTabActivated: done,
  });

  // Settings replace the explorer while the address ends in #settings. The ⚙
  // button adds that, so the browser's Back button returns to the tabs.
  const settingsElement = document.createElement('section');
  settingsElement.className = 'settings-view';
  explorerElement.after(settingsElement);
  let settings = null;
  let openedFromTabs = false;

  const showRoute = () => {
    const showSettings = location.hash === '#settings';
    if (showSettings && !settings) settings = createSettings(settingsElement, chromeApi, { onClose: closeSettings });
    if (!showSettings) openedFromTabs = false;
    explorerElement.hidden = showSettings;
    settingsElement.hidden = !showSettings;
    document.querySelector('[data-open="settings"]')?.setAttribute('aria-pressed', String(showSettings));
  };
  function closeSettings() {
    if (openedFromTabs) {
      history.back();
    } else {
      history.replaceState(null, '', location.pathname);
      showRoute();
    }
  }
  window.addEventListener('hashchange', showRoute);
  showRoute();

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
      if (button.dataset.open === 'settings') {
        if (location.hash === '#settings') {
          closeSettings();
        } else {
          openedFromTabs = true;
          location.hash = 'settings';
        }
        return;
      }
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

/**
 * Applies the Theme setting to this page now and whenever it changes, by
 * setting data-theme on <html> (see theme.css). A copy goes to localStorage
 * for theme-boot.js, which applies it before the page is drawn next time.
 */
export function followThemeSetting() {
  const apply = ({ theme }) => {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    else delete root.dataset.theme;
    try {
      localStorage.setItem('tabbies-theme', theme);
    } catch {
      // Not available: the page just follows the setting a moment later.
    }
  };
  chromeApi.readSettings().then(apply);
  chromeApi.onSettingsChanged(apply);
}
