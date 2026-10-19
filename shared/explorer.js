// shared/explorer.js
//
// The Tabbies explorer: a search box above a tree of windows → tab groups → tabs.
//
// This file is pure UI and never calls chrome.* itself. Everything it needs
// from the browser comes through the `api` object passed to createExplorer(),
// so all three views (full tab, popup, side panel) mount this same explorer.
// The interface it expects (implemented by chrome-api.js):
//
//   api.getSnapshot()                  → Promise<Snapshot>   plain data, see chrome-api.js
//   api.subscribe(onChange)            → unsubscribe()       onChange runs when tabs change
//   api.activateTab(tab)               → Promise
//   api.closeTab(tab)                  → Promise
//   api.setTabMuted(tab, muted)        → Promise
//   api.moveTabs(tabs, target)         → Promise   (drag and drop, see drag-drop.js)
//   api.moveGroup(group, target)       → Promise
//   api.mergeWindow(win, intoWindowId) → Promise
//   api.sortWindow(windowId, orderId)  → Promise<Layout>  (sort menu, see sorting.js)
//   api.arrangeWindow(windowId, layout) → Promise         (undo a sort)
//   api.napTabs / napWindow / napAllWindows / wakeNap / deleteFromNap / renameNap /
//   importNaps / exportNaps, and their undo functions (Naps, see naps-api.js)
//   api.saveSettings(changes)          → Promise   (see settings-api.js)
//                                       (Naps, see naps-api.js)

import { h } from './dom.js';
import { icon } from './icons.js';
import { enableDragAndDrop } from './drag-drop.js';
import { SORT_ORDERS } from './sorting.js';
import { formatNapDate, napName } from './nap-data.js';

// The Tab Nap cat marks everything to do with Naps: the full drawing where
// it's shown large, a simplified one for buttons and headings.
const NAP_PICTURE_URL = '/icons/nap.svg';
const NAP_ICON_URL = '/icons/nap-small.svg';
const LAST_VIEW_KEY = 'tabbies-last-view';

/**
 * Builds the explorer inside `container` and keeps it up to date.
 *
 * @param {HTMLElement} container  Empty element provided by the view.
 * @param {object} api             Data source and actions (see the interface above).
 * @param {object} [options]
 * @param {boolean} [options.autofocus]         Put the cursor in the search box on start.
 * @param {() => void} [options.onTabActivated] Called after switching to a tab
 *                                              (the popup closes itself then).
 * @returns {{ refresh(): Promise<void>, focusSearch(): void, destroy(): void }}
 */
