// popup.js — entry point for the mini popup (popup.html), which opens when you
// click the Tabbies icon in the toolbar ("default_popup" in manifest.json).

import { startView } from './shared/start-view.js';

// Chrome closes a popup as soon as it loses focus, but switching to a tab in
// the same window doesn't always take focus away, so close it ourselves.
startView({ closeAfterNavigating: true });
