// sidepanel.js — entry point for the side panel view (sidepanel.html).
//
// Chrome shows this page in its side panel ("side_panel" in manifest.json).
// Open it from the popup's side-panel button, or from Chrome's own side panel
// menu. It stays open beside the page while you switch tabs.

import { startView } from './shared/start-view.js';

startView();
