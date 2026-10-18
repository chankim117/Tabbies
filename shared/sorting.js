// shared/sorting.js
//
// The ways Tabbies can sort the tabs of a window. These are plain compare
// functions on tab data (title, url, lastAccessed) with no chrome.* calls:
// explorer.js lists them in the sort menu, and chrome-api.js applies them.
//
// Array.prototype.sort is stable, so tabs that compare equal (two tabs from
// the same site, say) keep the order they already had.

/**
 * @typedef {object} SortOrder
 * @property {string} id
 * @property {string} label    shown in the menu
 * @property {string} hint     one line under the label
 * @property {string} done     finishes the sentence "Sorted Window 2 …"
 * @property {(a: object, b: object) => number} compare
 */

/** @type {SortOrder[]} */
export const SORT_ORDERS = [
  {
    id: 'site',
    label: 'By site',
    // ⁠ (word joiner) keeps "A–Z" from breaking across two lines.
    hint: 'Tabs from the same site sit together, sites A⁠–⁠Z',
    done: 'by site',
    compare: (a, b) => compareSites(a, b) || compareText(a.title, b.title),
  },
  {
    id: 'title',
    label: 'By title',
    hint: 'A–Z',
    done: 'by title',
    compare: (a, b) => compareText(a.title, b.title),
  },
  {
    id: 'recent',
    label: 'Recently used first',
    hint: 'The tabs you looked at last come first',
    done: 'with recently used tabs first',
    // lastAccessed: when the tab was last active, in ms (Chrome 121+).
    compare: (a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0),
  },
  {
    id: 'oldest',
    label: 'Oldest first',
    hint: 'Tabs you haven’t opened in a while come first',
    done: 'with the oldest tabs first',
    compare: (a, b) => (a.lastAccessed ?? 0) - (b.lastAccessed ?? 0),
  },
];

/** Web pages sorted by site name; Chrome pages, files etc. after them. */
function compareSites(a, b) {
  const siteA = siteOf(a);
  const siteB = siteOf(b);
  return siteA.web === siteB.web ? compareText(siteA.name, siteB.name) : siteA.web ? -1 : 1;
}

/** "https://www.youtube.com/watch?v=…" → { web: true, name: "youtube.com" } */
function siteOf(tab) {
  const url = tab.url || tab.pendingUrl || '';
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:') return { web: true, name: hostname.replace(/^www\./, '') };
    return { web: false, name: `${protocol}${hostname}` };
  } catch {
    return { web: false, name: url };
  }
}

// Case-insensitive, and "Tab 2" before "Tab 10".
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function compareText(a = '', b = '') {
  return collator.compare(a, b);
}
