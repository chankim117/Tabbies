// shared/icons.js
//
// Inline SVG line icons on a 24×24 grid (Feather/Lucide style). They use
// `currentColor`, so they take the text color of whatever they sit in.
// Each icon's markup is parsed once and then cloned for every row, which is
// much cheaper than parsing SVG again for each of hundreds of tabs.

const PATHS = {
  chevron: '<path d="m9 18 6-6-6-6"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  sound:
    '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>' +
    '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  muted: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
  pin:
    '<path d="M12 17v5"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1' +
    'a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/>',
  asleep: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>' +
    '<path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
  newWindow: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M12 12v5"/><path d="M9.5 14.5h5"/>',
  sort: '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>',
  // A sun coming up: "wake" napped tabs.
  wake:
    '<path d="M12 2v4"/><path d="m4.93 6.93 1.41 1.41"/><path d="M2 14h2"/><path d="M20 14h2"/>' +
    '<path d="m19.07 6.93-1.41 1.41"/><path d="M22 20H2"/><path d="M16 14a4 4 0 0 0-8 0"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06' +
    'a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33' +
    'l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09' +
    'A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6' +
    'a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06' +
    'a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  sidePanel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
  openTab:
    '<path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/><path d="m21 3-9 9"/>' +
    '<path d="M15 3h6v6"/>',
};

const parsed = new Map();

/**
 * Returns a new <svg> element for the named icon.
 * @param {keyof PATHS} name
 * @param {string} [className] extra class besides "icon"
 */
export function icon(name, className = '') {
  let svg = parsed.get(name);
  if (!svg) {
    // The markup is our own constant, never page data, so innerHTML is safe here.
    const template = document.createElement('template');
    template.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      `stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
    svg = template.content.firstElementChild;
    parsed.set(name, svg);
  }
  const copy = svg.cloneNode(true);
  copy.setAttribute('class', className ? `icon ${className}` : 'icon');
  return copy;
}
