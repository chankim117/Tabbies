// shared/settings-api.js
//
// Tabbies' settings ("storage" permission). Most are kept in
// chrome.storage.sync, which Chrome copies to every computer signed in to the
// same Chrome profile, so you set them up once. A few belong to one computer
// (DEVICE_SETTINGS) and stay in chrome.storage.local.
// Every open Tabbies page and the background worker hear about changes
// through chrome.storage.onChanged, so a change applies everywhere right away.

/** Settings that stay on this computer instead of syncing. */
const DEVICE_SETTINGS = ['syncNaps', 'pagePreviews'];

/** @typedef {typeof DEFAULT_SETTINGS} Settings */
export const DEFAULT_SETTINGS = {
  /** What clicking the Tabbies toolbar icon opens: 'sidePanel' | 'popup' | 'fullTab'. */
  actionOpens: 'fullTab',
  /** 'system' follows the computer's light/dark setting; or 'light' | 'dark'. */
  theme: 'system',
  /** Waking a nap opens its tabs but leaves the nap as it is. */
  keepAfterWaking: false,
  /** Napping a whole window (or every window) includes pinned tabs. */
  napPinned: false,
  /** The full Tabbies tab is kept pinned (at the left of the tab strip, small). */
  pinFullTab: false,
  /** Keep naps in a synced bookmarks folder (this computer only; needs the bookmarks permission). */
  syncNaps: false,
  /** Show a snapshot of the page when you point at a tab (this computer only; needs access to all sites). */
  pagePreviews: false,
};

/** @returns {Promise<Settings>} */
export async function readSettings() {
  const [{ settings: synced }, { deviceSettings = {}, settings: older }] = await Promise.all([
    // chrome.storage.sync.get / .local.get return the values saved under those keys.
    chrome.storage.sync.get('settings'),
    chrome.storage.local.get(['deviceSettings', 'settings']),
  ]);
  // Before syncing, settings were kept locally: start from those once.
  if (!synced && older) {
    await chrome.storage.sync.set({ settings: older });
    await chrome.storage.local.remove('settings');
  }
  return { ...DEFAULT_SETTINGS, ...(synced ?? older), ...deviceSettings };
}

/** Saves some settings, e.g. saveSettings({ theme: 'dark' }). */
export async function saveSettings(changes) {
  await readSettings(); // first moves settings from older versions into place
  // Only settings someone actually picked are stored (not the defaults), so
  // if a default changes in a later version, it reaches everyone who never
  // chose that setting.
  const [{ settings: storedSettings }, { deviceSettings: storedDevice }] = await Promise.all([
    chrome.storage.sync.get('settings'),
    chrome.storage.local.get('deviceSettings'),
  ]);
  const next = { ...storedSettings, ...storedDevice, ...changes };
  const synced = Object.fromEntries(Object.entries(next).filter(([key]) => !DEVICE_SETTINGS.includes(key)));
  const device = Object.fromEntries(Object.entries(next).filter(([key]) => DEVICE_SETTINGS.includes(key)));
  // Listeners hear about each write through chrome.storage.onChanged.
  await Promise.all([chrome.storage.sync.set({ settings: synced }), chrome.storage.local.set({ deviceSettings: device })]);
}

/**
 * Calls `callback(settings)` whenever settings change: on any Tabbies page,
 * or on another computer (arriving through Chrome Sync).
 * @returns {() => void} stops listening
 */
export function onSettingsChanged(callback) {
  const listener = (changes, areaName) => {
    if ((areaName === 'sync' && changes.settings) || (areaName === 'local' && changes.deviceSettings)) {
      readSettings().then(callback);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/**
 * Makes the toolbar icon do what the "actionOpens" setting says. Called by
 * background.js when it starts and whenever the setting changes.
 *   sidePanel: chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
 *              makes Chrome open the side panel itself when the icon is clicked.
 *   popup:     chrome.action.setPopup({ popup: 'popup.html' }) shows the popup.
 *   fullTab:   neither, so Chrome fires chrome.action.onClicked instead, and
 *              background.js opens the Tabbies tab.
 */
export async function applyToolbarAction(settings) {
  const { actionOpens } = settings ?? (await readSettings());
  await chrome.action.setPopup({ popup: actionOpens === 'popup' ? 'popup.html' : '' });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: actionOpens === 'sidePanel' });
}

/** The extension's keyboard shortcuts, as Chrome reports them. */
export async function getShortcuts() {
  // chrome.commands.getAll lists the "commands" from manifest.json with the
  // key each one currently has ('' when none is set).
  const commands = await chrome.commands.getAll();
  return commands.map(({ name, description, shortcut }) => ({ name, description, shortcut: shortcut ?? '' }));
}

/** Opens Chrome's page for changing extension keyboard shortcuts. */
export function openShortcutsPage() {
  // Extensions may open chrome:// pages with chrome.tabs.create.
  return chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
}

/** Tabbies' version number from manifest.json. */
export function getVersion() {
  // chrome.runtime.getManifest returns manifest.json as an object.
  return chrome.runtime.getManifest().version;
}
