// settings-page.js — entry point for settings.html, Chrome's Options page for
// Tabbies. It shows the same Settings component as the ⚙ button in the views.

import { createSettings } from './shared/settings.js';
import { followThemeSetting } from './shared/start-view.js';
import * as chromeApi from './shared/chrome-api.js';

followThemeSetting();
createSettings(document.getElementById('settings'), chromeApi);
