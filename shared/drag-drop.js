// shared/drag-drop.js
//
// Drag and drop for the explorer tree, built on the browser's standard HTML
// drag-and-drop events: dragstart (on the row you pick up) → dragover (on
// whatever is under the pointer, many times a second) → drop → dragend.
//
// Like explorer.js, this file never calls chrome.*. It only works out *what*
// is being dropped *where*, shows a drop indicator, and hands the result to
// `onDrop`, which the explorer turns into a chrome-api.js call.
//
// What can go where (like files and folders):
//   tab    → before/after another tab, joining that tab's group (if any);
//            onto a group to add it at the end; onto a window to put it at the
//            end; or onto "new window". Dragging a selected tab (Ctrl/Shift+
//            click) drags every selected tab with it.
//   group  → before/after another group or ungrouped tab; onto a window to
//            put it at the end; or onto "new window"
//   window → onto another window, merging all of its tabs into that one
// Never allowed: mixing incognito and regular windows (Chrome forbids it),
// grouping pinned tabs, or placing unpinned tabs among pinned ones.

const NO_GROUP = -1;
const AUTO_EXPAND_DELAY_MS = 700; // hovering a collapsed branch this long opens it
const BEFORE_GROUP_ZONE = 0.3; // top 30% of a group's row = "before the group"

/**
 * @param {object} options
 * @param {HTMLElement} options.root           element that receives the drag events
 * @param {HTMLElement} options.tree           the tree of rows
 * @param {HTMLElement} options.newWindowZone  drop zone for "move to a new window"
 * @param {object} options.model               { tab(id), group(id), window(id) } lookups, plus
 *   selectionFor(tabId): the tabs to drag when that tab is picked up (the
 *   whole selection if it's selected, otherwise just that tab)
 * @param {(toggle: HTMLElement) => void} options.expand      opens a collapsed branch
 * @param {(source: object, target: object) => void} options.onDrop
 * @param {() => void} options.onDragEnd
 * @returns {{ isDragging(): boolean }}
 */
