// sidepanel.js — entry point for the side panel view (sidepanel.html).
//
// Chrome shows this page in its side panel ("side_panel" in manifest.json).
// By default the Tabbies toolbar icon and Alt+T open and close it. It stays
// open beside the page while you switch tabs.

import { startView } from './shared/start-view.js';

startView();