export function createExplorer(container, api, { autofocus = false, onTabActivated = () => {} } = {}) {
  // ---- State ------------------------------------------------------------------
  let snapshot = null; // latest result of api.getSnapshot()
  // Lookups by id, to find the data behind a clicked or dragged row.
  let tabsById = new Map();
  let groupsById = new Map();
  let windowsById = new Map();
  let napsById = new Map();
  let loadError = null;
  let query = '';
  // Keys ("window:12", "group:7") of collapsed branches. A search uses its own
  // set, emptied on every new query, so matches are never hidden inside a
  // collapsed branch and clearing the search brings the normal layout back.
  const collapsed = new Set();
  const collapsedWhileSearching = new Set();
  // Tab rows from the last render, reused when nothing shown in them changed,
  // so a refresh only builds rows for tabs that actually changed.
  let rowCache = new Map(); // tab id (or "link:<id>" for napped links) → { signature, element }
  // Selected tabs, like selected files: Ctrl+click toggles one, Shift+click
  // selects a range from the anchor (the last tab clicked), Ctrl+A selects all.
  const selection = new Set(); // tab ids
  let selectionAnchor = null; // tab id
  // Napped links are selected the same way (but never together with tabs).
  const linkSelection = new Set(); // link ids
  let linkAnchor = null; // link id
  let linksById = new Map(); // link id → { ...link, napId }
  let selectionSeeded = false; // Chrome's own multi-selected tabs are picked up once
  let counts = { total: 0, shown: 0, windows: 0, searching: false }; // for the summary line
  let menuItems = []; // what each item of the open menu does
  let menuOpenerKey = null; // focus key of the button that opened the menu
  let menuClosed = { key: null, at: 0 }; // which menu closed last, and when
  let lastPress = { key: null, at: 0 }; // which button was last pressed, and when
  let dialogAction = null; // what the open dialog's main button does
  let toastAction = null;
  let lastViewTimer = null;
  let toastTimer = null;

  let loading = false;
  let reloadQueued = false;
  let staleWhileHidden = false;
  let renderQueued = false;
  let renderAfterDrag = false;
  let renaming = false; // a name is being edited in place (see startRename)
  let renameEndedAt = -Infinity;
  const undoHistory = []; // { text, run } for Ctrl+Z, newest last (see showToast)
  let nameGroupWhenShown = null; // a group just made with "Group": name it once it appears
  let destroyed = false;

  // ---- Fixed parts of the UI ------------------------------------------------------
  const searchInput = h('input', {
    class: 'search-input',
    type: 'search',
    placeholder: 'Search tabs by title or URL',
    'aria-label': 'Search tabs by title or URL',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const summary = h('p', { class: 'summary', 'aria-live': 'polite' }, 'Loading tabs…');
  const tree = h('div', { class: 'tree' });
  const message = h('p', { class: 'message', hidden: true });
  // Drop zones that appear at the bottom while dragging.
  const newWindowZone = h(
    'div',
    { class: 'drop-zone new-window-zone' },
    icon('newWindow'),
    'Drop here to move to a new window',
  );
  const napZone = h('div', { class: 'drop-zone nap-zone' }, napIcon(), 'Drop here to nap');
  const dropZones = h('div', { class: 'drop-zones', hidden: true }, newWindowZone, napZone);

  // Shown over the search box while tabs are selected. It covers the search
  // row instead of pushing the tree down, so rows don't jump between the two
  // clicks of a double-click. (Narrow views show its buttons as icons only.)
  const selectionCount = h('span', { class: 'selection-count' });
  const selectionBar = h(
    'div',
    { class: 'selection-bar', hidden: true },
    selectionCount,
    h('button', { type: 'button', 'data-selection': 'nap', 'data-for': 'tabs', title: 'Nap them' }, napIcon(), h('span', { class: 'button-text' }, 'Nap')),
    h('button', { type: 'button', 'data-selection': 'group', 'data-for': 'tabs', title: 'Put them in a new tab group' }, icon('group'), h('span', { class: 'button-text' }, 'Group')),
    // Only shown when some selected tabs are in a group:
    h('button', { type: 'button', 'data-selection': 'ungroup', 'data-for': 'tabs', 'data-needs': 'grouped', title: 'Take them out of their groups' }, icon('ungroup'), h('span', { class: 'button-text' }, 'Ungroup')),
    h(
      'button',
      { type: 'button', 'data-selection': 'color', 'data-for': 'tabs', 'data-needs': 'grouped', 'data-focus-key': 'selection:color', 'aria-haspopup': 'menu', title: 'Change the color of their groups' },
      icon('color'),
      h('span', { class: 'button-text' }, 'Color'),
    ),
    h('button', { type: 'button', 'data-selection': 'new-window', 'data-for': 'tabs', title: 'Move them to a new window' }, icon('newWindow'), h('span', { class: 'button-text' }, 'New window')),
    h('button', { type: 'button', class: 'danger', 'data-selection': 'close', 'data-for': 'tabs', title: 'Close them (you can undo it)' }, icon('close'), h('span', { class: 'button-text' }, 'Close')),
    h('button', { type: 'button', 'data-selection': 'wake', 'data-for': 'links', title: 'Open them in this window' }, icon('wake'), h('span', { class: 'button-text' }, 'Wake')),
    h('button', { type: 'button', 'data-selection': 'wake-window', 'data-for': 'links', title: 'Open them in a new window' }, icon('newWindow'), h('span', { class: 'button-text' }, 'New window')),
    h('button', { type: 'button', class: 'danger', 'data-selection': 'delete', 'data-for': 'links', title: 'Delete them (you can undo it)' }, icon('close'), h('span', { class: 'button-text' }, 'Delete')),
    // "Deselect", not "Clear" or "Cancel": it only un-selects; nothing is closed or undone.
    // Set apart on the right, as the "never mind" button: it only unselects.
    h('span', { class: 'selection-divider', 'aria-hidden': 'true' }),
    h('button', { type: 'button', class: 'ghost', 'data-selection': 'deselect', title: 'Unselect them all (Esc)' }, 'Cancel'),
  );

  // Screen readers read out whatever is put in here (e.g. "Moved … to Window 2").
  const announcer = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });

  // One menu, filled in each time a ⋯ or sort button opens it. `popover`
  // makes the browser show it on top of everything and close it on Esc or an
  // outside click.
  const menu = h('div', { class: 'menu', popover: 'auto', role: 'menu' });

  // One dialog (rename, import, export). showModal() dims the page behind it,
  // keeps keyboard focus inside, and closes on Esc.
  const dialogTitle = h('h2', { class: 'dialog-title' });
  const dialogText = h('p', { class: 'dialog-text' });
  const dialogInput = h('input', { class: 'dialog-input', type: 'text', id: 'tabbies-dialog-input', 'aria-labelledby': 'tabbies-dialog-title' });
  const dialogArea = h('textarea', { class: 'dialog-area', id: 'tabbies-dialog-area', rows: 10, spellcheck: 'false', 'aria-labelledby': 'tabbies-dialog-title' });
  const dialogConfirm = h('button', { class: 'button primary', type: 'submit' });
  const dialog = h(
    'dialog',
    { class: 'dialog' },
    h(
      'form',
      { method: 'dialog' },
      dialogTitle,
      dialogText,
      dialogInput,
      dialogArea,
      h('div', { class: 'dialog-buttons' }, h('button', { class: 'button', type: 'button', value: 'cancel' }, 'Cancel'), dialogConfirm),
    ),
  );
  dialogTitle.id = 'tabbies-dialog-title';

  // A short message at the bottom, optionally with an Undo button.
  const toastText = h('span');
  const toastButton = h('button', { type: 'button' });
  const toast = h('div', { class: 'toast', role: 'status', hidden: true }, toastText, toastButton);

  container.classList.add('explorer');
  // A one-time tip: in a browser people expect one click to switch tabs.
  const tip = h(
    'div',
    { class: 'tip', role: 'note', hidden: !tipWanted() },
    h('span', {}, h('b', {}, 'Click'), ' to select · ', h('b', {}, 'double-click'), ' to open · ', h('b', {}, 'right-click'), ' for more'),
    h('button', { type: 'button', class: 'tip-close', 'aria-label': 'Got it, hide this tip' }, 'Got it'),
  );
  tip.querySelector('.tip-close').addEventListener('click', () => {
    tip.hidden = true;
    try {
      localStorage.setItem(TIP_KEY, '1');
    } catch {
      // storage blocked: the tip just comes back next time
    }
  });

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('label', { class: 'search' }, icon('search'), searchInput),
    summary,
    selectionBar,
  );
  container.replaceChildren(
    toolbar,
    tip,
    tree,
    message,
    dropZones,
    announcer,
    menu,
    dialog,
    toast,
  );

  searchInput.addEventListener('input', () => setQuery(searchInput.value));
  searchInput.addEventListener('keydown', onSearchKeydown);
  // One listener on the whole tree handles every row ("event delegation"),
  // instead of a listener per button.
  tree.addEventListener('click', onTreeClick);
  // Window rows stick to the top while you scroll through their tabs, just
  // under the (also sticky) toolbar, whose height changes (e.g. narrow views
  // wrap it), so a ResizeObserver keeps the offset in a CSS variable.
  const toolbarSize = new ResizeObserver(() => {
    document.documentElement.style.setProperty('--tabbies-toolbar-height', `${toolbar.offsetHeight}px`);
  });
  toolbarSize.observe(toolbar);
  tree.addEventListener('contextmenu', onTreeContextMenu);
  tree.addEventListener('keyup', (event) => {
    if (event.key === ' ' && event.target.closest('.row')) event.preventDefault();
  });
  tree.addEventListener('keydown', onTreeKeydown);
  // Favicons that fail to load fall back to a globe. 'error' doesn't bubble,
  // so it is caught on the way down (capture phase).
  tree.addEventListener('error', onImageError, true);
  document.addEventListener('keydown', onDocumentKeydown);
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('visibilitychange', onVisibilityChange);
  menu.addEventListener('click', onMenuClick);
  menu.addEventListener('keydown', onMenuKeydown);
  menu.addEventListener('toggle', onMenuToggle);
  // 'beforetoggle' fires the moment the menu starts closing (the 'toggle'
  // event comes later, after the click that may follow), so note it here.
  menu.addEventListener('beforetoggle', (event) => {
    if (event.newState === 'closed') menuClosed = { key: menuOpenerKey, at: performance.now() };
  });
  // Remember which button a press landed on, to tell "pressed the same ⋯ to
  // close its menu" apart from simply opening it again later.
  container.addEventListener(
    'pointerdown',
    (event) => {
      lastPress = { key: event.target.closest?.('button')?.dataset.focusKey ?? null, at: performance.now() };
    },
    true,
  );
  // The menu stays where it opened, so close it when the list scrolls away
  // from under it or the view is resized. (`true`: also scrolling inside the
  // popup's or side panel's own scroll area.)
  const closeMenu = (event) => {
    const insideMenu = event.target instanceof Node && menu.contains(event.target);
    if (menu.matches(':popover-open') && !insideMenu) menu.hidePopover();
  };
  window.addEventListener('scroll', closeMenu, true);
  window.addEventListener('resize', closeMenu);
  selectionBar.addEventListener('click', onSelectionBarClick);
  dialog.addEventListener('submit', onDialogSubmit);
  dialog.querySelector('[value="cancel"]').addEventListener('click', () => dialog.close());
  toastButton.addEventListener('click', () => {
    const action = toastAction;
    hideToast();
    action?.();
  });

  const dragDrop = enableDragAndDrop({
    root: container,
    tree,
    zones: { container: dropZones, newWindow: newWindowZone, nap: napZone },
    model: {
      tab: (id) => tabsById.get(id),
      group: (id) => groupsById.get(id),
      window: (id) => windowsById.get(id),
      nap: (id) => napsById.get(id),
      selectionFor,
      linkSelectionFor,
    },
    expand: (toggle) => setExpanded(toggle, true),
    onDrop: moveItem,
    // Live updates are held back during a drag (rebuilding rows under the
    // pointer would break it); catch up as soon as the drag ends.
    onDragEnd: () => {
      if (renderAfterDrag) {
        renderAfterDrag = false;
        render();
      }
    },
  });

  // Draw the last view right away, so a freshly opened side panel or popup
  // isn't empty while Chrome is asked for the tabs; refresh() then brings
  // it up to date a moment later.
  showLastView();
  const unsubscribe = api.subscribe(refresh);
  refresh();
  if (autofocus) focusSearch();

  return { refresh, focusSearch, destroy };

  // ---- Loading ------------------------------------------------------------------------

  async function refresh() {
    if (destroyed) return;
    // Don't spend time on a view nobody can see (e.g. Tabbies is a background
    // tab); catch up as soon as it becomes visible again.
    if (document.hidden) {
      staleWhileHidden = true;
      return;
    }
    // If a load is already running, run one more after it instead of two at once.
    if (loading) {
      reloadQueued = true;
      return;
    }

    loading = true;
    try {
      snapshot = await api.getSnapshot();
      indexSnapshot();
      seedSelection();
      rememberLastView();
      loadError = null;
    } catch (error) {
      console.error('Tabbies: could not read tabs', error);
      loadError = error;
    } finally {
      loading = false;
    }

    render();
    if (reloadQueued) {
      reloadQueued = false;
      refresh();
    }
  }

  function indexSnapshot() {
    tabsById = new Map();
    groupsById = new Map();
    windowsById = new Map();
    napsById = new Map(snapshot.naps.map((nap) => [nap.id, nap]));
    linksById = new Map(snapshot.naps.flatMap((nap) => nap.links.map((link) => [link.id, { ...link, napId: nap.id }])));
    for (const win of snapshot.windows) {
      windowsById.set(win.id, win);
      for (const child of win.children) {
        if (child.kind === 'group') groupsById.set(child.id, child);
      }
      for (const tab of tabsIn(win)) tabsById.set(tab.id, tab);
    }
  }

  // The last view is kept in localStorage: this extension's own storage in
  // this browser, shared by all Tabbies pages. Incognito windows are never kept.
  function showLastView() {
    try {
      const last = JSON.parse(localStorage.getItem(LAST_VIEW_KEY));
      if (!last?.windows) return;
      snapshot = last;
      indexSnapshot();
      render();
    } catch {
      // Nothing usable saved: the first refresh fills the view instead.
    }
  }

  function rememberLastView() {
    clearTimeout(lastViewTimer);
    lastViewTimer = setTimeout(() => {
      try {
        const windows = snapshot.windows.filter((win) => !win.incognito);
        localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({ ...snapshot, windows }));
      } catch {
        // Storage full or unavailable: it only makes opening a little slower.
      }
    }, 500);
  }

  function onVisibilityChange() {
    if (!document.hidden && staleWhileHidden) {
      staleWhileHidden = false;
      refresh();
    }
  }

  // ---- Rendering ----------------------------------------------------------------------

  // Typing can be faster than the screen refreshes; render at most once a frame.
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function render() {
    if (destroyed) return;
    if (dragDrop.isDragging() || renaming) {
      renderAfterDrag = true;
      return;
    }
    const restoreFocus = rememberFocus();
    const terms = searchTerms(query);
    const ctx = { terms, rows: new Map() };
    const windows = snapshot?.windows ?? [];

    const elements = [];
    let total = 0;
    let shown = 0;
    windows.forEach((win, index) => {
      total += win.tabCount;
      const rendered = renderWindow(win, index + 1, ctx);
      if (rendered) {
        elements.push(rendered.element);
        shown += rendered.shown;
      }
    });
    const naps = snapshot ? renderNaps(snapshot.naps, ctx) : null;
    if (naps) elements.push(naps.element);

    tree.replaceChildren(...elements);
    rowCache = ctx.rows; // rows of closed tabs are dropped here
    counts = { total, shown, windows: windows.length, searching: terms.length > 0 };

    if (!snapshot) {
      showMessage(loadError ? `Couldn't read your tabs: ${loadError.message}` : '');
    } else if (terms.length > 0) {
      showMessage(shown === 0 && !naps ? `No tabs match “${query.trim()}”.` : '');
    } else {
      showMessage('');
    }

    // Only tabs still listed stay selected (not ones closed or filtered out
    // by the search).
    pruneSelection();
    restoreFocus();

    if (nameGroupWhenShown !== null && groupsById.has(nameGroupWhenShown)) {
      const label = tree.querySelector(`.branch.group[data-group-id="${nameGroupWhenShown}"] > .row .renamable`);
      nameGroupWhenShown = null;
      startRename(label);
    }
  }

  function updateSummary() {
    if (!snapshot) {
      summary.textContent = loadError ? '' : 'Loading tabs…';
      return;
    }
    const { total, shown, windows, searching } = counts;
    const text = searching
      ? `${shown} of ${plural(total, 'tab')} match`
      : `${plural(total, 'tab')} in ${plural(windows, 'window')}`;
    summary.textContent = selection.size > 0 ? `${selection.size} selected · ${text}` : text;
  }

  function renderWindow(win, number, ctx) {
    // Your name for the window (⋯ → Rename window…), or its number.
    const label = win.name || `Window ${number}`;
    const children = [];
    let shown = 0;
    for (const child of win.children) {
      const rendered = child.kind === 'group' ? renderGroup(child, ctx) : renderTab(child, 1, ctx);
      if (rendered) {
        children.push(rendered.element);
        shown += rendered.shown;
      }
    }
    // While searching, hide windows without a single matching tab.
    if (ctx.terms.length > 0 && shown === 0) return null;

    const activeTab = findActiveTab(win);
    const header = [
      icon('window', 'node-icon'),
      h(
        'span',
        { class: 'label renamable', 'data-placeholder': `Window ${number}`, title: win.name ? `Window ${number} · select, then click to rename` : 'Select, then click the name to rename (or F2)' },
        label,
      ),
      win.isCurrent && h('span', { class: 'badge badge-current', title: 'The window you opened Tabbies in' }, 'Current'),
      win.incognito && h('span', { class: 'badge' }, 'Incognito'),
      activeTab && h('span', { class: 'hint' }, activeTab.title),
      h('span', { class: 'count' }, countLabel(shown, win.tabCount, ctx)),
    ];
    const napButton = napActionButton('nap-window', `window:${win.id}:nap`, `Nap the tabs in ${label}`);
    const sortButton = h(
      'button',
      {
        class: 'action sort',
        type: 'button',
        'data-action': 'sort',
        'data-focus-key': `window:${win.id}:sort`,
        title: 'Sort tabs',
        'aria-label': `Sort the tabs in ${label}`,
        'aria-haspopup': 'menu',
      },
      icon('sort'),
    );
    const menuButton = moreButton('window-menu', `window:${win.id}:menu`, `More for ${label}`);
    const closeButton = h(
      'button',
      {
        class: 'action close',
        type: 'button',
        'data-action': 'close-window',
        'data-focus-key': `window:${win.id}:close`,
        title: 'Close window (you can undo it)',
        'aria-label': `Close ${label}`,
      },
      icon('close'),
    );
    const element = renderBranch({
      key: `window:${win.id}`,
      depth: 0,
      kind: 'window',
      header,
      children,
      actions: [napButton, sortButton, menuButton, closeButton],
      attributes: { 'data-window-id': win.id },
      dragLabel: `Drag to merge ${label} into another window`,
    });
    if (win.isCurrent) element.classList.add('is-current');
    return { element, shown };
  }

  function renderGroup(group, ctx) {
    const children = [];
    for (const tab of group.tabs) {
      const rendered = renderTab(tab, 2, ctx);
      if (rendered) children.push(rendered.element);
    }
    if (ctx.terms.length > 0 && children.length === 0) return null;

    const header = [
      h(
        'span',
        {
          class: group.title ? 'group-label renamable' : 'group-label renamable is-unnamed',
          'data-placeholder': 'Name this group',
          title: 'Select, then click the name to rename (or F2)',
        },
        group.title || 'Unnamed group',
      ),
      h('span', { class: 'count' }, countLabel(children.length, group.tabs.length, ctx)),
    ];
    const element = renderBranch({
      key: `group:${group.id}`,
      depth: 1,
      kind: 'group',
      header,
      children,
      actions: [
        napActionButton('nap-group', `group:${group.id}:nap`, `Nap the group ${group.title || ''}`.trim()),
        moreButton('group-menu', `group:${group.id}:menu`, `More for ${groupLabel(group)}`),
        h(
          'button',
          {
            class: 'action close',
            type: 'button',
            'data-action': 'close-group',
            'data-focus-key': `group:${group.id}:close`,
            title: 'Close the group and its tabs (you can undo it)',
            'aria-label': `Close ${groupLabel(group)}`,
          },
          icon('close'),
        ),
      ],
      attributes: { 'data-group-id': group.id, 'data-color': group.color },
      dragLabel: 'Drag to move this group',
    });
    return { element, shown: children.length };
  }

  /** A window, group or nap: a toggle row followed by its (collapsible) children. */
  function renderBranch({ key, depth, kind, header, children, actions = [], attributes, dragLabel, draggable = true }) {
    const expanded = !activeCollapsedSet().has(key);
    const childrenId = `tabbies-${key.replace(':', '-')}`;
    return h(
      'div',
      { class: `branch ${kind}`, 'data-key': key, ...attributes },
      h(
        'div',
        { class: 'row', style: `--depth: ${depth}`, draggable: draggable ? 'true' : false },
        h(
          'button',
          {
            class: 'toggle',
            type: 'button',
            title: dragLabel,
            'aria-expanded': String(expanded),
            'aria-controls': childrenId,
            'data-action': 'toggle',
            'data-key': key,
            'data-focus-key': key,
          },
          icon('chevron', 'chevron'),
          ...header,
        ),
        ...actions,
      ),
      h('div', { class: 'children', id: childrenId, style: `--depth: ${depth}`, hidden: !expanded }, ...children),
    );
  }

  function renderTab(tab, depth, ctx) {
    if (!matches(tab, ctx.terms)) return null;
    const signature = rowSignature(tab, depth);
    let entry = rowCache.get(tab.id);
    if (!entry || entry.signature !== signature) {
      entry = { signature, element: buildTabRow(tab, depth) };
    }
    ctx.rows.set(tab.id, entry);
    return { element: entry.element, shown: 1 };
  }

  // ---- Naps section -------------------------------------------------------------------

  /** The "Naps" branch below the windows: one child branch per nap. */
  function renderNaps(naps, ctx) {
    const lists = [];
    let shown = 0;
    for (const nap of naps) {
      const rendered = renderNap(nap, ctx);
      if (rendered) {
        lists.push(rendered.element);
        shown += rendered.shown;
      }
    }
    if (ctx.terms.length > 0 && shown === 0) return null;

    const total = naps.reduce((sum, nap) => sum + nap.links.length, 0);
    const header = [
      napIcon('node-icon'),
      h('span', { class: 'label' }, 'Naps'),
      h(
        'span',
        { class: 'hint' },
        snapshot.settings.syncNaps ? 'Synced with your Chrome profile' : 'Tabs closed and kept for later',
      ),
      h('span', { class: 'count' }, countLabel(shown, total, ctx)),
    ];
    const menuButton = moreButton('naps-menu', 'naps:menu', 'Nap options, import and export');
    const children =
      lists.length > 0
        ? lists
        : [
            h(
              'div',
              { class: 'naps-empty' },
              h('img', { src: NAP_PICTURE_URL, alt: '', width: 56, height: 56, draggable: 'false' }),
              h(
                'p',
                {},
                'Nothing is napping. Napping closes tabs and keeps them here to open later. ',
                'Use the nap button on a tab, group or window, select tabs and press Nap, or drag tabs here.',
              ),
            ),
          ];
    const element = renderBranch({
      key: 'naps',
      depth: 0,
      kind: 'naps',
      header,
      children,
      actions: [menuButton],
      attributes: {},
      draggable: false,
    });
    return { element, shown };
  }

  function renderNap(nap, ctx) {
    const children = [];
    for (const link of nap.links) {
      if (!matches(link, ctx.terms)) continue;
      const key = `link:${link.id}`;
      const signature = [nap.id, link.title, link.url, link.favIconUrl].join('\u0000');
      let entry = rowCache.get(key);
      if (!entry || entry.signature !== signature) entry = { signature, element: buildLinkRow(link, nap) };
      ctx.rows.set(key, entry);
      children.push(entry.element);
    }
    if (ctx.terms.length > 0 && children.length === 0) return null;

    const name = napName(nap);
    const header = [
      nap.color && h('span', { class: 'nap-color', 'data-color': nap.color, title: 'Napped from a tab group' }),
      h('span', { class: 'label nap-name renamable', 'data-placeholder': formatNapDate(nap.createdAt), title: 'Select, then click the name to rename (or F2)' }, name),
      nap.title && h('span', { class: 'hint' }, formatNapDate(nap.createdAt)),
      h('span', { class: 'count' }, countLabel(children.length, nap.links.length, ctx)),
    ];
    const wakeButton = h(
      'button',
      {
        class: 'action wake',
        type: 'button',
        'data-action': 'wake-nap',
        'data-focus-key': `nap:${nap.id}:wake`,
        title: nap.color ? 'Wake: open these tabs again, as a group' : 'Wake: open these tabs again',
        'aria-label': `Wake ${name}`,
      },
      icon('wake'),
    );
    const element = renderBranch({
      key: `nap:${nap.id}`,
      depth: 1,
      kind: 'nap',
      header,
      children,
      actions: [wakeButton, moreButton('nap-menu', `nap:${nap.id}:menu`, `More for ${name}`)],
      attributes: { 'data-nap-id': nap.id },
      dragLabel: 'Drag onto a window to wake it there, or up and down to reorder',
    });
    return { element, shown: children.length };
  }

  function showMessage(text) {
    message.textContent = text;
    message.hidden = !text;
  }

  function activeCollapsedSet() {
    return searchTerms(query).length > 0 ? collapsedWhileSearching : collapsed;
  }

  // ---- Interaction --------------------------------------------------------------------

  function onTreeClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) {
      // Clicking empty space clears the selection, like in a file explorer.
      if (!event.target.closest('.row')) setSelection([]);
      return;
    }
    const { action } = button.dataset;
    // Like files and folders on a desktop: one click selects, a double-click
    // opens. event.detail counts the clicks in a row (2 on the second click of
    // a double-click); it's 0 when the click came from the keyboard (Enter or
    // Space), which opens right away. (The second click is used rather than
    // the 'dblclick' event, which gets lost if the row is redrawn in between.)
    const ctrl = event.ctrlKey || event.metaKey; // ⌘ on a Mac
    const keyboard = event.detail === 0;
    const doubleClick = event.detail === 2 && !ctrl && !event.shiftKey;
    if (doubleClick && ['toggle', 'activate', 'wake-link'].includes(action) && !event.target.closest('.chevron')) {
      onDoubleClick(button, action);
      return;
    }

    if (action === 'toggle') {
      // The arrow, or Enter, folds and unfolds a window, group or nap.
      if (keyboard || event.target.closest('.chevron')) {
        // The Enter that saves a name could also "press" the row it hands focus
        // back to; don't fold for that.
        if (keyboard && performance.now() - renameEndedAt < 500) return;
        setExpanded(button, button.getAttribute('aria-expanded') !== 'true');
        return;
      }
      if (event.detail > 1) return; // the double-click does the rest
      const row = button.closest('.row');
      if (row.classList.contains('is-selected') && !ctrl && !event.shiftKey) {
        // Already selected: clicking its name renames it, like a file name;
        // clicking the rest of the row unselects it.
        const name = event.target.closest('.renamable');
        if (name) startRename(name, { byMouse: true });
        else reselectBranch(row.parentElement);
        return;
      }
      selectBranch(row.parentElement, { ctrl, shift: event.shiftKey });
      return;
    }
    if (action === 'sort') {
      openSortMenu(button, Number(button.closest('[data-window-id]').dataset.windowId));
      return;
    }
    if (action === 'nap-window') {
      const windowId = Number(button.closest('[data-window-id]').dataset.windowId);
      napAndOfferUndo(api.napWindow(windowId));
      return;
    }
    if (action === 'nap-group') {
      const group = groupsById.get(Number(button.closest('[data-group-id]').dataset.groupId));
      if (group) napGroup(group);
      return;
    }
    if (action === 'group-menu' || action === 'close-group') {
      const group = groupsById.get(Number(button.closest('[data-group-id]').dataset.groupId));
      if (!group) return;
      if (action === 'group-menu') openGroupMenu(button, group);
      else closeGroup(group);
      return;
    }
    if (action === 'close-window') {
      const win = windowsById.get(Number(button.closest('[data-window-id]').dataset.windowId));
      if (win) closeWindow(win);
      return;
    }
    if (action === 'window-menu') {
      const win = windowsById.get(Number(button.closest('[data-window-id]').dataset.windowId));
      if (win) openWindowMenu(button, win);
      return;
    }
    if (action === 'naps-menu') {
      openNapsMenu(button);
      return;
    }

    // Rows inside the Naps section.
    const nap = napsById.get(button.closest('[data-nap-id]')?.dataset.napId);
    if (nap) {
      const linkId = button.closest('[data-link-id]')?.dataset.linkId;
      if (action === 'wake-link') {
        if (keyboard) {
          setSelection([]);
          wake(nap, { linkIds: [linkId], where: 'here', activate: true });
        } else if (event.detail > 1) {
          // the double-click wakes it
        } else if (event.shiftKey) selectLinkRange(linkId, ctrl);
        else if (ctrl) toggleLinkSelected(linkId);
        else if (linkSelection.has(linkId) && linkSelection.size === 1) {
          setSelection([]); // clicking the selected link again unselects it
        } else {
          setSelection([]);
          toggleLinkSelected(linkId);
        }
      }
      else if (action === 'delete-link') deleteAndOfferUndo(nap, [linkId]);
      else if (action === 'wake-nap') wake(nap, { where: nap.color ? 'group' : 'here' });
      else if (action === 'nap-menu') openNapMenu(button, nap);
      return;
    }

    const tab = tabsById.get(Number(button.closest('[data-tab-id]')?.dataset.tabId));
    if (!tab) return;
    if (action === 'nap-tab') {
      napAndOfferUndo(api.napTabs([tab.id]));
    } else if (action === 'activate') {
      if (keyboard) {
        setSelection([]);
        selectionAnchor = tab.id;
        switchTo(tab);
      } else if (event.detail > 1) {
        // the double-click switches to it
      } else if (event.shiftKey) {
        selectRange(tab.id, ctrl); // Ctrl+Shift adds the range to the selection
      } else if (ctrl) {
        toggleSelected(tab.id);
      } else if (selection.has(tab.id) && selection.size === 1) {
        setSelection([]); // clicking the selected tab again unselects it
      } else {
        setSelection([tab.id]);
        selectionAnchor = tab.id;
      }
    } else if (action === 'close') {
      act(api.closeTab(tab));
    } else if (action === 'mute') {
      act(api.setTabMuted(tab, !tab.muted));
    }
  }

  /**
   * Right-click on a row: a menu with everything you can do with it, at the
   * mouse. Like on a desktop, right-clicking something that isn't selected
   * selects it first; right-clicking part of the selection acts on all of it.
   */
  function onTreeContextMenu(event) {
    const row = event.target.closest('.row');
    if (renaming) return;
    if (!row) {
      // Empty space: things that don't belong to any row.
      event.preventDefault();
      openMenu({ x: event.clientX, y: event.clientY, key: null }, {
        title: 'Tabbies',
        items: [
          { label: 'New window', run: () => act(api.openNewWindow()) },
          { label: 'Nap every window', hint: 'All tabs except pinned ones, into one nap', run: () => napAndOfferUndo(api.napAllWindows()) },
          { label: 'Close duplicate tabs everywhere', hint: 'Pages open more than once: keep one of each', run: () => closeDuplicates() },
        ],
      });
      return;
    }
    event.preventDefault(); // instead of the browser's own menu
    const point = { x: event.clientX, y: event.clientY, key: row.querySelector('.toggle, .tab-main')?.dataset.focusKey ?? null };
    // From the keyboard (Shift+F10 or the Menu key; event.button is 2 only
    // for the mouse) the menu opens under the row instead.
    const box = row.getBoundingClientRect();
    if (event.button !== 2) {
      point.x = box.left + 32;
      point.y = box.bottom;
    }

    if (row.matches('.tab')) {
      const tabId = Number(row.dataset.tabId);
      if (!selection.has(tabId)) {
        setSelection([tabId]);
        selectionAnchor = tabId;
      }
      openTabsMenu(point, selectionFor(tabId));
      return;
    }
    if (row.matches('.link')) {
      const linkId = row.dataset.linkId;
      if (!linkSelection.has(linkId)) {
        setSelection([]);
        toggleLinkSelected(linkId);
      }
      openLinksMenu(point);
      return;
    }
    const branch = row.parentElement;
    if (!row.classList.contains('is-selected')) selectBranch(branch, { ctrl: false, shift: false });
    if (branch.matches('.window')) {
      const win = windowsById.get(Number(branch.dataset.windowId));
      if (win) openWindowMenu(point, win);
    } else if (branch.matches('.group')) {
      const group = groupsById.get(Number(branch.dataset.groupId));
      if (group) openGroupMenu(point, group);
    } else if (branch.matches('.nap')) {
      const nap = napsById.get(branch.dataset.napId);
      if (nap) openNapMenu(point, nap);
    } else if (branch.matches('.naps')) {
      openNapsMenu(point);
    }
  }

  /** The right-click menu for one tab or several selected tabs. */
  function openTabsMenu(anchor, tabs) {
    if (tabs.length === 0) return;
    const one = tabs.length === 1 ? tabs[0] : null;
    const groupIds = [...new Set(tabs.map((tab) => tab.groupId).filter((id) => id !== -1))];
    openMenu(anchor, {
      title: one ? one.title || one.url : `${tabs.length} tabs`,
      items: [
        ...(one
          ? [
              { label: 'Switch to this tab', hint: 'Or double-click it', shortcut: 'Enter', run: () => { setSelection([]); switchTo(one); } },
              SEPARATOR,
            ]
          : []),
        { label: 'Nap', hint: 'Close and keep for later', shortcut: 'N', run: () => runTabsAction('nap', tabs) },
        { label: one ? 'Put in a new group' : 'Group', hint: 'Then type a name for it', shortcut: KEYS.group, run: () => runTabsAction('group', tabs) },
        ...(groupIds.length > 0
          ? [
              { label: 'Ungroup', hint: 'The tabs stay open', shortcut: KEYS.ungroup, run: () => runTabsAction('ungroup', tabs) },
              {
                label: 'Group color',
                swatches: GROUP_COLORS.map((color) => ({
                  value: color,
                  label: color,
                  checked: groupIds.length === 1 && groupsById.get(groupIds[0])?.color === color,
                })),
                run: (color) => act(api.recolorGroups(groupIds, color)),
              },
            ]
          : []),
        SEPARATOR,
        ...(one ? [{ label: 'New tab to the right', hint: 'In the same group, if it has one', run: () => newTab({ afterTabId: one.id }) }] : []),
        { label: one ? 'Duplicate' : `Duplicate ${tabs.length} tabs`, hint: 'Each copy opens next to its original', run: () => duplicate(tabs) },
        { label: 'Move to a new window', run: () => runTabsAction('new-window', tabs) },
        SEPARATOR,
        {
          label: tabs.every((tab) => tab.pinned) ? 'Unpin' : 'Pin',
          hint: 'Pinned tabs stay small at the start of the window',
          run: () => act(api.setTabsPinned(tabs, !tabs.every((tab) => tab.pinned))),
        },
        ...(one ? [{ label: one.muted ? 'Unmute' : 'Mute', run: () => act(api.setTabMuted(one, !one.muted)) }] : []),
        { label: 'Reload', run: () => act(api.reloadTabs(tabs), `Reloaded ${plural(tabs.length, 'tab')}`) },
        ...(tabs.some((tab) => !tab.discarded && !tab.active)
          ? [{ label: 'Sleep', hint: 'Unload to free memory; it loads again when you open it', run: () => sleep(api.sleepTabs(tabs)) }]
          : []),
        ...(one && one.copies > 1
          ? [{ label: 'Close its duplicates', hint: `This page is open in ${one.copies} tabs; keep just one`, run: () => closeDuplicatesOf(one) }]
          : []),
        SEPARATOR,
        { label: one ? 'Close tab' : `Close ${tabs.length} tabs`, hint: 'You can undo it', shortcut: KEYS.del, run: () => runTabsAction('close', tabs) },
      ],
    });
  }

  /** Waits for tabs to fall asleep and says how it went. */
  function sleep(sleeping) {
    setSelection([]); // sleeping tabs get new ids, so the old selection would point at nothing
    sleeping.then(
      ({ count, skipped }) => {
        const note = skipped > 0 ? ` · ${skipped} kept awake (open or playing sound)` : '';
        showToast(count > 0 ? `Put ${plural(count, 'tab')} to sleep${note}` : `Nothing to put to sleep${note}`);
      },
      (error) => showError('put those to sleep', error),
    );
  }

  /** Does this window have the same page open more than once? */
  function hasDuplicates(win) {
    const seen = new Set();
    for (const tab of tabsIn(win)) {
      if (tab.copies < 2) continue;
      const key = tab.url.split('#')[0];
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  }

  /** Closes duplicate tabs in one window (or everywhere), with Undo. */
  function closeDuplicates(windowId) {
    api.closeDuplicates(windowId).then(
      (undo) => {
        if (undo.count === 0) showToast('No duplicate tabs');
        else showToast(`Closed ${plural(undo.count, 'duplicate tab')}`, 'Undo', () => act(api.undoClose(undo), 'Close undone'));
      },
      (error) => showError('close the duplicates', error),
    );
  }

  /** Closes the other tabs showing the same page as `tab` (in any window), with Undo. */
  function closeDuplicatesOf(tab) {
    const key = tab.url.split('#')[0];
    const others = [];
    for (const win of snapshot.windows) {
      for (const t of tabsIn(win)) if (t.id !== tab.id && t.url.split('#')[0] === key) others.push(t.id);
    }
    setSelection([]);
    api.closeTabs(others).then(
      (undo) => showToast(`Closed ${plural(undo.count, 'duplicate tab')}`, 'Undo', () => act(api.undoClose(undo), 'Close undone')),
      (error) => showError('close the duplicates', error),
    );
  }

  /** Duplicates tabs (each copy next to its original), with Undo. */
  function duplicate(tabs) {
    api.duplicateTabs(tabs).then(
      (copies) => showToast(`Duplicated ${plural(copies.length, 'tab')}`, 'Undo', () => act(api.undoDuplicate(copies), 'Duplicate undone')),
      (error) => showError('duplicate that', error),
    );
  }

  /** Opens a new tab and switches to it (the popup then closes, like after switching tabs). */
  function newTab(where) {
    setSelection([]);
    act(api.openNewTab(where).then(onTabActivated));
  }

  /** The right-click menu for one or more selected napped links. */
  function openLinksMenu(anchor) {
    const count = linkSelection.size;
    openMenu(anchor, {
      title: count === 1 ? linksById.get([...linkSelection][0])?.title || 'Link' : `${count} links`,
      items: [
        { label: 'Wake', hint: 'Open in this window', shortcut: 'Enter', run: () => runLinksAction('wake') },
        { label: 'Wake in a new window', run: () => runLinksAction('wake-window') },
        SEPARATOR,
        { label: 'Delete', hint: 'You can undo it', shortcut: KEYS.del, run: () => runLinksAction('delete') },
      ],
    });
  }

  /** Double-click: switch to a tab, wake a napped link, or fold/unfold a window, group or nap. */
  function onDoubleClick(button, action) {
    if (renaming) return;
    if (action === 'toggle') {
      setExpanded(button, button.getAttribute('aria-expanded') !== 'true');
    } else if (action === 'activate') {
      const tab = tabsById.get(Number(button.closest('[data-tab-id]').dataset.tabId));
      if (!tab) return;
      setSelection([]);
      selectionAnchor = tab.id;
      switchTo(tab);
    } else if (action === 'wake-link') {
      const nap = napsById.get(button.closest('[data-nap-id]')?.dataset.napId);
      if (!nap) return;
      setSelection([]);
      wake(nap, { linkIds: [button.closest('[data-link-id]').dataset.linkId], where: 'here', activate: true });
    }
  }

  /** Called by drag-drop.js with what was dropped and the MoveTarget it resolved. */
  function moveItem(source, target) {
    if (source.kind === 'links' || source.kind === 'nap') {
      moveNapped(source, target);
      return;
    }
    if (target.nap) {
      // Dropped on the nap zone, the Naps section (new nap) or one nap (add to it).
      const intoNapId = target.napId;
      if (source.kind === 'tab') napAndOfferUndo(api.napTabs(source.items.map((tab) => tab.id), { intoNapId }));
      else if (source.kind === 'group') napGroup(source.item, intoNapId);
      else {
        const unpinned = [...tabsIn(source.item)].filter((tab) => !tab.pinned).map((tab) => tab.id);
        napAndOfferUndo(api.napTabs(unpinned, { intoNapId }));
      }
      return;
    }
    const where = target.newWindow ? 'a new window' : windowLabel(target.windowId);
    if (source.kind === 'tab') {
      const what = source.items.length === 1 ? `“${source.items[0].title}”` : `${source.items.length} tabs`;
      act(api.moveTabs(source.items, target), `Moved ${what} to ${where}`);
    } else if (source.kind === 'group') {
      const name = source.item.title || 'unnamed group';
      act(api.moveGroup(source.item, target), `Moved group “${name}” to ${where}`);
    } else {
      act(api.mergeWindow(source.item, target.windowId), `Merged its tabs into ${where}`);
    }
  }

  /** Napped links or a whole nap were dropped: rearrange the naps, or wake them there. */
  function moveNapped(source, target) {
    const linkIds = source.kind === 'links' ? source.items.map((link) => link.id) : source.item.links.map((l) => l.id);
    if (target.napOrder) {
      act(api.moveNap(source.item.id, target), `Moved “${napName(source.item)}”`);
    } else if (target.napMove || target.nap) {
      const to = target.napMove ? target : { newNap: true };
      act(api.moveNapLinks(linkIds, to), `Moved ${plural(linkIds.length, 'link')}`);
    } else {
      // A nap that came from a tab group wakes as that group again.
      const group = source.kind === 'nap' && source.item.color ? { title: napName(source.item), color: source.item.color } : undefined;
      setSelection([]);
      api.wakeLinks(linkIds, target, { group }).then(
        (undo) => {
          if (undo) showToast(`Woke ${plural(undo.count, 'tab')}`, 'Undo', () => act(api.undoWake(undo), 'Wake undone'));
        },
        (error) => showError('wake those', error),
      );
    }
  }

  function switchTo(tab) {
    act(api.activateTab(tab).then(onTabActivated));
  }

  // Arrow keys move through the tree like a file explorer;
  // Shift+↑/↓ extends the selection from tab to tab.
  function onTreeKeydown(event) {
    const row = event.target.closest('.row');
    if (!row || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.shiftKey) {
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && row.matches('.tab')) {
        event.preventDefault();
        extendSelection(row, event.key === 'ArrowDown' ? 1 : -1);
      }
      return;
    }
    const toggle = row.querySelector('.toggle');
    const expanded = toggle?.getAttribute('aria-expanded') === 'true';

    switch (event.key) {
      case 'ArrowDown':
        focusRelativeRow(row, 1);
        break;
      case 'ArrowUp':
        focusRelativeRow(row, -1);
        break;
      case 'ArrowRight':
        if (toggle && !expanded) setExpanded(toggle, true);
        else if (toggle) focusRelativeRow(row, 1);
        break;
      case 'F2': {
        // Rename the window, group or nap in place, like a file.
        const name = row.querySelector('.toggle .renamable');
        if (!name) return;
        startRename(name);
        break;
      }
      case 'ArrowLeft':
        if (toggle && expanded) setExpanded(toggle, false);
        else focusParentRow(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  function onSearchKeydown(event) {
    // While an input method (Korean, Japanese, Chinese, ...) is composing text,
    // Enter/Escape/arrows belong to the IME, not to us.
    if (event.isComposing) return;
    if (event.key === 'Escape' && searchInput.value) {
      event.preventDefault();
      setQuery('');
    } else if (event.key === 'Enter') {
      // Enter switches to the first match: open Tabbies, type, Enter.
      const tab = firstMatch();
      if (tab) switchTo(tab);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRow(visibleRows()[0]);
    }
  }

  // Page-wide keys (not while typing in the search box):
  //   /       jump to the search box
  //   Ctrl+A  select every tab you can see (e.g. all search results)
  //   Esc     clear the selection
  function onDocumentKeydown(event) {
    // Already handled (e.g. Esc clearing the search), meant for a menu or
    // dialog, or the explorer is hidden (Settings is showing).
    if (event.defaultPrevented || menu.contains(event.target) || dialog.open || !container.checkVisibility()) return;
    const typing =
      event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]');
    const ctrl = event.ctrlKey || event.metaKey;

    if (event.key === '/' && !ctrl && !event.altKey && !typing) {
      event.preventDefault();
      focusSearch();
    } else if (event.key.toLowerCase() === 'a' && ctrl && !event.altKey && !event.shiftKey && !typing) {
      event.preventDefault();
      setSelection(visibleTabIds());
    } else if (event.key === 'Escape' && selection.size + linkSelection.size > 0 && !(typing && searchInput.value)) {
      // In the popup this also stops Esc from closing it while tabs are selected.
      event.preventDefault();
      setSelection([]);
    } else if (!typing && !renaming && !event.altKey && onSelectionKey(event, ctrl)) {
      event.preventDefault();
    }
  }

  /**
   * Keys for what's selected (or, with nothing selected, the focused row),
   * the same as in the right-click menu:
   *   Ctrl+Z undo · Space select/unselect the focused row · Del (or
   *   Backspace) close tabs / delete napped links · Ctrl+G group ·
   *   Ctrl+Shift+G ungroup · N nap.
   * Returns true when the key was used.
   */
  function onSelectionKey(event, ctrl) {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === 'z' && ctrl && !event.shiftKey) {
      undoLast();
      return true;
    }
    const row = document.activeElement?.closest?.('.row');
    const focused = row && tree.contains(row) ? row : null;

    if (key === ' ' && !ctrl && focused) {
      if (focused.matches('.tab')) toggleSelected(Number(focused.dataset.tabId));
      else if (focused.matches('.link')) toggleLinkSelected(focused.dataset.linkId);
      else selectBranch(focused.parentElement, { ctrl: true, shift: false });
      return true;
    }

    // Napped links: Del deletes them, Enter is handled by the row itself.
    const focusedLink = focused?.matches('.link') ? focused.dataset.linkId : null;
    if (linkSelection.size > 0 || (selection.size === 0 && focusedLink)) {
      if ((key === 'Delete' || key === 'Backspace') && !ctrl) {
        if (linkSelection.size === 0) toggleLinkSelected(focusedLink);
        runLinksAction('delete');
        return true;
      }
      return false;
    }

    const focusedTab = focused?.matches('.tab') ? Number(focused.dataset.tabId) : null;
    const tabs = selection.size > 0 ? selectionFor([...selection][0]) : focusedTab !== null ? selectionFor(focusedTab) : [];
    if (tabs.length === 0) return false;
    if ((key === 'Delete' || key === 'Backspace') && !ctrl) runTabsAction('close', tabs);
    else if (key === 'g' && ctrl && !event.shiftKey) runTabsAction('group', tabs);
    else if (key === 'g' && ctrl && event.shiftKey) {
      if (!tabs.some((tab) => tab.groupId !== -1)) return false;
      runTabsAction('ungroup', tabs);
    }
    else if (key === 'n' && !ctrl && !event.shiftKey) runTabsAction('nap', tabs);
    else return false;
    return true;
  }

  function onImageError(event) {
    const img = event.target;
    if (img instanceof HTMLImageElement && img.classList.contains('favicon')) {
      img.replaceWith(fallbackFavicon());
    }
  }

  function setQuery(value) {
    if (searchInput.value !== value) searchInput.value = value;
    if (value === query) return;
    query = value;
    collapsedWhileSearching.clear();
    scheduleRender();
  }

  function setExpanded(toggle, expanded) {
    const key = toggle.dataset.key;
    if (expanded) activeCollapsedSet().delete(key);
    else activeCollapsedSet().add(key);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.closest('.branch').querySelector(':scope > .children').hidden = !expanded;
    if (!expanded) pruneSelection();
  }

  // ---- Selection ----------------------------------------------------------------------

  /** Ids of the tab rows you can see right now, top to bottom. */
  function visibleTabIds() {
    return visibleRows()
      .filter((row) => row.matches('.tab'))
      .map((row) => Number(row.dataset.tabId));
  }

  function setSelection(ids) {
    selection.clear();
    linkSelection.clear();
    for (const id of ids) selection.add(id);
    showSelection();
  }

  function toggleSelected(tabId) {
    linkSelection.clear();
    if (selection.has(tabId)) selection.delete(tabId);
    else selection.add(tabId);
    selectionAnchor = tabId;
    showSelection();
  }

  /** Selects every visible tab from the anchor to `tabId`. */
  function selectRange(tabId, addToSelection) {
    const ids = visibleTabIds();
    const from = ids.indexOf(selectionAnchor);
    const to = ids.indexOf(tabId);
    if (from === -1) {
      toggleSelected(tabId);
      return;
    }
    if (!addToSelection) selection.clear();
    linkSelection.clear();
    for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) selection.add(id);
    showSelection();
  }

  /**
   * What a window, group or nap row stands for when it's selected: the tabs
   * (or napped links) listed in it, collapsed or not. While searching, only
   * the matching ones are listed.
   */
  function branchItems(branch) {
    const tabIds = [...branch.querySelectorAll('.tab')].map((row) => Number(row.dataset.tabId));
    if (tabIds.length > 0 || branch.matches('.window, .group')) return { kind: 'tabs', ids: tabIds };
    return { kind: 'links', ids: [...branch.querySelectorAll('.link')].map((row) => row.dataset.linkId) };
  }

  /**
   * Clicking a window, group or nap selects it, like a folder: all its tabs
   * (or links). Ctrl+click adds it to the selection, or takes it out if it
   * was already selected. Shift+click selects everything from the last
   * clicked item through it (Ctrl+Shift adds that to the selection).
   */
  function selectBranch(branch, { ctrl, shift }) {
    const { kind, ids } = branchItems(branch);
    const chosen = kind === 'tabs' ? selection : linkSelection;
    (kind === 'tabs' ? linkSelection : selection).clear();
    if (shift && selectBranchRange(kind, ids, ctrl)) return;
    if (!ctrl && !shift) chosen.clear();
    const allIn = ids.length > 0 && ids.every((id) => chosen.has(id));
    for (const id of ids) {
      if (ctrl && !shift && allIn) chosen.delete(id);
      else chosen.add(id);
    }
    if (kind === 'tabs') selectionAnchor = ids[0] ?? null;
    else linkAnchor = ids[0] ?? null;
    showSelection();
  }

  /**
   * Shift+click on a window, group or nap: from the anchor (the last item
   * clicked) to its far end, so all of it is included. Rows hidden in other
   * collapsed groups along the way are skipped, as with Shift+click on tabs.
   * Returns false when there is no anchor to start from.
   */
  function selectBranchRange(kind, ids, addToSelection) {
    if (ids.length === 0) return false;
    const rows = [...tree.querySelectorAll(kind === 'tabs' ? '.tab' : '.link')];
    const order = rows.map((row) => (kind === 'tabs' ? Number(row.dataset.tabId) : row.dataset.linkId));
    const from = order.indexOf(kind === 'tabs' ? selectionAnchor : linkAnchor);
    if (from === -1) return false;
    const first = order.indexOf(ids[0]);
    const last = order.indexOf(ids.at(-1));
    const [low, high] = from <= first ? [from, last] : [first, from];
    const chosen = kind === 'tabs' ? selection : linkSelection;
    const inBranch = new Set(ids);
    if (!addToSelection) chosen.clear();
    for (let i = low; i <= high; i++) {
      if (inBranch.has(order[i]) || rows[i].checkVisibility()) chosen.add(order[i]);
    }
    showSelection();
    return true;
  }

  /** Clicking a selected window, group or nap again: unselect it, or keep just it if more was selected. */
  function reselectBranch(branch) {
    const { kind, ids } = branchItems(branch);
    const chosen = kind === 'tabs' ? selection : linkSelection;
    if (chosen.size === ids.length) setSelection([]);
    else selectBranch(branch, { ctrl: false, shift: false });
  }

  /** Ids of the napped-link rows you can see right now, top to bottom. */
  function visibleLinkIds() {
    return visibleRows()
      .filter((row) => row.matches('.link'))
      .map((row) => row.dataset.linkId);
  }

  function toggleLinkSelected(linkId) {
    selection.clear();
    if (linkSelection.has(linkId)) linkSelection.delete(linkId);
    else linkSelection.add(linkId);
    linkAnchor = linkId;
    showSelection();
  }

  function selectLinkRange(linkId, addToSelection) {
    const ids = visibleLinkIds();
    const from = ids.indexOf(linkAnchor);
    const to = ids.indexOf(linkId);
    if (from === -1) {
      toggleLinkSelected(linkId);
      return;
    }
    selection.clear();
    if (!addToSelection) linkSelection.clear();
    for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) linkSelection.add(id);
    showSelection();
  }

  /** Like selectionFor, for napped links: the whole link selection, or just that link. */
  function linkSelectionFor(linkId) {
    if (!linkSelection.has(linkId)) {
      if (selection.size > 0 || linkSelection.size > 0) setSelection([]);
      const link = linksById.get(linkId);
      return link ? [link] : [];
    }
    return [...linksById.values()].filter((link) => linkSelection.has(link.id));
  }

  /** Shift+↑/↓: move to the next tab row and select from the anchor to it. */
  function extendSelection(row, step) {
    const rows = visibleRows().filter((r) => r.matches('.tab'));
    const next = rows[rows.indexOf(row) + step];
    if (!next) return;
    if (selection.size === 0 || selectionAnchor === null) selectionAnchor = Number(row.dataset.tabId);
    selectRange(Number(next.dataset.tabId), false);
    focusRow(next);
  }

  function pruneSelection() {
    // Rows inside a collapsed window or group are still in the tree (hidden),
    // so a selected, collapsed window keeps its tabs selected.
    const listed = new Set([...tree.querySelectorAll('.tab')].map((row) => Number(row.dataset.tabId)));
    for (const id of selection) if (!listed.has(id)) selection.delete(id);
    const listedLinks = new Set([...tree.querySelectorAll('.link')].map((row) => row.dataset.linkId));
    for (const id of linkSelection) if (!listedLinks.has(id)) linkSelection.delete(id);
    showSelection();
  }

  function showSelection() {
    for (const row of tree.querySelectorAll('.tab')) {
      row.classList.toggle('is-selected', selection.has(Number(row.dataset.tabId)));
    }
    for (const row of tree.querySelectorAll('.link')) {
      row.classList.toggle('is-selected', linkSelection.has(row.dataset.linkId));
    }
    // A window, group or nap looks selected when everything in it is.
    for (const branch of tree.querySelectorAll('.branch')) {
      const { kind, ids } = branchItems(branch);
      const chosen = kind === 'tabs' ? selection : linkSelection;
      const whole = ids.length > 0 && ids.every((id) => chosen.has(id));
      branch.firstElementChild.classList.toggle('is-selected', whole);
      branch.classList.toggle('is-selected-branch', whole);
    }
    // The bar offers what fits: Nap / New window for tabs, Wake / Delete for napped links.
    const mode = linkSelection.size > 0 ? 'links' : 'tabs';
    const count = mode === 'links' ? linkSelection.size : selection.size;
    selectionBar.hidden = count === 0;
    // "3 tabs selected"; narrow views drop the noun ("3 selected").
    selectionCount.replaceChildren(
      String(count),
      h('span', { class: 'button-text' }, ` ${count === 1 ? (mode === 'links' ? 'link' : 'tab') : mode === 'links' ? 'links' : 'tabs'}`),
      ' selected',
    );
    const grouped = mode === 'tabs' && selectedGroupIds().length > 0;
    for (const button of selectionBar.querySelectorAll('[data-for]')) {
      button.hidden = button.dataset.for !== mode || (button.dataset.needs === 'grouped' && !grouped);
    }
    updateSummary();
  }

  /**
   * The tabs to drag when `tabId` is picked up: the whole selection (in
   * tab-strip order) if that tab is part of it; otherwise just that tab, and
   * the selection is cleared, as in a file explorer.
   */
  function selectionFor(tabId) {
    if (!selection.has(tabId)) {
      if (selection.size > 0) setSelection([]);
      const tab = tabsById.get(tabId);
      return tab ? [tab] : [];
    }
    const tabs = [];
    for (const win of snapshot.windows) {
      for (const tab of tabsIn(win)) if (selection.has(tab.id)) tabs.push(tab);
    }
    return tabs;
  }

  /** The groups that the selected tabs are in. */
  function selectedGroupIds() {
    const ids = new Set();
    for (const id of selection) {
      const groupId = tabsById.get(id)?.groupId;
      if (groupId !== undefined && groupId !== -1) ids.add(groupId);
    }
    return [...ids];
  }

  /** Tabs you multi-selected in Chrome's own tab strip start out selected here. */
  function seedSelection() {
    if (selectionSeeded) return;
    selectionSeeded = true;
    for (const win of snapshot.windows) {
      const highlighted = [...tabsIn(win)].filter((tab) => tab.highlighted);
      if (highlighted.length > 1) for (const tab of highlighted) selection.add(tab.id);
    }
  }

  // ---- Menus --------------------------------------------------------------------------

  /**
   * Opens the shared menu under `button`.
   * items: [{ label, hint?, checked?, run() }]; checked makes it a checkbox item.
   */
  /**
   * Opens the popup menu under `anchor`: a button (⋯, the selection bar), or
   * a point { x, y, key } for a right-click menu (key: the focus key of the
   * row's button, to return focus to).
   */
  function openMenu(anchor, { title, items, note }) {
    const point = anchor instanceof Element ? null : anchor;
    const key = point ? point.key : anchor.dataset.focusKey;
    if (!point) {
      // Clicking the same ⋯ again closes its menu. (Pressing outside an open
      // menu already closed it a moment ago; without this, the click that
      // follows would open it right back up.)
      if (menu.matches(':popover-open') && menuOpenerKey === key) {
        menu.hidePopover();
        return;
      }
      const closedByThisPress = lastPress.key === key && menuClosed.key === key && Math.abs(menuClosed.at - lastPress.at) < 400;
      if (closedByThisPress) return;
    }
    menuItems = items;
    menuOpenerKey = key;
    menu.setAttribute('aria-label', title);
    const footer = note ? [h('p', { class: 'menu-note' }, note)] : [];
    menu.replaceChildren(
      h('p', { class: 'menu-title' }, title),
      ...items.map((item, index) =>
        item.swatches
          ? // A row of color dots (e.g. a group's color), the current one ringed.
            h(
              'div',
              { class: 'menu-swatches', role: 'group', 'aria-label': item.label },
              ...item.swatches.map((swatch) =>
                h('button', {
                  class: 'menu-swatch',
                  type: 'button',
                  role: 'menuitemradio',
                  'aria-checked': String(swatch.checked),
                  'aria-label': swatch.label,
                  title: swatch.label[0].toUpperCase() + swatch.label.slice(1),
                  'data-index': index,
                  'data-value': swatch.value,
                  'data-color': swatch.value,
                }),
              ),
            )
          : item.separator
            ? h('div', { class: 'menu-separator', role: 'separator' })
            : h(
          'button',
          {
            class: 'menu-item',
            type: 'button',
            role: item.checked === undefined ? 'menuitem' : 'menuitemcheckbox',
            'aria-checked': item.checked === undefined ? null : String(item.checked),
            'aria-keyshortcuts': item.shortcut ?? null,
            // One line per item; the longer explanation is its tooltip.
            title: item.hint ?? null,
            'data-index': index,
          },
          h('span', { class: 'menu-label' }, item.label),
          item.shortcut && h('kbd', { class: 'menu-shortcut' }, item.shortcut),
        ),
      ),
      ...footer,
    );
    if (menu.matches(':popover-open')) menu.hidePopover(); // a right-click while one is open
    menu.showPopover();
    // Under the button (lined up with its right edge), or at the mouse with
    // the menu to its right; flipped up if there's no room below.
    const box = menu.getBoundingClientRect();
    const at = point ? { left: point.x, right: point.x + box.width, top: point.y, bottom: point.y } : anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(at.right - box.width, innerWidth - box.width - 8));
    let top = at.bottom + (point ? 0 : 4);
    if (top + box.height > innerHeight - 8) top = Math.max(8, at.top - box.height - (point ? 0 : 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelector('.menu-item, .menu-swatch[aria-checked="true"], .menu-swatch')?.focus();
  }

  function onMenuClick(event) {
    const item = event.target.closest('.menu-item, .menu-swatch');
    if (!item) return;
    const { run } = menuItems[Number(item.dataset.index)];
    menu.hidePopover();
    run(item.dataset.value);
  }

  function onMenuKeydown(event) {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const items = [...menu.querySelectorAll('.menu-item, .menu-swatch')];
    const index = items.indexOf(document.activeElement);
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
    items[(index + step + items.length) % items.length].focus();
  }

  // When the menu closes (Esc, outside click, or a choice), put keyboard
  // focus back on the button it came from, unless something else took it.
  function onMenuToggle(event) {
    if (event.newState !== 'closed' || dialog.open || renaming) return;
    if (menu.contains(document.activeElement) || document.activeElement === document.body) {
      const button = menuOpenerKey && tree.querySelector(`[data-focus-key="${CSS.escape(menuOpenerKey)}"]`);
      button?.focus({ preventScroll: true });
    }
  }

  function openSortMenu(anchor, windowId) {
    openMenu(anchor, {
      title: 'Sort this window',
      note: 'Groups stay together. Pinned tabs stay put.',
      items: SORT_ORDERS.map((order) => ({
        label: order.label,
        hint: order.hint,
        run: () =>
          api.sortWindow(windowId, order.id).then(
            (previous) => {
              const text = `Sorted ${windowLabel(windowId)} ${order.done}`;
              showToast(text, 'Undo', () => act(api.arrangeWindow(windowId, previous), 'Sort undone'));
            },
            (error) => {
              console.warn('Tabbies: could not sort', error);
              refresh();
            },
          ),
      })),
    });
  }

  // ---- Naps ---------------------------------------------------------------------------

  function napGroup(group, intoNapId) {
    napAndOfferUndo(api.napGroup(group.id, { intoNapId }));
  }

  /** Waits for a nap to finish, then offers to undo it. */
  function napAndOfferUndo(napping) {
    // Say something right away, and again if Chrome takes unusually long,
    // so a nap that stalls is never silent.
    showToast('Napping…');
    const slow = setTimeout(() => showToast('Still napping: Chrome hasn’t finished closing the tabs yet'), 4000);
    napping.finally(() => clearTimeout(slow));
    napping.then(
      (undo) => {
        if (!undo?.count && !undo?.closedEmpty) {
          // Say which tabs were left open and why, if we know.
          const skipped = undo?.skipped ?? [];
          const list = skipped.slice(0, 3).join(', ') + (skipped.length > 3 ? ` and ${skipped.length - 3} more` : '');
          showToast(skipped.length > 0 ? `Nothing to nap: ${list}` : 'Nothing to nap: pinned and Tabbies tabs stay open');
          return;
        }
        // Empty new tabs are closed too, but there's nothing in them to save.
        const empties = undo.closedEmpty ? plural(undo.closedEmpty, 'empty tab') : '';
        const text = !undo.count
          ? `Closed ${empties} (nothing to save)`
          : `Napped ${plural(undo.count, 'tab')}${empties ? ` · closed ${empties}` : ''}`;
        showToast(text, 'Undo', () => act(api.undoNap(undo), 'Nap undone'));
      },
      (error) => showError('nap', error),
    );
  }

  /** Opens some or all of a nap's links again (see wakeNap in naps-api.js). */
  function wake(nap, options) {
    api.wakeNap(nap.id, options).then(
      (undo) => {
        if (!undo) return;
        if (options.activate) onTabActivated();
        showToast(`Woke ${plural(undo.count, 'tab')}`, 'Undo', () => act(api.undoWake(undo), 'Wake undone'));
      },
      (error) => showError('wake', error),
    );
  }

  function deleteAndOfferUndo(nap, linkIds) {
    api.deleteFromNap(nap.id, linkIds).then(
      (undo) => {
        if (!undo) return;
        const what = linkIds ? plural(linkIds.length, 'link') : `“${napName(nap)}”`;
        showToast(`Deleted ${what}`, 'Undo', () => act(api.putBackNap(undo), 'Delete undone'));
      },
      (error) => showError('delete', error),
    );
  }

  function openWindowMenu(button, win) {
    const label = windowLabel(win.id);
    openMenu(button, {
      title: label,
      items: [
        { label: 'Nap this window', hint: 'Same as its cat button', run: () => napAndOfferUndo(api.napWindow(win.id)) },
        { label: 'Sort tabs…', hint: 'By site, title or when you last used them', run: () => openSortMenu(button, win.id) },
        SEPARATOR,
        { label: 'New tab', hint: 'At the end of this window', run: () => newTab({ windowId: win.id }) },
        { label: 'New window', run: () => act(api.openNewWindow()) },
        SEPARATOR,
        { label: 'Sleep other tabs', hint: 'Unload every tab except the open one, to free memory', run: () => sleep(api.sleepOtherTabs(win.id)) },
        ...(hasDuplicates(win)
          ? [{ label: 'Close duplicate tabs', hint: 'Pages open more than once in this window: keep one of each', run: () => closeDuplicates(win.id) }]
          : []),
        SEPARATOR,
        { label: 'Rename window', hint: 'Or select it and click its name', shortcut: 'F2', run: () => renameWindowInPlace(win.id) },
        ...(win.name ? [{ label: 'Remove name', hint: 'Show it as a numbered window again', run: () => act(api.renameWindow(win.id, '')) }] : []),
        SEPARATOR,
        {
          label: 'Close window',
          hint: `Closes its ${plural(win.tabCount, 'tab')}. Undo brings them back.`,
          run: () => closeWindow(win),
        },
      ],
    });
  }

  function openGroupMenu(button, group) {
    openMenu(button, {
      title: group.title || 'Unnamed group',
      items: [
        {
          label: 'Rename group',
          hint: 'Or select it and click its name',
          shortcut: 'F2',
          run: () => startRename(tree.querySelector(`.branch.group[data-group-id="${group.id}"] > .row .renamable`)),
        },
        {
          label: 'Color',
          swatches: GROUP_COLORS.map((color) => ({ value: color, label: color, checked: color === group.color })),
          run: (color) => act(api.recolorGroup(group.id, color)),
        },
        SEPARATOR,
        { label: 'New tab in group', hint: 'At the end of the group', run: () => newTab({ afterTabId: group.tabs.at(-1).id }) },
        SEPARATOR,
        {
          label: 'Ungroup',
          hint: 'Keeps the tabs open, just not in a group',
          shortcut: KEYS.ungroup,
          run: () => ungroupGroup(group),
        },
        SEPARATOR,
        {
          label: 'Close group',
          hint: `Closes its ${plural(group.tabs.length, 'tab')}. Undo brings them back.`,
          run: () => closeGroup(group),
        },
      ],
    });
  }

  /** The color dots for one or more groups; `current` is ringed. */
  function openColorMenu(button, groupIds, current) {
    openMenu(button, {
      title: groupIds.length === 1 ? 'Group color' : `Color of ${groupIds.length} groups`,
      items: [
        {
          label: 'Color',
          swatches: GROUP_COLORS.map((color) => ({ value: color, label: color, checked: color === current })),
          run: (color) => act(api.recolorGroups(groupIds, color)),
        },
      ],
    });
  }

  /** Dissolves a group (its tabs stay open), with Undo. */
  function ungroupGroup(group) {
    api.ungroup(group.id).then(
      (undo) => showToast(`Ungrouped ${groupLabel(group)}`, 'Undo', () => act(api.undoUngroup(undo), 'Ungroup undone')),
      (error) => showError('ungroup that', error),
    );
  }

  /** Closes a group's tabs (so the group goes away), with Undo. */
  function closeGroup(group) {
    api.closeTabs(group.tabs.map((tab) => tab.id)).then(
      (undo) => showToast(`Closed ${groupLabel(group)}`, 'Undo', () => act(api.undoClose(undo), 'Close undone')),
      (error) => showError('close that group', error),
    );
  }

  /** Closes all of a window's tabs (so the window closes), with Undo. */
  function closeWindow(win) {
    const label = windowLabel(win.id);
    api.closeTabs([...tabsIn(win)].map((tab) => tab.id)).then(
      (undo) => showToast(`Closed ${label}`, 'Undo', () => act(api.undoClose(undo), 'Close undone')),
      (error) => showError('close that window', error),
    );
  }

  function renameWindowInPlace(windowId) {
    startRename(tree.querySelector(`.branch.window[data-window-id="${windowId}"] > .row .renamable`));
  }

  /**
   * Edits a window's or nap's name right where it is, like renaming a file:
   * Enter or clicking away saves, Esc cancels, an empty name goes back to the
   * default ("Window 2", or the nap's date).
   */
  function startRename(label, { byMouse = false } = {}) {
    if (!label || renaming) return;
    const row = label.closest('.row');
    const branch = row.parentElement;
    const kind = branch.matches('.window') ? 'window' : branch.matches('.group') ? 'group' : 'nap';
    const item =
      kind === 'window'
        ? windowsById.get(Number(branch.dataset.windowId))
        : kind === 'group'
          ? groupsById.get(Number(branch.dataset.groupId))
          : napsById.get(branch.dataset.napId);
    if (!item) return;
    const current = (kind === 'window' ? item.name : item.title) ?? '';

    renaming = true;
    const input = h('input', {
      class: 'rename-input',
      type: 'text',
      value: current,
      placeholder: label.dataset.placeholder,
      spellcheck: 'false',
      'aria-label': { window: 'Window name', group: 'Group name', nap: 'Nap name' }[kind],
    });
    // Lay the text box exactly over the name, in the same font.
    const rowBox = row.getBoundingClientRect();
    const box = label.getBoundingClientRect();
    input.style.font = getComputedStyle(label).font;
    input.style.fontStyle = 'normal'; // not the italic of "Unnamed group"
    input.style.left = `${box.left - rowBox.left}px`;
    input.style.width = `${Math.max(box.width + 48, 200)}px`;
    row.append(input);
    label.style.visibility = 'hidden';
    row.draggable = false; // so selecting text in the box doesn't drag the row
    input.focus();
    input.select();

    let finished = false;
    const finish = (save) => {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      input.remove();
      label.style.visibility = '';
      row.draggable = true;
      renaming = false;
      renameEndedAt = performance.now();
      row.querySelector('.toggle')?.focus({ preventScroll: true });
      if (save && value !== current) {
        const rename = { window: api.renameWindow, group: api.renameGroup, nap: api.renameNap }[kind];
        act(rename(item.id, value));
      } else if (renderAfterDrag) {
        renderAfterDrag = false;
        render();
      }
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation(); // keep arrows, Esc, "/" etc. for the text box
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => {
      // The page itself lost focus (you switched windows, or Chrome showed a
      // popup such as its tab-groups tip): keep the name box, and type on
      // when you come back.
      if (!document.hasFocus()) {
        window.addEventListener('focus', () => finished || input.focus(), { once: true });
        return;
      }
      finish(true);
    });
    // A rename started by clicking the name also ends when the mouse leaves
    // the row, keeping what was typed (like clicking away). One started any
    // other way (F2, a menu, a new group) only ends with Enter, Esc or
    // clicking away, wherever the mouse is.
    if (byMouse) row.addEventListener('mouseleave', () => finish(true), { once: true });
    input.addEventListener('click', (event) => event.stopPropagation());
  }

  function openNapMenu(button, nap) {
    openMenu(button, {
      title: napName(nap),
      items: [
        { label: 'Wake here', hint: 'Open the tabs in this window', run: () => wake(nap, { where: 'here' }) },
        { label: 'Wake as a group', hint: 'Open them as one tab group', run: () => wake(nap, { where: 'group' }) },
        { label: 'Wake in a new window', run: () => wake(nap, { where: 'window' }) },
        { label: 'Rename', hint: 'Or click its name', run: () => startRename(tree.querySelector(`.branch.nap[data-nap-id="${nap.id}"] > .row .renamable`)) },
        { label: 'Delete', hint: `Forget these ${plural(nap.links.length, 'link')}`, run: () => deleteAndOfferUndo(nap) },
      ],
    });
  }

  function openNapsMenu(button) {
    const keep = Boolean(snapshot?.settings.keepAfterWaking);
    openMenu(button, {
      title: 'Naps',
      items: [
        {
          label: 'Nap every window',
          hint: 'All tabs except pinned ones, into one nap',
          run: () => napAndOfferUndo(api.napAllWindows()),
        },
        { label: 'Import links…', run: importDialog },
        { label: 'Export links…', run: exportDialog },
        ...(snapshot?.naps.length ? [{ label: 'Delete all naps…', hint: 'Asks first; you can undo it', run: deleteAllDialog }] : []),
        {
          label: 'Keep links after waking',
          hint: 'Waking opens tabs but leaves the nap as it is',
          checked: keep,
          run: () => act(api.saveSettings({ keepAfterWaking: !keep })),
        },
      ],
    });
  }

  // ---- Dialogs ------------------------------------------------------------------------

  /**
   * Opens the shared dialog. `input` shows a one-line text box, `area` a big
   * one. `onConfirm(value)` runs when the main button is pressed.
   */
  function openDialog({ title, text, input, area, confirmLabel, onConfirm }) {
    dialogTitle.textContent = title;
    dialogText.textContent = text ?? '';
    dialogText.hidden = !text;
    dialogInput.hidden = !input;
    dialogArea.hidden = !area;
    const field = input ? dialogInput : dialogArea;
    for (const [element, options] of [[dialogInput, input], [dialogArea, area]]) {
      element.value = options?.value ?? '';
      element.placeholder = options?.placeholder ?? '';
      element.readOnly = Boolean(options?.readOnly);
    }
    dialogConfirm.textContent = confirmLabel;
    dialogAction = () => onConfirm(field.value);
    dialog.showModal();
    field.focus();
    field.select();
  }

  function onDialogSubmit() {
    // <form method="dialog"> closes the dialog by itself after this.
    dialogAction?.();
    dialogAction = null;
  }

  function deleteAllDialog() {
    const links = snapshot.naps.reduce((sum, nap) => sum + nap.links.length, 0);
    openDialog({
      title: 'Delete all naps?',
      text: `This deletes all ${plural(links, 'link')} in ${plural(snapshot.naps.length, 'nap')}. You can undo it right after, from the message at the bottom.`,
      confirmLabel: 'Delete all',
      onConfirm: () =>
        api.deleteAllNaps().then(
          (undo) => showToast(`Deleted ${plural(undo.count, 'link')}`, 'Undo', () => act(api.putBackNaps(undo), 'Delete undone')),
          (error) => showError('delete the naps', error),
        ),
    });
  }

  function importDialog() {
    openDialog({
      title: 'Import links',
      text:
        'Paste links, one per line as "URL | Title". A blank line starts a new nap. ' +
        'Each line is "URL | Title", and a blank line starts a new list.',
      area: { placeholder: 'https://example.com | Example page' },
      confirmLabel: 'Import',
      onConfirm: (value) =>
        api.importNaps(value).then(
          (undo) => {
            if (undo.count === 0) {
              showToast('No links found to import');
              return;
            }
            const text = `Imported ${plural(undo.count, 'link')} in ${plural(undo.lists, 'nap')}`;
            showToast(text, 'Undo', () => act(api.removeImported(undo), 'Import undone'));
          },
          (error) => console.warn('Tabbies: could not import', error),
        ),
    });
  }

  async function exportDialog() {
    const text = await api.exportNaps();
    openDialog({
      title: 'Export links',
      text: 'Your naps as text, one "URL | Title" per line. Keep it as a backup, or import it back here any time.',
      area: { value: text, readOnly: true, placeholder: 'Nothing is napping yet.' },
      confirmLabel: 'Copy',
      onConfirm: () =>
        // Pages may write to the clipboard right after a click.
        navigator.clipboard.writeText(text).then(
          () => showToast('Copied'),
          () => showToast('Couldn\'t copy. Select the text and press Ctrl+C instead.'),
        ),
    });
  }

  // ---- Selection bar ------------------------------------------------------------------

  /** Clicking anywhere that isn't a row (or the bar, a menu, …) unselects everything, like on a desktop. */
  function onDocumentClick(event) {
    if (selection.size === 0 && linkSelection.size === 0) return;
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('.row, .selection-bar, .menu, .dialog, .toast, .rename-input')) return;
    setSelection([]);
  }

  function onSelectionBarClick(event) {
    const button = event.target.closest('[data-selection]');
    if (!button) return;
    const action = button.dataset.selection;
    if (action === 'wake' || action === 'wake-window' || action === 'delete') runLinksAction(action);
    else if (action === 'color') {
      const groupIds = selectedGroupIds();
      openColorMenu(button, groupIds, groupIds.length === 1 ? groupsById.get(groupIds[0])?.color : null);
    } else if (action === 'deselect') setSelection([]);
    else runTabsAction(action, selectionFor([...selection][0] ?? -1));
  }

  function runLinksAction(action) {
    const ids = [...linksById.keys()].filter((id) => linkSelection.has(id)); // in list order
    setSelection([]);
    if (action === 'wake' || action === 'wake-window') {
      const target = action === 'wake-window' ? { newWindow: true } : {};
      // All of one nap selected (e.g. by clicking its row): wake it as a nap,
      // so one that came from a tab group comes back as that group.
      const napIds = new Set(ids.map((id) => linksById.get(id)?.napId));
      const nap = napIds.size === 1 ? napsById.get([...napIds][0]) : null;
      if (nap && nap.links.length === ids.length) moveNapped({ kind: 'nap', item: nap }, target);
      else moveNapped({ kind: 'links', items: ids.map((id) => linksById.get(id)) }, target);
    } else {
      api.deleteLinks(ids).then(
        (undo) => showToast(`Deleted ${plural(undo.count, 'link')}`, 'Undo', () => act(api.putBackNaps(undo), 'Delete undone')),
        (error) => showError('delete those', error),
      );
    }
  }

  /** Nap, Group, Ungroup, New window or Close for some tabs (the selection bar and the right-click menu). */
  function runTabsAction(action, tabs) {
    if (action === 'nap') {
      napAndOfferUndo(api.napTabs(tabs.map((tab) => tab.id)));
      setSelection([]);
    } else if (action === 'group') {
      setSelection([]);
      api.groupTabs(tabs).then(
        (undo) => {
          if (!undo) return;
          nameGroupWhenShown = undo.groupId; // type a name for it right away (Enter or Esc to skip)
          showToast(`Grouped ${plural(undo.count, 'tab')}`, 'Undo', () => act(api.undoGroup(undo), 'Group undone'));
        },
        (error) => showError('group those', error),
      );
    } else if (action === 'ungroup') {
      setSelection([]);
      api.ungroupTabs(tabs.map((tab) => tab.id)).then(
        (undo) => showToast(`Took ${plural(undo.count, 'tab')} out of ${plural(undo.groups.length, 'group')}`, 'Undo', () => act(api.undoUngroup(undo), 'Ungroup undone')),
        (error) => showError('ungroup those', error),
      );
    } else if (action === 'new-window') {
      act(api.moveTabs(tabs, { newWindow: true }), `Moved ${plural(tabs.length, 'tab')} to a new window`);
    } else if (action === 'close') {
      setSelection([]);
      api.closeTabs(tabs.map((tab) => tab.id)).then(
        (undo) => showToast(`Closed ${plural(undo.count, 'tab')}`, 'Undo', () => act(api.undoClose(undo), 'Close undone')),
        (error) => showError('close those', error),
      );
    }
  }

  function showToast(text, actionLabel, onAction) {
    clearTimeout(toastTimer);
    toastText.textContent = text;
    toastButton.textContent = actionLabel ?? '';
    toastButton.hidden = !actionLabel;
    toastButton.title = actionLabel === 'Undo' ? `Undo (${KEYS.undo})` : '';
    toastAction = onAction ?? null;
    if (actionLabel === 'Undo' && onAction) {
      // Everything that offers Undo also goes on the Ctrl+Z history.
      const entry = { text, run: onAction };
      undoHistory.push(entry);
      if (undoHistory.length > UNDO_LIMIT) undoHistory.shift();
      toastAction = () => {
        const index = undoHistory.indexOf(entry);
        if (index !== -1) undoHistory.splice(index, 1);
        onAction();
      };
    }
    toast.hidden = false;
    toastTimer = setTimeout(hideToast, 8000);
  }

  /** Ctrl+Z: undo the latest action that offered Undo (and wasn't undone yet). */
  function undoLast() {
    const entry = undoHistory.pop();
    if (!entry) {
      showToast('Nothing to undo');
      return;
    }
    hideToast();
    entry.run();
    showToast(`Undone: ${entry.text}`);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toast.hidden = true;
    toastAction = null;
  }

  function firstMatch() {
    const terms = searchTerms(searchInput.value);
    if (terms.length === 0) return null;
    for (const win of snapshot?.windows ?? []) {
      for (const tab of tabsIn(win)) if (matches(tab, terms)) return tab;
    }
    return null;
  }

  /** "Work" if you named the window, otherwise "Window 2". */
  function windowLabel(windowId) {
    const index = snapshot?.windows.findIndex((win) => win.id === windowId) ?? -1;
    return snapshot?.windows[index]?.name || `Window ${index + 1}`;
  }

  /** Runs a Chrome action; on success optionally announces `message`. */
  function act(promise, successMessage) {
    promise.then(
      () => {
        if (successMessage) announcer.textContent = successMessage;
        refresh(); // show the result right away instead of waiting for Chrome's events
      },
      (error) => showError('do that', error),
    );
  }

  /** Something failed: say so at the bottom (and in the console), and show the current state. */
  function showError(what, error) {
    console.warn('Tabbies:', error);
    showToast(`Couldn’t ${what}: ${error?.message ?? error}`);
    refresh();
  }

  function focusSearch() {
    searchInput.focus();
    searchInput.select();
  }

  // ---- Focus helpers ------------------------------------------------------------------

  function visibleRows() {
    return Array.from(tree.querySelectorAll('.row')).filter((row) => row.checkVisibility());
  }

  function focusRow(row) {
    row?.querySelector('.toggle, .tab-main')?.focus();
  }

  function focusRelativeRow(row, step) {
    const rows = visibleRows();
    const index = rows.indexOf(row) + step;
    if (index < 0) focusSearch();
    else focusRow(rows[index]);
  }

  function focusParentRow(row) {
    const parentBranch = row.parentElement.closest('.children')?.closest('.branch');
    focusRow(parentBranch?.querySelector(':scope > .row'));
  }

  // Re-rendering replaces the tree's elements, which drops keyboard focus.
  // Remember what was focused and put focus back afterwards. If that tab is
  // gone (e.g. it was just closed), focus the same button on the row that took
  // its place, or on the row above it when the closed tab was the last in its
  // window, so pressing Enter again keeps closing tabs.
  function rememberFocus() {
    const focused = document.activeElement;
    if (!focused || !tree.contains(focused)) return () => {};
    const key = focused.dataset.focusKey;
    const action = focused.dataset.action;
    const rowIndex = visibleRows().indexOf(focused.closest('.row'));

    return () => {
      if (tree.contains(document.activeElement)) return;
      let target = key && tree.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
      if (!target?.checkVisibility()) {
        const rows = visibleRows();
        const sameSpot = rows[Math.min(rowIndex, rows.length - 1)];
        const above = rows[rowIndex - 1];
        const row = [sameSpot, above].find((r) => r?.querySelector(`[data-action="${action}"]`)) ?? sameSpot;
        target = row?.querySelector(`[data-action="${action}"]`) ?? row?.querySelector('button');
      }
      target?.focus({ preventScroll: true });
    };
  }

  function destroy() {
    destroyed = true;
    clearTimeout(toastTimer);
    toolbarSize.disconnect();
    unsubscribe();
    document.removeEventListener('keydown', onDocumentKeydown);
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    container.replaceChildren();
    container.classList.remove('explorer');
  }
}

