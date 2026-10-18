# Tabbies

A file-explorer-style tab manager for Chrome. Tabbies shows every open window, tab group and tab as a tree. You can find, switch to, mute and close tabs, and drag them between groups and windows like files between folders.

**Status:** v0.4, an early preview. Everything stays in your browser: no servers, no accounts.

![Tabbies in a full tab](docs/screenshots/full-tab.png)

## Features

### Three views, one explorer

| Mini popup | Side panel |
| --- | --- |
| ![Popup](docs/screenshots/popup.png) | ![Side panel](docs/screenshots/side-panel.png) |

- **Side panel** (the default): click the Tabbies icon in the toolbar. It stays open on the right while you browse.
- **Full tab:** press **Alt+T**, or use the ⧉ button in the side panel. If Tabbies is already open in a tab, you're switched to it instead of getting a second copy.
- **Popup:** a small window under the icon. Choose it in Settings if you prefer it to the side panel.

All three share the same code and features. The layout adapts to the space: narrow views hide the site column.

### Settings

Click ⚙ in any Tabbies view, or right-click the Tabbies icon → **Options**. Changes apply right away, in every open Tabbies view, and follow your Chrome profile to your other computers (Chrome Sync).

- **Toolbar icon:** what clicking it opens: side panel (default), popup, or a full tab.
- **Theme:** match your computer, light or dark.
- **Naps:** keep links after waking; nap pinned tabs too.
- **Keyboard shortcuts:** see the current keys and open Chrome's page to change them.
- **Sync naps with your Chrome profile** (off by default): see below.
- **Naps backup:** download your naps as a text file, or restore from one.

### Tree view

- Windows → tab groups → tabs. Windows and groups expand and collapse.
- Windows show their tab count, and the window you opened Tabbies from is marked **Current**.
- Groups show their name and Chrome color.
- Tabs show the site icon, title and site, plus small icons for **playing sound**, **muted**, **pinned** and **asleep** (unloaded by Chrome to save memory).
- **Search** by title or URL as you type. Windows and groups with no matches are hidden.
- **Live updates:** the tree follows every change you make anywhere in Chrome.
- **Light and dark mode** follow your system setting.

### Tab actions

Click a tab to switch to it (its window comes to the front). Hover a tab for **mute/unmute** and **close** buttons.

### Selecting several tabs

Select tabs the way you select files:

- **Ctrl+click** (⌘+click on a Mac) adds or removes one tab without switching to it.
- **Shift+click** selects every tab from the last one you clicked to this one, across groups and windows. **Ctrl+Shift+click** adds that range to what's already selected.
- **Shift+↑/↓** extends the selection from the keyboard. **Ctrl+A** selects every tab you can see, so search first to select all matches.
- **Esc** or clicking empty space clears the selection. A plain click on a tab also clears it.
- Tabs you multi-selected in Chrome's own tab strip start out selected.

Drag any selected tab and **all selected tabs move together**, as one block in their original order. The drop rules below apply to the whole block.

### Sorting a window

Hover a window's row and click the sort button (⇅):

| Sort | What it does |
| --- | --- |
| By site | Tabs from the same site sit together (all YouTube, all Gmail…), sites A–Z |
| By title | A–Z |
| Recently used first | The tabs you looked at last come first |
| Oldest first | Tabs you haven't opened in a while come first, to help you clean up |

Groups stay together: tabs are sorted inside each group, and the ungrouped tabs are sorted after the groups. Pinned tabs don't move. Click **Undo** in the message that appears to put the window back as it was.

### Naps: close tabs now, open them later

<img src="icons/nap.svg" width="64" alt="Tab Nap, the Naps icon: a cat asleep on a stack of tabs" align="right">

**Napping** saves tabs to a list in the **Naps** section and closes them, freeing their memory. **Waking** opens them again.

