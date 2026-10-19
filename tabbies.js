// tabbies.js — entry point for the full-tab view (tabbies.html).
// Opened with the "Open Tabbies in a tab" shortcut or the ⧉ buttons.

import { startView } from './shared/start-view.js';
import { getShortcut } from './shared/chrome-api.js';

const explorer = startView();

// Whenever you come back to this tab (shortcut, clicking the tab or its window),
// put the cursor in the search box so you can type and press Enter right away.
// Switching tabs fires `visibilitychange`; switching between two visible
// windows only fires the window's `focus` event.
// Not while you're in the middle of something (tabs selected, a menu open).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) explorer.focusSearch({ whenIdle: true });
});
window.addEventListener('focus', () => explorer.focusSearch({ whenIdle: true }));

showShortcut();

async function showShortcut() {
  const shortcut = await getShortcut('_execute_action');
  if (!shortcut) return;
  const hint = document.getElementById('shortcut');
  hint.querySelector('kbd').textContent = shortcut;
  hint.hidden = false;
}