// ---- Tab rows -----------------------------------------------------------------------------

function buildTabRow(tab, depth) {
  const classes = ['row', 'tab'];
  if (tab.active) classes.push('is-active');
  if (tab.discarded) classes.push('is-asleep');

  const status = [
    tab.pinned && statusIcon('pin', 'Pinned'),
    tab.audible && !tab.muted && statusIcon('sound', 'Playing sound'),
    tab.muted && statusIcon('muted', 'Muted'),
    tab.discarded && statusIcon('asleep', 'Asleep: unloaded to save memory'),
    tab.copies > 1 && statusIcon('copies', `Duplicate: this page is open in ${tab.copies} tabs`),
  ].filter(Boolean);

  return h(
    'div',
    { class: classes.join(' '), style: `--depth: ${depth}`, 'data-tab-id': tab.id, draggable: 'true' },
    h(
      'button',
      {
        class: 'tab-main',
        type: 'button',
        'data-action': 'activate',
        'data-focus-key': `tab:${tab.id}`,
        title: tab.url ? `${tab.title}\n${tab.url.slice(0, 300)}` : tab.title,
      },
      favicon(tab),
      h('span', { class: 'title' }, tab.title),
      status.length > 0 && h('span', { class: 'status' }, ...status),
      h('span', { class: 'domain' }, displayUrl(tab.url)),
    ),
    // Mute/unmute only on tabs that play sound (or were muted); the rest
    // have it in the right-click menu.
    (tab.audible || tab.muted) &&
      h(
        'button',
        {
          class: 'action',
          type: 'button',
          'data-action': 'mute',
          'data-focus-key': `tab:${tab.id}:mute`,
          title: tab.muted ? 'Unmute tab' : 'Mute tab',
          'aria-label': `${tab.muted ? 'Unmute' : 'Mute'} ${tab.title}`,
        },
        icon(tab.muted ? 'sound' : 'muted'),
      ),
    napActionButton('nap-tab', `tab:${tab.id}:nap`, `Nap ${tab.title}`),
    h(
      'button',
      {
        class: 'action close',
        type: 'button',
        'data-action': 'close',
        'data-focus-key': `tab:${tab.id}:close`,
        title: 'Close tab',
        'aria-label': `Close ${tab.title}`,
      },
      icon('close'),
    ),
  );
}

