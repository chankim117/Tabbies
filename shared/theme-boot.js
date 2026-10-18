// shared/theme-boot.js
//
// Loaded as a plain (non-module) script in each page's <head>, so it runs
// before the page is drawn. If Settings picked a fixed Light or Dark theme,
// it applies it right away, so the page never flashes the other theme first.
// (The setting itself lives in chrome.storage, which can only be read
// asynchronously, too late for that; start-view.js keeps this quick copy in
// localStorage up to date.)

try {
  const theme = localStorage.getItem('tabbies-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // Storage unavailable: just follow the system theme.
}
