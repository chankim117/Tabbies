// tabbies.js — entry point for the full-tab view (tabbies.html).
// Opened with Alt+T or the popup's "open in a tab" button.

import { startView } from './shared/start-view.js';
import { getOpenTabbiesShortcut } from './shared/chrome-api.js';

const explorer = startView();

// Whenever you come back to this tab (Alt+T, clicking the tab or its window),
// put the cursor in the search box so you can type and press Enter right away.
// Switching tabs fires `visibilitychange`; switching between two visible
// windows only fires the window's `focus` event.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) explorer.focusSearch();
});
window.addEventListener('focus', () => explorer.focusSearch());

showShortcut();

async function showShortcut() {
  const shortcut = await getOpenTabbiesShortcut();
  if (!shortcut) return;
  const hint = document.getElementById('shortcut');
  hint.querySelector('kbd').textContent = shortcut;
  hint.hidden = false;
}