/** A saved link inside a nap: click to wake it, ✕ to forget it. */
function buildLinkRow(link, nap) {
  return h(
    'div',
    { class: 'row link', style: '--depth: 2', 'data-nap-id': nap.id, 'data-link-id': link.id, draggable: 'true' },
    h(
      'button',
      {
        class: 'tab-main',
        type: 'button',
        'data-action': 'wake-link',
        'data-focus-key': `link:${link.id}`,
        title: `Open again: ${link.title}\n${link.url.slice(0, 300)}`,
      },
      favicon(link),
      h('span', { class: 'title' }, link.title),
      h('span', { class: 'domain' }, displayUrl(link.url)),
    ),
    h(
      'button',
      {
        class: 'action close',
        type: 'button',
        'data-action': 'delete-link',
        'data-focus-key': `link:${link.id}:delete`,
        title: 'Remove from this nap',
        'aria-label': `Remove ${link.title} from this nap`,
      },
      icon('close'),
    ),
  );
}

/** The Tab Nap cat as a small picture. */
function napIcon(className = '') {
  return h('img', {
    class: className ? `nap-icon ${className}` : 'nap-icon',
    src: NAP_ICON_URL,
    alt: '',
    width: 16,
    height: 16,
    draggable: 'false',
  });
}

/** A hover button with the Tab Nap cat, for napping a tab, group or window. */
function napActionButton(action, focusKey, label) {
  return h(
    'button',
    { class: 'action nap', type: 'button', 'data-action': action, 'data-focus-key': focusKey, title: 'Nap: close and keep for later', 'aria-label': label },
    napIcon(),
  );
}

