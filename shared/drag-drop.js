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
//   any    → onto "Drop here to nap" or the Naps section: nap them (a window
//            naps its unpinned tabs); onto one nap: add them to that nap
//   napped links (one, or a Ctrl/Shift selection) and whole naps:
//          → anywhere a tab could go (a spot in a window, a group, a window,
//            "new window"): wake them right there
//          → inside Naps: links move before/after another link or into
//            another nap; naps move before/after another nap
// Never allowed: mixing incognito and regular windows (Chrome forbids it),
// grouping pinned tabs, or placing unpinned tabs among pinned ones.

const NO_GROUP = -1;
const AUTO_EXPAND_DELAY_MS = 700; // hovering a collapsed branch this long opens it
const BEFORE_GROUP_ZONE = 0.3; // top 30% of a group's row = "before the group"

/**
 * @param {object} options
 * @param {HTMLElement} options.root           element that receives the drag events
 * @param {HTMLElement} options.tree           the tree of rows
 * @param {object} options.zones               drop zones shown at the bottom while dragging:
 *   { container, newWindow ("move to a new window"), nap ("nap these") }
 * @param {object} options.model               { tab(id), group(id), window(id), nap(id) } lookups, plus
 *   selectionFor(tabId) / linkSelectionFor(linkId): what to drag when that
 *   tab or link is picked up (the whole selection if it's selected, otherwise
 *   just that one)
 * @param {(toggle: HTMLElement) => void} options.expand      opens a collapsed branch
 * @param {(source: object, target: object) => void} options.onDrop
 * @param {() => void} options.onDragEnd
 * @returns {{ isDragging(): boolean }}
 */