- **Nap** with the Tab Nap cat button on a tab, a group or a window, or select tabs (Ctrl/Shift+click) and press **Nap** in the bar that appears. You can also drag tabs, groups or windows onto **Drop here to nap**, onto the Naps section (new nap), or onto an existing nap (adds to it).
- Napping a window or every window leaves pinned tabs and Tabbies itself open. Empty new tabs and incognito tabs are never napped, so incognito addresses are never saved.
- A nap is named by its date, or after the tab group it came from (with the group's color). Rename it from its ⋯ menu.
- **Wake** a whole nap with its ☀ button: here, or as a group if it came from one. The ⋯ menu also offers **Wake as a group** and **Wake in a new window**. Click a single link to open just that tab.
- Woken links leave the nap, and an empty nap disappears. To keep them instead, turn on **Keep links after waking** in the Naps ⋯ menu.
- Every nap, wake and delete shows an **Undo** button.
- Search finds napped tabs too.

**Import and export:** the Naps ⋯ menu has **Import links…** and **Export links…**. The text has one `URL | Title` per line, with a blank line between naps, so you can keep it as a backup or bring in lists from other tab tools that use this format.

**Syncing naps between computers.** Naps are kept on this computer unless you turn on **Settings → Sync naps with your Chrome profile** (do it on each computer). Tabbies then keeps them in a **Tabbies Naps** folder under *Other bookmarks*, and Chrome Sync brings them to every computer signed in to the same Chrome profile. Good to know:

- Chrome asks you to let Tabbies "read and change your bookmarks" when you turn it on. Nothing is asked when you install Tabbies.
- Napped pages also appear in your bookmarks, in address-bar suggestions, and on your phone if it syncs bookmarks. The ☆ in the address bar shows them as bookmarked.
- A nap from a tab group keeps its color as a dot at the end of the folder name, e.g. "Reading 🟣". Please don't rearrange the folder by hand; deleting it there deletes those naps on every computer.
- Turning sync off copies the naps back to this computer and leaves the bookmarks folder alone, so your other computers keep theirs.

Without sync, removing the extension deletes your naps, so download a backup first (Settings → Naps backup).

### Drag and drop

![Dragging a tab into a group](docs/screenshots/drag-and-drop.png)

| Drag a… | onto… | and it… |
| --- | --- | --- |
| tab | another tab | moves just above or below it, joining that tab's group (if any) |
| tab | a group's row | joins the end of the group (drop on the top edge of the row to place it just before the group instead) |
| tab | a window's row | moves to the end of that window |
| group | another group or tab | moves above or below it as a whole, keeping its name and color |
| group | a window's row | moves to the end of that window |
| tab or group | **Drop here to move to a new window** | opens in a new window |
| window | another window's row | **merges**: all of its tabs move over, in order, groups intact, and the empty window closes |

- A line shows where the item will land. Its indent tells you whether it will be inside a group.
- Hover a collapsed window or group for a moment while dragging to open it.
- Tabs are never reloaded or closed when moved: pages keep their scroll position, typed text and sound. Pinned tabs stay pinned.
- Chrome doesn't allow some moves, so Tabbies won't offer them: between incognito and regular windows, putting pinned tabs into groups, or mixing pinned and unpinned tabs.

### Keyboard

| Key | What it does |
| --- | --- |
| <kbd>Alt</kbd>+<kbd>T</kbd> | Open Tabbies in a tab |
| <kbd>/</kbd> | Jump to the search box |
| <kbd>Enter</kbd> in search | Switch to the first matching tab |
| <kbd>Esc</kbd> in search | Clear the search |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move between rows (<kbd>↓</kbd> from search enters the tree) |
| <kbd>←</kbd> <kbd>→</kbd> | Collapse / expand a window or group |
| <kbd>Enter</kbd> on a row or button | Switch to the tab / press the button |
| <kbd>Shift</kbd>+<kbd>↑</kbd> <kbd>↓</kbd> | Extend the selection |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> | Select all visible tabs |
| <kbd>Esc</kbd> | Clear the selection |

You can change Alt+T, or add shortcuts for the popup and the side panel, at `chrome://extensions/shortcuts`.

## Install (developer mode)

1. Download or clone this repository.
2. In Chrome (version 123 or newer), go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right corner).
4. Click **Load unpacked** and pick the `Tabbies` folder (the one that contains `manifest.json`).
5. Click the puzzle-piece icon in the toolbar and pin Tabbies.
6. Click the Tabbies icon to open the side panel, or press **Alt+T** for the full tab.

