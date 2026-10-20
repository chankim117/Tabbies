// shared/settings.js
//
// The Settings page. Like the explorer it is a component with no chrome.*
// calls of its own: everything goes through `api` (chrome-api.js). It shows
// inside any Tabbies view (the ⚙ button in the header, see start-view.js)
// and as Chrome's Options page for Tabbies (settings.html).
//
// Changes are saved the moment you make them; there is no Save button.

import { h } from './dom.js';
import { icon } from './icons.js';
import { readTipState, resetTips, setTipsOn } from './tip-state.js';

/**
 * @param {HTMLElement} container
 * @param {object} api  chrome-api.js
 * @param {object} [options]
 * @param {() => void} [options.onClose]  shows a "Back to tabs" button that calls this
 */
export function createSettings(container, api, { onClose } = {}) {
  const status = h('p', { class: 'settings-status', role: 'status' });
  const shortcutList = h('dl', { class: 'shortcut-list' });
  const backupStatus = h('p', { class: 'settings-hint', role: 'status' });
  const fileInput = h('input', { type: 'file', accept: '.txt,text/plain', hidden: true, id: 'tabbies-restore-file' });
  let statusTimer = null;

  const form = h(
    'form',
    { class: 'settings-form' },
    section(
      'Toolbar icon',
      'What clicking the Tabbies icon in Chrome’s toolbar, or pressing its shortcut (Alt+T), opens.',
      choice('actionOpens', 'fullTab', 'A full tab', 'Tabbies in its own tab; click again to go back to where you were'),
      choice('actionOpens', 'sidePanel', 'Side panel', 'Stays open on the right while you browse'),
      choice('actionOpens', 'popup', 'Popup', 'A small window under the icon that closes when you click away'),
    ),
    section(
      'Tabbies tab',
      null,
      toggle('pinFullTab', 'Keep the Tabbies tab pinned', 'Pinned tabs sit small at the left of the tab strip, out of the way'),
    ),
    section(
      'Theme',
      null,
      choice('theme', 'system', 'Match my computer', 'Light or dark, following your system setting'),
      choice('theme', 'light', 'Light'),
      choice('theme', 'dark', 'Dark'),
    ),
    section(
      'Naps',
      null,
      toggle('keepAfterWaking', 'Keep links after waking', 'Waking opens the tabs but leaves the nap as it is'),
      toggle('napPinned', 'Nap pinned tabs too', 'When napping a whole window or every window. Otherwise pinned tabs stay open.'),
      toggle(
        'syncNaps',
        'Sync naps with your Chrome profile',
        'Keeps naps in a “Tabbies Naps” bookmarks folder (under Other bookmarks), so Chrome Sync brings them to your ' +
          'other computers. Napped pages then also show up in your bookmarks and address-bar suggestions. ' +
          'Chrome will ask to let Tabbies read and change your bookmarks. Turn it on on each computer.',
      ),
    ),
    section(
      'Page previews',
      null,
      toggle(
        'pagePreviews',
        'Show a preview of the page when you point at a tab',
        'Tabbies takes a small snapshot of each page while you’re looking at it, and shows it in the card that ' +
          'appears when you point at that tab later. Pages you haven’t looked at since have no preview. Chrome will ' +
          'ask to let Tabbies “read and change all your data on all websites”: it’s used only for these snapshots, ' +
          'which stay on this computer and are forgotten when Chrome closes. Turn it on on each computer.',
      ),
      h('p', { class: 'settings-hint preview-status' }),
    ),
  );

  const tipsSwitch = h('input', { type: 'checkbox', name: 'tipsOn' });
  const extras = [
    section(
      'Tips',
      null,
      h(
        'label',
        { class: 'choice' },
        tipsSwitch,
        h(
          'span',
          { class: 'choice-text' },
          h('span', { class: 'choice-label' }, 'Show a tip when Tabbies opens'),
          h('span', { class: 'settings-hint' }, 'Short reminders of how the clicks work and of handy shortcut keys. Kept on this computer only.'),
        ),
      ),
      h('div', { class: 'settings-buttons' }, h('button', { class: 'button', type: 'button', 'data-do': 'reset-tips' }, 'Show all tips again')),
    ),
    section(
      'Keyboard shortcuts',
      'Set or change them on Chrome’s shortcuts page.',
      shortcutList,
      h('div', { class: 'settings-buttons' }, h('button', { class: 'button', type: 'button', 'data-do': 'shortcuts' }, 'Change shortcuts…')),
    ),
    section(
      'Naps backup',
      'A backup is a text file with one “URL | Title” per line.',
      h(
        'div',
        { class: 'settings-buttons' },
        h('button', { class: 'button', type: 'button', 'data-do': 'download' }, 'Download backup'),
        h('button', { class: 'button', type: 'button', 'data-do': 'restore' }, 'Restore from a file…'),
        fileInput,
      ),
      backupStatus,
    ),
  ];

  container.classList.add('settings');
  container.replaceChildren(
    onClose && h('button', { class: 'settings-back', type: 'button', 'data-do': 'close' }, icon('back'), 'Back to tabs'),
    h('div', { class: 'settings-heading' }, h('h2', {}, 'Settings'), status),
    form,
    ...extras,
    h(
      'p',
      { class: 'settings-about' },
      `Tabbies ${api.getVersion()} · These settings follow your Chrome profile to your other computers.`,
    ),
  );

  form.addEventListener('change', onChange);
  // Tips live outside the settings form: they're kept per computer, in localStorage.
  tipsSwitch.checked = !readTipState().off;
  tipsSwitch.addEventListener('change', () => {
    setTipsOn(tipsSwitch.checked);
    showStatus(tipsSwitch.checked ? 'Tips on' : 'Tips off');
  });
  container.addEventListener('click', onClick);
  fileInput.addEventListener('change', onFileChosen);
  document.addEventListener('visibilitychange', onVisibilityChange);
  // Reflect changes made elsewhere (another Tabbies page, the Naps ⋯ menu).
  const stopListening = api.onSettingsChanged(fill);
  api.readSettings().then(fill);
  showShortcuts();

  return { destroy };

  function fill(settings) {
    for (const input of form.querySelectorAll('input')) {
      input.checked = input.type === 'checkbox' ? Boolean(settings[input.name]) : settings[input.name] === input.value;
    }
    showPreviewStatus(settings);
  }

  /** Under the Page previews switch: how many snapshots there are, or what's wrong. */
  async function showPreviewStatus(settings) {
    const line = form.querySelector('.preview-status');
    if (!line) return;
    if (!settings.pagePreviews) {
      line.textContent = '';
      return;
    }
    if (!(await api.hasPreviewPermission())) {
      line.textContent = 'Chrome’s permission for previews is missing (it can be removed at chrome://extensions). Turn this off and on again to ask for it.';
      return;
    }
    const { count, lastError } = await api.previewStatus();
    line.textContent =
      (count === 0 ? 'No snapshots yet: open a few tabs and they’ll appear.' : `${count === 1 ? '1 snapshot' : `${count} snapshots`} so far.`) +
      (lastError ? ` The last one didn’t work: ${lastError}` : '');
  }

  function onChange(event) {
    const input = event.target;
    if (input.name === 'syncNaps') {
      changeNapSync(input);
      return;
    }
    if (input.name === 'pagePreviews') {
      changePreviews(input);
      return;
    }
    const value = input.type === 'checkbox' ? input.checked : input.value;
    api.saveSettings({ [input.name]: value }).then(() => showStatus('Saved'));
  }

  function changePreviews(input) {
    if (!input.checked) {
      api.stopPreviews().then(() => api.saveSettings({ pagePreviews: false })).then(() => showStatus('Previews off; snapshots forgotten'));
      return;
    }
    // Ask right away, while the click still counts (see changeNapSync).
    api.requestPreviewPermission().then((granted) => {
      if (!granted) {
        input.checked = false;
        showStatus('Previews stay off');
        return;
      }
      api.saveSettings({ pagePreviews: true }).then(() => showStatus('Previews on: pages you look at from now on get one'));
    });
  }

  function changeNapSync(input) {
    if (!input.checked) {
      api.stopNapSync().then(() => showStatus('Naps are now kept on this computer only'));
      return;
    }
    // Ask right here, while the click still counts: Chrome only shows its
    // permission prompt in direct response to something you did.
    api.requestSyncPermission().then(async (granted) => {
      if (!granted) {
        input.checked = false;
        showStatus('Sync stays off');
        return;
      }
      showStatus('Moving your naps…');
      await api.startNapSync();
      showStatus('Naps now sync with your Chrome profile');
    });
  }

  function onClick(event) {
    const action = event.target.closest('[data-do]')?.dataset.do;
    if (action === 'close') onClose();
    else if (action === 'shortcuts') api.openShortcutsPage();
    else if (action === 'download') downloadBackup();
    else if (action === 'restore') fileInput.click();
    else if (action === 'reset-tips') {
      resetTips();
      tipsSwitch.checked = true;
      showStatus('All tips will show again');
    }
  }

  async function showShortcuts() {
    const shortcuts = await api.getShortcuts();
    // Chrome reports the toolbar icon's own shortcut with no description.
    const label = ({ name, description }) =>
      name === '_execute_action' ? 'Open or close Tabbies (same as clicking its icon)' : description;
    shortcutList.replaceChildren(
      ...shortcuts.flatMap(({ name, description, shortcut }) => [
        h('dt', {}, label({ name, description })),
        h('dd', {}, shortcut ? h('kbd', {}, shortcut) : h('span', { class: 'settings-hint' }, 'Not set')),
      ]),
    );
  }

  // Coming back from Chrome's shortcuts page: show the keys as they are now.
  function onVisibilityChange() {
    if (document.hidden) return;
    showShortcuts();
    // The snapshot count changes as you browse.
    api.readSettings().then(showPreviewStatus);
  }

  async function downloadBackup() {
    const text = await api.exportNaps();
    if (!text) {
      backupStatus.textContent = 'Nothing is napping, so there’s nothing to back up yet.';
      return;
    }
    // A link to an in-memory file, clicked from script, downloads it.
    const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
    const date = new Date().toISOString().slice(0, 10);
    h('a', { href: url, download: `tabbies-naps-${date}.txt` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    backupStatus.textContent = 'Backup downloaded.';
  }

  async function onFileChosen() {
    const [file] = fileInput.files;
    fileInput.value = ''; // so choosing the same file again still counts as a change
    if (!file) return;
    const result = await api.importNaps(await file.text());
    backupStatus.textContent =
      result.count === 0
        ? 'No links found in that file.'
        : `Restored ${plural(result.count, 'link')} in ${plural(result.lists, 'nap')}. They’re at the end of the Naps list.`;
  }

  function showStatus(text) {
    clearTimeout(statusTimer);
    status.textContent = text;
    statusTimer = setTimeout(() => {
      status.textContent = '';
    }, 1500);
  }

  function destroy() {
    stopListening();
    clearTimeout(statusTimer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    container.replaceChildren();
  }
}

// ---- Building blocks ---------------------------------------------------------------------

function section(title, hint, ...content) {
  return h(
    'fieldset',
    { class: 'settings-section' },
    h('legend', {}, title),
    hint && h('p', { class: 'settings-hint' }, hint),
    ...content,
  );
}

/** One radio button of a setting with several choices. */
function choice(name, value, label, hint) {
  return h(
    'label',
    { class: 'choice' },
    h('input', { type: 'radio', name, value }),
    h('span', { class: 'choice-text' }, h('span', { class: 'choice-label' }, label), hint && h('span', { class: 'settings-hint' }, hint)),
  );
}

/** A checkbox setting. */
function toggle(name, label, hint) {
  return h(
    'label',
    { class: 'choice' },
    h('input', { type: 'checkbox', name }),
    h('span', { class: 'choice-text' }, h('span', { class: 'choice-label' }, label), hint && h('span', { class: 'settings-hint' }, hint)),
  );
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