export function enableDragAndDrop({ root, tree, zones, model, expand, onDrop, onDragEnd }) {
  // { kind: 'tab'|'links', items } | { kind: 'group'|'window'|'nap', item },
  // plus the `elements` dimmed while dragging.
  let source = null;
  // Pressing a row's small buttons (nap, mute, close, ⋯) must never turn into
  // a drag, even if the mouse moves a little during the click.
  let pressedButton = false;
  let indicator = null; // { element, className } currently shown
  let expandTimer = null;
  let expandToggle = null;

  root.addEventListener('pointerdown', (event) => {
    pressedButton = Boolean(event.target.closest?.('.action'));
  });
  document.addEventListener('pointerup', () => {
    pressedButton = false;
  });
  root.addEventListener('dragstart', onDragStart);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('dragleave', onDragLeave);
  root.addEventListener('drop', onDropEvent);
  root.addEventListener('dragend', onDragEndEvent);

  return { isDragging: () => source !== null };

  function onDragStart(event) {
    const fromButton = pressedButton;
    pressedButton = false;
    if (fromButton) {
      event.preventDefault(); // cancel the drag; the click still happens
      return;
    }
    const element = event.target.closest?.('[draggable="true"]');
    source = element ? describeSource(element) : null;
    if (!source) return;

    // Only a "move" makes sense. The data uses a private type, so dropping a
    // row onto a web page or Chrome's tab strip does nothing.
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-tabbies', source.kind);
    for (const element of source.elements) element.classList.add('is-dragging');
    zones.newWindow.hidden = source.kind === 'window';
    // Napped things are napped already.
    zones.nap.hidden = sourceIsIncognito() || source.kind === 'links' || source.kind === 'nap';
    zones.container.hidden = false;

    // Several tabs or links: show a "3 tabs" badge under the pointer instead of one row.
    if ((source.kind === 'tab' || source.kind === 'links') && source.items.length > 1) {
      const badge = document.createElement('div');
      badge.className = 'drag-badge';
      badge.textContent = `${source.items.length} ${source.kind === 'tab' ? 'tabs' : 'links'}`;
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
    zones.container.hidden = true;
    source = null;
    onDragEnd();
  }

  // ---- What is being dragged? ----------------------------------------------------

  function describeSource(element) {
    if (element.matches('.link')) {
      const items = model.linkSelectionFor(element.dataset.linkId);
      if (items.length === 0) return null;
      const elements = items.map((link) => tree.querySelector(`.link[data-link-id="${link.id}"]`)).filter(Boolean);
      return { kind: 'links', items, elements };
    }
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
    if (branch?.matches('.nap')) {
      const item = model.nap(branch.dataset.napId);
      return item && { kind: 'nap', item, elements: [branch] };
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
      if (source.kind === 'links' || source.kind === 'nap') {
        return { target: { newWindow: true }, indicator: inside(zones.newWindow) };
      }
      // A new window is either incognito or not, so the tabs must all agree.
      if (source.kind === 'tab' && new Set(source.items.map((tab) => tab.incognito)).size > 1) return null;
      return { target: { newWindow: true }, indicator: inside(zones.newWindow) };
    }

    // Naps: the zone at the bottom or the Naps section make a new nap; one
    // nap (its row or any link in it) gets the tabs added to its end.
    // Incognito tabs are never napped, so their addresses never reach the disk.
    if (element?.closest('.nap-zone')) {
      return sourceIsIncognito() ? null : { target: { nap: true }, indicator: inside(zones.nap) };
    }
    const napsBranch = element?.closest('.branch.naps');
    if (napsBranch && source.kind === 'links') return dropLinksInNaps(element, napsBranch, event);
    if (napsBranch && source.kind === 'nap') return dropNapInNaps(element, event);
    if (napsBranch) {
      if (sourceIsIncognito()) return null;
      const napBranch = element.closest('.branch.nap');
      return napBranch
        ? { target: { nap: true, napId: napBranch.dataset.napId }, indicator: inside(headerRow(napBranch)) }
        : { target: { nap: true }, indicator: inside(headerRow(napsBranch)) };
    }

    const row = element?.closest('.row');
    if (!row || !tree.contains(row)) return null;
    const windowBranch = row.closest('.branch.window');
    const win = model.window(Number(windowBranch.dataset.windowId));
    if (!win || !sourceFitsWindow(win)) return null;

    if (source.kind === 'window') return dropWindow(win, windowBranch);
    if (source.kind === 'group') return dropGroup(win, row, event);
    // Tabs, and napped links/naps (they wake up where they're dropped, so
    // they follow the same rules as unpinned tabs).
    return dropTab(win, row, event);
  }

  function dropLinksInNaps(element, napsBranch, event) {
    const napBranch = element.closest('.branch.nap');
    // On the Naps heading: make a new nap out of them.
    if (!napBranch) return { target: { nap: true }, indicator: inside(headerRow(napsBranch)) };
    const napId = napBranch.dataset.napId;
    const linkRow = element.closest('.row.link');
    if (!linkRow) return { target: { napMove: true, napId }, indicator: inside(headerRow(napBranch)) };
    const linkId = linkRow.dataset.linkId;
    if (source.items.some((link) => link.id === linkId)) return null; // onto itself
    const before = pointerRatio(linkRow, event) < 0.5;
    return {
      target: { napMove: true, napId, [before ? 'beforeLinkId' : 'afterLinkId']: linkId },
      indicator: { element: linkRow, className: before ? 'drop-before' : 'drop-after' },
    };
  }

  // A nap counts as one block: top half of another nap = before it, bottom half = after.
  function dropNapInNaps(element, event) {
    const napBranch = element.closest('.branch.nap');
    if (!napBranch || napBranch.dataset.napId === source.item.id) return null;
    const before = pointerRatio(napBranch, event) < 0.5;
    return before
      ? {
          target: { napOrder: true, beforeNapId: napBranch.dataset.napId },
          indicator: { element: headerRow(napBranch), className: 'drop-before' },
        }
      : {
          target: { napOrder: true, afterNapId: napBranch.dataset.napId },
          indicator: { element: napBranch, className: 'drop-after' },
        };
  }

  function dropWindow(win, windowBranch) {
    if (win.id === source.item.id) return null;
    return { target: { windowId: win.id }, indicator: inside(headerRow(windowBranch)) };
  }

  function dropTab(win, row, event) {
    const tabs = source.kind === 'tab' ? source.items : []; // napped links/naps aren't tabs yet
    const isDragged = (tab) => tabs.some((t) => t.id === tab.id);
    // Pinned tabs always sit at the front of a window and can't be grouped.
    // When the dragged tabs mix pinned and unpinned, the unpinned ones decide
    // where things go and the pinned ones stay pinned (see moveTabs).
    const allPinned = tabs.length > 0 && tabs.every((t) => t.pinned);
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

  function sourceIsIncognito() {
    if (source.kind === 'links' || source.kind === 'nap') return false;
    if (source.kind === 'window') return source.item.incognito;
    if (source.kind === 'group') return Boolean(model.window(source.item.windowId)?.incognito);
    return source.items.some((tab) => tab.incognito);
  }

  // Chrome can't move tabs between incognito and regular windows.
  function sourceFitsWindow(win) {
    if (source.kind === 'links' || source.kind === 'nap') return !win.incognito;
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