export function enableDragAndDrop({ root, tree, newWindowZone, model, expand, onDrop, onDragEnd }) {
  // { kind: 'tab', items } | { kind: 'group'|'window', item }, plus the
  // `elements` dimmed while dragging.
  let source = null;
  let indicator = null; // { element, className } currently shown
  let expandTimer = null;
  let expandToggle = null;

  root.addEventListener('dragstart', onDragStart);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('dragleave', onDragLeave);
  root.addEventListener('drop', onDropEvent);
  root.addEventListener('dragend', onDragEndEvent);

  return { isDragging: () => source !== null };

  function onDragStart(event) {
    const element = event.target.closest?.('[draggable="true"]');
    source = element ? describeSource(element) : null;
    if (!source) return;

    // Only a "move" makes sense. The data uses a private type, so dropping a
    // row onto a web page or Chrome's tab strip does nothing.
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-tabbies', source.kind);
    for (const element of source.elements) element.classList.add('is-dragging');
    newWindowZone.hidden = source.kind === 'window';

    // Several tabs: show a "3 tabs" badge under the pointer instead of one row.
    if (source.kind === 'tab' && source.items.length > 1) {
      const badge = document.createElement('div');
      badge.className = 'drag-badge';
      badge.textContent = `${source.items.length} tabs`;
      root.append(badge);
      event.dataTransfer.setDragImage(badge, 12, 12);
      // The browser takes its picture of the badge right away; then it can go.
      setTimeout(() => badge.remove());
    }
  }

  function onDragOver(event) {
    // Ignore things dragged in from outside Tabbies (links, files, text).
    if (!source) return;
    const drop = resolveDrop(event);
    showIndicator(drop?.indicator ?? null);
    scheduleAutoExpand(event);
    if (drop) {
      // preventDefault on dragover is how a page says "you may drop here".
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
  }

  function onDragLeave(event) {
    if (source && !root.contains(event.relatedTarget)) showIndicator(null);
  }

  function onDropEvent(event) {
    if (!source) return;
    event.preventDefault();
    const drop = resolveDrop(event);
    const dropped = source;
    finish();
    if (drop) onDrop(dropped, drop.target);
  }

  // dragend fires on the picked-up row when the drag is over, whether it was
  // dropped, cancelled with Esc, or released outside the page.
  function onDragEndEvent() {
    if (source) finish();
  }

  function finish() {
    for (const element of source.elements) element.classList.remove('is-dragging');
    showIndicator(null);
    clearTimeout(expandTimer);
    expandToggle = null;
    newWindowZone.hidden = true;
    source = null;
    onDragEnd();
  }

  // ---- What is being dragged? ----------------------------------------------------

  function describeSource(element) {
    if (element.matches('.tab')) {
      const items = model.selectionFor(Number(element.dataset.tabId));
      if (items.length === 0) return null;
      const elements = items.map((tab) => tree.querySelector(`.tab[data-tab-id="${tab.id}"]`)).filter(Boolean);
      return { kind: 'tab', items, elements };
    }
    // Group and window rows: dim the whole branch, children included.
    const branch = element.closest('.branch');
    if (branch?.matches('.group')) {
      const item = model.group(Number(branch.dataset.groupId));
      return item && { kind: 'group', item, elements: [branch] };
    }
    if (branch?.matches('.window')) {
      const item = model.window(Number(branch.dataset.windowId));
      return item && { kind: 'window', item, elements: [branch] };
    }
    return null;
  }

  // ---- Where would it land? --------------------------------------------------------
  // Returns { target, indicator } or null when dropping here isn't allowed.
  // `target` is a MoveTarget (see chrome-api.js); `indicator` says which
  // element to mark and how ('drop-before', 'drop-after', 'drop-inside').

  function resolveDrop(event) {
    const element = event.target instanceof Element ? event.target : event.target.parentElement;

    if (element?.closest('.new-window-zone')) {
      if (source.kind === 'window') return null;
      // A new window is either incognito or not, so the tabs must all agree.
      if (source.kind === 'tab' && new Set(source.items.map((tab) => tab.incognito)).size > 1) return null;
      return { target: { newWindow: true }, indicator: { element: newWindowZone, className: 'drop-inside' } };
    }

    const row = element?.closest('.row');
    if (!row || !tree.contains(row)) return null;
    const windowBranch = row.closest('.branch.window');
    const win = model.window(Number(windowBranch.dataset.windowId));
    if (!win || !sourceFitsWindow(win)) return null;

    if (source.kind === 'window') return dropWindow(win, windowBranch);
    if (source.kind === 'group') return dropGroup(win, row, event);
    return dropTab(win, row, event);
  }

  function dropWindow(win, windowBranch) {
    if (win.id === source.item.id) return null;
    return { target: { windowId: win.id }, indicator: inside(headerRow(windowBranch)) };
  }

  function dropTab(win, row, event) {
    const tabs = source.items;
    const isDragged = (tab) => tabs.some((t) => t.id === tab.id);
    // Pinned tabs always sit at the front of a window and can't be grouped.
    // When the dragged tabs mix pinned and unpinned, the unpinned ones decide
    // where things go and the pinned ones stay pinned (see moveTabs).
    const allPinned = tabs.every((t) => t.pinned);
    const branch = row.parentElement.closest('.branch');

    // Onto a window's own row: move to the end of that window.
    if (branch?.matches('.window') && row === headerRow(branch)) {
      return { target: { windowId: win.id, groupId: NO_GROUP }, indicator: inside(row) };
    }

    // Onto a group's row: the top part means "just before the group",
    // the rest means "into the group, at the end".
    if (branch?.matches('.group') && row === headerRow(branch)) {
      const group = model.group(Number(branch.dataset.groupId));
      const staying = group?.tabs.filter((t) => !isDragged(t)) ?? [];
      if (staying.length === 0 || allPinned) return null;
      if (pointerRatio(row, event) < BEFORE_GROUP_ZONE) {
        return {
          target: { windowId: win.id, beforeTabId: staying[0].id, groupId: NO_GROUP },
          indicator: { element: row, className: 'drop-before' },
        };
      }
      return { target: { windowId: win.id, afterTabId: staying.at(-1).id, groupId: group.id }, indicator: inside(row) };
    }

    // Onto another tab: top half = before it, bottom half = after it. The
    // dropped tabs join that tab's group, like dropping files between files.
    const anchor = model.tab(Number(row.dataset.tabId));
    if (!anchor || isDragged(anchor)) return null;
    // Pinned tabs are only reordered among pinned tabs, others among others.
    if (anchor.pinned !== allPinned) return null;
    const before = pointerRatio(row, event) < 0.5;
    return {
      target: {
        windowId: win.id,
        [before ? 'beforeTabId' : 'afterTabId']: anchor.id,
        groupId: anchor.groupId,
      },
      indicator: { element: row, className: before ? 'drop-before' : 'drop-after' },
    };
  }

  function dropGroup(win, row, event) {
    const group = source.item;
    const branch = row.parentElement.closest('.branch');

    // Onto a window's own row: move the group to the end of that window.
    if (branch?.matches('.window') && row === headerRow(branch)) {
      return { target: { windowId: win.id }, indicator: inside(row) };
    }

    // Groups can't go inside groups, so anything inside another group counts
    // as that whole group: the top half means before it, the bottom half after it.
    const groupBranch = row.closest('.branch.group');
    if (groupBranch) {
      const other = model.group(Number(groupBranch.dataset.groupId));
      if (!other || other.id === group.id) return null;
      const before = pointerRatio(groupBranch, event) < 0.5;
      return before
        ? {
            target: { windowId: win.id, beforeTabId: other.tabs[0].id },
            indicator: { element: headerRow(groupBranch), className: 'drop-before' },
          }
        : {
            target: { windowId: win.id, afterTabId: other.tabs.at(-1).id },
            indicator: { element: groupBranch, className: 'drop-after' },
          };
    }

    // Next to an ungrouped (and unpinned) tab.
    const anchor = model.tab(Number(row.dataset.tabId));
    if (!anchor || anchor.pinned) return null;
    const before = pointerRatio(row, event) < 0.5;
    return {
      target: { windowId: win.id, [before ? 'beforeTabId' : 'afterTabId']: anchor.id },
      indicator: { element: row, className: before ? 'drop-before' : 'drop-after' },
    };
  }

  // Chrome can't move tabs between incognito and regular windows.
  function sourceFitsWindow(win) {
    if (source.kind === 'window') return source.item.incognito === win.incognito;
    if (source.kind === 'group') return Boolean(model.window(source.item.windowId)?.incognito) === win.incognito;
    return source.items.every((tab) => tab.incognito === win.incognito);
  }

  // ---- Feedback -----------------------------------------------------------------------

  function showIndicator(next) {
    if (indicator?.element === next?.element && indicator?.className === next?.className) return;
    indicator?.element.classList.remove(indicator.className);
    next?.element.classList.add(next.className);
    indicator = next;
  }

  // Like a file explorer: hovering over a collapsed window or group opens it.
  function scheduleAutoExpand(event) {
    const toggle = event.target.closest?.('.toggle[aria-expanded="false"]') ?? null;
    if (toggle === expandToggle) return;
    clearTimeout(expandTimer);
    expandToggle = toggle;
    if (toggle) expandTimer = setTimeout(() => expand(toggle), AUTO_EXPAND_DELAY_MS);
  }
}

function headerRow(branch) {
  return branch.querySelector(':scope > .row');
}

function inside(element) {
  return { element, className: 'drop-inside' };
}

/** How far down `element` the pointer is: 0 = top edge, 1 = bottom edge. */
function pointerRatio(element, event) {
  const rect = element.getBoundingClientRect();
  return (event.clientY - rect.top) / rect.height;
}
