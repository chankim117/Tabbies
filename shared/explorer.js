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
  let dialogAction = null; // what the open dialog's main button does
  let toastAction = null;
  let toastTimer = null;

  let loading = false;
  let reloadQueued = false;
  let staleWhileHidden = false;
  let renderQueued = false;
  let renderAfterDrag = false;
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

  // Shown under the search box while tabs are selected.
  const selectionCount = h('span', { class: 'selection-count' });
  const selectionBar = h(
    'div',
    { class: 'selection-bar', hidden: true },
    selectionCount,
    h('button', { type: 'button', 'data-selection': 'nap', 'data-for': 'tabs' }, napIcon(), 'Nap'),
    h('button', { type: 'button', 'data-selection': 'new-window', 'data-for': 'tabs' }, icon('newWindow'), 'New window'),
    h('button', { type: 'button', 'data-selection': 'wake', 'data-for': 'links', title: 'Open them in this window' }, icon('wake'), 'Wake'),
    h('button', { type: 'button', 'data-selection': 'delete', 'data-for': 'links' }, icon('close'), 'Delete'),
    h('button', { type: 'button', 'data-selection': 'clear', title: 'Clear the selection (Esc)' }, 'Clear'),
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
  container.replaceChildren(
    h(
      'div',
      { class: 'toolbar' },
      h('label', { class: 'search' }, icon('search'), searchInput),
      summary,
      selectionBar,
    ),
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
  tree.addEventListener('keydown', onTreeKeydown);
  // Favicons that fail to load fall back to a globe. 'error' doesn't bubble,
  // so it is caught on the way down (capture phase).
  tree.addEventListener('error', onImageError, true);
  document.addEventListener('keydown', onDocumentKeydown);
  document.addEventListener('visibilitychange', onVisibilityChange);
  menu.addEventListener('click', onMenuClick);
  menu.addEventListener('keydown', onMenuKeydown);
  menu.addEventListener('toggle', onMenuToggle);
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
    if (dragDrop.isDragging()) {
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

    // Only tabs you can see stay selected (not ones closed, filtered out by
    // the search, or inside a collapsed window or group).
    pruneSelection();
    restoreFocus();
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
      h('span', { class: 'label' }, `Window ${number}`),
      win.isCurrent && h('span', { class: 'badge badge-current', title: 'The window you opened Tabbies in' }, 'Current'),
      win.incognito && h('span', { class: 'badge' }, 'Incognito'),
      activeTab && h('span', { class: 'hint' }, activeTab.title),
      h('span', { class: 'count' }, countLabel(shown, win.tabCount, ctx)),
    ];
    const sortButton = h(
      'button',
      {
        class: 'action sort',
        type: 'button',
        'data-action': 'sort',
        'data-window-id': win.id,
        'data-focus-key': `window:${win.id}:sort`,
        title: 'Sort tabs',
        'aria-label': `Sort the tabs in Window ${number}`,
        'aria-haspopup': 'menu',
      },
      icon('sort'),
    );
    const napButton = napActionButton('nap-window', `window:${win.id}:nap`, `Nap the tabs in Window ${number}`);
    const element = renderBranch({
      key: `window:${win.id}`,
      depth: 0,
      kind: 'window',
      header,
      children,
      actions: [napButton, sortButton],
      attributes: { 'data-window-id': win.id },
      dragLabel: `Drag to merge Window ${number} into another window`,
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
        { class: group.title ? 'group-label' : 'group-label is-unnamed' },
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
      actions: [napActionButton('nap-group', `group:${group.id}:nap`, `Nap the group ${group.title || ''}`.trim())],
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
      h('span', { class: 'label nap-name' }, name),
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

    if (action === 'toggle') {
      setExpanded(button, button.getAttribute('aria-expanded') !== 'true');
      return;
    }
    if (action === 'sort') {
      openSortMenu(button);
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
    if (action === 'naps-menu') {
      openNapsMenu(button);
      return;
    }

    // Rows inside the Naps section.
    const nap = napsById.get(button.closest('[data-nap-id]')?.dataset.napId);
    if (nap) {
      const linkId = button.closest('[data-link-id]')?.dataset.linkId;
      if (action === 'wake-link') {
        const ctrl = event.ctrlKey || event.metaKey;
        if (event.shiftKey) selectLinkRange(linkId, ctrl);
        else if (ctrl) toggleLinkSelected(linkId);
        else {
          setSelection([]);
          wake(nap, { linkIds: [linkId], where: 'here', activate: true });
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
      const ctrl = event.ctrlKey || event.metaKey; // ⌘ on a Mac
      if (event.shiftKey) {
        selectRange(tab.id, ctrl); // Ctrl+Shift adds the range to the selection
      } else if (ctrl) {
        toggleSelected(tab.id);
      } else {
        setSelection([]);
        selectionAnchor = tab.id;
        switchTo(tab);
      }
    } else if (action === 'close') {
      act(api.closeTab(tab));
    } else if (action === 'mute') {
      act(api.setTabMuted(tab, !tab.muted));
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
    const where = target.newWindow ? 'a new window' : `Window ${windowNumber(target.windowId)}`;
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
      // Enter switches to the first match: Alt+T, type, Enter.
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
    }
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
    const visible = new Set(visibleTabIds());
    for (const id of selection) if (!visible.has(id)) selection.delete(id);
    const visibleLinks = new Set(visibleLinkIds());
    for (const id of linkSelection) if (!visibleLinks.has(id)) linkSelection.delete(id);
    showSelection();
  }

  function showSelection() {
    for (const row of tree.querySelectorAll('.tab')) {
      row.classList.toggle('is-selected', selection.has(Number(row.dataset.tabId)));
    }
    for (const row of tree.querySelectorAll('.link')) {
      row.classList.toggle('is-selected', linkSelection.has(row.dataset.linkId));
    }
    // The bar offers what fits: Nap / New window for tabs, Wake / Delete for napped links.
    const mode = linkSelection.size > 0 ? 'links' : 'tabs';
    const count = mode === 'links' ? linkSelection.size : selection.size;
    selectionBar.hidden = count === 0;
    selectionCount.textContent = `${plural(count, mode === 'links' ? 'link' : 'tab')} selected`;
    for (const button of selectionBar.querySelectorAll('[data-for]')) button.hidden = button.dataset.for !== mode;
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
  function openMenu(button, { title, items, note }) {
    menuItems = items;
    menuOpenerKey = button.dataset.focusKey;
    menu.setAttribute('aria-label', title);
    const footer = note ? [h('p', { class: 'menu-note' }, note)] : [];
    menu.replaceChildren(
      h('p', { class: 'menu-title' }, title),
      ...items.map((item, index) =>
        h(
          'button',
          {
            class: 'menu-item',
            type: 'button',
            role: item.checked === undefined ? 'menuitem' : 'menuitemcheckbox',
            'aria-checked': item.checked === undefined ? null : String(item.checked),
            'data-index': index,
          },
          h('span', { class: 'menu-label' }, item.label),
          item.hint && h('span', { class: 'menu-hint' }, item.hint),
        ),
      ),
      ...footer,
    );
    menu.showPopover();
    // Place it under the button, flipped up if there's no room below.
    const anchor = button.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.right - box.width, innerWidth - box.width - 8));
    let top = anchor.bottom + 4;
    if (top + box.height > innerHeight - 8) top = Math.max(8, anchor.top - box.height - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelector('.menu-item').focus();
  }

  function onMenuClick(event) {
    const item = event.target.closest('.menu-item');
    if (!item) return;
    const { run } = menuItems[Number(item.dataset.index)];
    menu.hidePopover();
    run();
  }

  function onMenuKeydown(event) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...menu.querySelectorAll('.menu-item')];
    const index = items.indexOf(document.activeElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(index + step + items.length) % items.length].focus();
  }

  // When the menu closes (Esc, outside click, or a choice), put keyboard
  // focus back on the button it came from, unless something else took it.
  function onMenuToggle(event) {
    if (event.newState !== 'closed' || dialog.open) return;
    if (menu.contains(document.activeElement) || document.activeElement === document.body) {
      const button = menuOpenerKey && tree.querySelector(`[data-focus-key="${CSS.escape(menuOpenerKey)}"]`);
      button?.focus({ preventScroll: true });
    }
  }

  function openSortMenu(button) {
    const windowId = Number(button.dataset.windowId);
    openMenu(button, {
      title: 'Sort this window',
      note: 'Groups stay together. Pinned tabs stay put.',
      items: SORT_ORDERS.map((order) => ({
        label: order.label,
        hint: order.hint,
        run: () =>
          api.sortWindow(windowId, order.id).then(
            (previous) => {
              const text = `Sorted Window ${windowNumber(windowId)} ${order.done}`;
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
    const options = intoNapId ? { intoNapId } : { title: group.title, color: group.color };
    napAndOfferUndo(api.napTabs(group.tabs.map((tab) => tab.id), options));
  }

  /** Waits for a nap to finish, then offers to undo it. */
  function napAndOfferUndo(napping) {
    napping.then(
      (undo) => {
        if (!undo) {
          showToast('Nothing to nap: pinned, empty and Tabbies tabs stay open');
          return;
        }
        showToast(`Napped ${plural(undo.count, 'tab')}`, 'Undo', () => act(api.undoNap(undo), 'Nap undone'));
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

  function openNapMenu(button, nap) {
    openMenu(button, {
      title: napName(nap),
      items: [
        { label: 'Wake here', hint: 'Open the tabs in this window', run: () => wake(nap, { where: 'here' }) },
        { label: 'Wake as a group', hint: 'Open them as one tab group', run: () => wake(nap, { where: 'group' }) },
        { label: 'Wake in a new window', run: () => wake(nap, { where: 'window' }) },
        { label: 'Rename…', run: () => renameDialog(nap) },
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

  function renameDialog(nap) {
    openDialog({
      title: 'Rename nap',
      input: { value: nap.title, placeholder: formatNapDate(nap.createdAt) },
      text: 'Leave it empty to name it by its date again.',
      confirmLabel: 'Rename',
      onConfirm: (value) => act(api.renameNap(nap.id, value.trim())),
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

  function onSelectionBarClick(event) {
    const button = event.target.closest('[data-selection]');
    if (!button) return;
    const action = button.dataset.selection;
    if (action === 'wake' || action === 'delete') {
      const ids = [...linksById.keys()].filter((id) => linkSelection.has(id)); // in list order
      setSelection([]);
      if (action === 'wake') moveNapped({ kind: 'links', items: ids.map((id) => linksById.get(id)) }, {});
      else {
        api.deleteLinks(ids).then(
          (undo) => showToast(`Deleted ${plural(undo.count, 'link')}`, 'Undo', () => act(api.putBackNaps(undo), 'Delete undone')),
          (error) => showError('delete those', error),
        );
      }
      return;
    }
    const tabs = selectionFor([...selection][0] ?? -1);
    if (button.dataset.selection === 'nap') {
      napAndOfferUndo(api.napTabs(tabs.map((tab) => tab.id)));
      setSelection([]);
    } else if (button.dataset.selection === 'new-window') {
      act(api.moveTabs(tabs, { newWindow: true }), `Moved ${plural(tabs.length, 'tab')} to a new window`);
    } else {
      setSelection([]);
    }
  }

  function showToast(text, actionLabel, onAction) {
    clearTimeout(toastTimer);
    toastText.textContent = text;
    toastButton.textContent = actionLabel ?? '';
    toastButton.hidden = !actionLabel;
    toastAction = onAction ?? null;
    toast.hidden = false;
    toastTimer = setTimeout(hideToast, 8000);
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

  function windowNumber(windowId) {
    return (snapshot?.windows.findIndex((win) => win.id === windowId) ?? -1) + 1;
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
    unsubscribe();
    document.removeEventListener('keydown', onDocumentKeydown);
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
function moreButton(action, focusKey, label) {
  return h(
    'button',
    { class: 'action more', type: 'button', 'data-action': action, 'data-focus-key': focusKey, title: label, 'aria-label': label, 'aria-haspopup': 'menu' },
    icon('more'),
  );
}

/** Everything a tab row shows; if this is unchanged the old row is reused. */
function rowSignature(tab, depth) {
  return [depth, tab.title, tab.url, tab.favIconUrl, tab.active, tab.pinned, tab.audible, tab.muted, tab.discarded].join(
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