/** A ⋯ button that opens a menu. */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
/** Shortcut labels shown in menus (and the keys onSelectionKey listens for). */
const KEYS = {
  group: IS_MAC ? '⌘G' : 'Ctrl+G',
  ungroup: IS_MAC ? '⇧⌘G' : 'Ctrl+Shift+G',
  del: IS_MAC ? '⌫' : 'Del',
  undo: IS_MAC ? '⌘Z' : 'Ctrl+Z',
};
/** A line between groups of menu items. */
const SEPARATOR = { separator: true };
const UNDO_LIMIT = 20;
/** localStorage flag: the "click to select · double-click to open" tip was dismissed. */
const TIP_KEY = 'tabbies-tip-dismissed';

function tipWanted() {
  try {
    return localStorage.getItem(TIP_KEY) !== '1';
  } catch {
    return true;
  }
}

/** The colors Chrome allows for tab groups, in the order Chrome shows them. */
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

/** "the group Reading", or "the unnamed group". */
function groupLabel(group) {
  return group.title ? `the group ${group.title}` : 'the unnamed group';
}

function moreButton(action, focusKey, label) {
  return h(
    'button',
    { class: 'action more', type: 'button', 'data-action': action, 'data-focus-key': focusKey, title: label, 'aria-label': label, 'aria-haspopup': 'menu' },
    icon('more'),
  );
}