After you change the code, click the reload button (↻) on the Tabbies card in `chrome://extensions`. Reloading closes any open Tabbies tabs and panels, so open them again.

To include incognito windows, open **Details** on the Tabbies card and turn on **Allow in Incognito**.

## Permissions

- `tabs`: read the titles, addresses and icons of open tabs, and move them. Chrome lists this as "Read your browsing history".
- `tabGroups`: read, move and recreate tab groups.
- `sidePanel`: show Tabbies in Chrome's side panel.
- `storage`: keep your naps and settings (settings sync with your Chrome profile).
- `bookmarks` (optional, asked only if you turn on **Sync naps**): keep naps in a synced bookmarks folder.

Tabbies never reads page content and doesn't send your data anywhere. Site icons are loaded from the icon address Chrome reports for each tab, usually straight from the browser cache.

## Project layout

```
manifest.json          Extension settings: permissions, side panel, options page, shortcuts
background.js          Service worker: what the toolbar icon opens, keyboard shortcuts
tabbies.html/.js       Full-tab view
sidepanel.html/.js     Side panel view (opened by the toolbar icon by default)
popup.html/.js         Mini popup (if chosen in Settings)
settings.html          Chrome's Options page for Tabbies (settings-page.js)
shared/
  chrome-api.js        Chrome API calls: reading tabs, tab actions, moving, sorting, opening views
  naps-api.js          Chrome API calls for Naps: saving, closing, reopening, import/export, sync on/off
  naps-store.js        Where naps are kept: this computer, or a synced bookmarks folder
  settings-api.js      Chrome API calls for settings and the toolbar icon behavior
  nap-data.js          Naps helpers with no Chrome calls: names, import/export text format
  explorer.js          Explorer UI (search + tree). Makes no chrome.* calls itself
  settings.js          Settings page UI. Makes no chrome.* calls itself
  drag-drop.js         Drag and drop: works out what was dropped where
  sorting.js           The sort orders (by site, title, last used)
  start-view.js        Start-up shared by the three views (explorer, Settings, theme)
  dom.js               Tiny element builder used by the UI files
  theme-boot.js        Applies a fixed Light/Dark theme before the page is drawn
  explorer.css         Explorer styles
  settings.css         Settings page styles
  view.css             Page layout for each view
  theme.css            Colors and fonts for light and dark mode
  icons.js             Small inline SVG icons
icons/                 Extension icons (icon.svg is the source for the PNGs),
                       nap.svg / nap-small.svg (the Tab Nap cat for Naps)
docs/screenshots/      Images used in this README
```

No build step: plain HTML, CSS and JavaScript (ES modules).

## Roadmap

- [x] Phase 1: full-tab view, tree, click/close/mute, search, live updates, shortcut, dark mode
- [x] Phase 2: popup and side panel views
- [ ] Phase 3: task-manager actions (pin, sleep, last used, reload, duplicate, Chrome Task Manager)
- [ ] Phase 4: select multiple tabs and move them (done: Ctrl/Shift selection, drag a selection), merge-windows dialog
- [x] Sorting a window by site, title or last use, with Undo
- [x] Settings page; the toolbar icon opens the side panel by default
- [x] Settings sync with your Chrome profile; optional nap sync through bookmarks
- [ ] Phase 5: tab group tools (create, auto-group by site, rename, recolor, ungroup)
- [x] Phase 6: drag and drop (tabs, groups and windows; to a new window; merging)
- [x] Phase 7: saved lists ("Naps") with import/export and undo