/** Everything a tab row shows; if this is unchanged the old row is reused. */
function rowSignature(tab, depth) {
  return [depth, tab.title, tab.url, tab.favIconUrl, tab.active, tab.pinned, tab.audible, tab.muted, tab.discarded, tab.copies].join(
    '\u0000',
  );
}

function favicon(tab) {
  if (!isLoadableIcon(tab.favIconUrl)) return fallbackFavicon();
  return h('img', {
    class: 'favicon',
    src: tab.favIconUrl,
    alt: '',
    width: 16,
    height: 16,
    loading: 'lazy',
    referrerpolicy: 'no-referrer',
    draggable: 'false',
  });
}

function fallbackFavicon() {
  return h('span', { class: 'favicon favicon-fallback' }, icon('globe'));
}

function statusIcon(name, label) {
  return h('span', { class: 'status-icon', role: 'img', 'aria-label': label, title: label }, icon(name));
}

// Pages can't show icons from chrome:// URLs (Settings, Downloads, ...), so
// only web, data: and our own extension's icons are used; the rest get a globe.
function isLoadableIcon(url) {
  return /^(https?:|data:image\/)/i.test(url) || url.startsWith(`${location.origin}/`);
}

/** Short location shown next to the title: "github.com", "chrome://settings". */
function displayUrl(url) {
  if (!url) return '';
  if (url.startsWith(`${location.origin}/`)) return 'Tabbies';
  try {
    const { protocol, hostname, host } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:') return hostname.replace(/^www\./, '');
    if (protocol === 'file:') return 'Local file';
    if (host) return `${protocol}//${host}`;
  } catch {
    // Not a parseable URL: show it as it is.
  }
  return url.slice(0, 80); // about:blank, data:… (which can be very long)
}

// ---- Search -------------------------------------------------------------------------------

/** "GitHub  pull " → ["github", "pull"]; every word must match. */
function searchTerms(text) {
  return text.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// Lower-cased "title + url" per tab, computed once per snapshot.
const haystacks = new WeakMap();

function matches(tab, terms) {
  if (terms.length === 0) return true;
  let haystack = haystacks.get(tab);
  if (haystack === undefined) {
    haystack = `${tab.title}\n${tab.url.slice(0, 2000)}`.toLowerCase();
    haystacks.set(tab, haystack);
  }
  return terms.every((term) => haystack.includes(term));
}

// ---- Small helpers ------------------------------------------------------------------------

/** Tabs of a window in tab-strip order, including the ones inside groups. */
function* tabsIn(win) {
  for (const child of win.children) {
    if (child.kind === 'group') yield* child.tabs;
    else yield child;
  }
}

function findActiveTab(win) {
  for (const tab of tabsIn(win)) if (tab.active) return tab;
  return null;
}

function countLabel(shown, total, ctx) {
  return ctx.terms.length > 0 ? `${shown} of ${total}` : plural(total, 'tab');
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

