# Chrome Web Store listing: Tabbies

Texts to paste into the [developer dashboard](https://chrome.google.com/webstore/devconsole), in the order the dashboard asks for them. Images are in this folder (see the end).

---

## Store listing tab

**Name:** Tabbies

**Summary** (from manifest.json, 129 of 132 characters):

> A file-explorer-style tab manager: browse, move and organize your windows, tab groups and tabs as a tree, and nap tabs for later.

**Category:** Productivity → Tools (Workflow & Planning also fits)

**Language:** English

**Description:**

```
Tabbies shows every open window, tab group and tab as a tree, and lets you organize them the way you organize files on your computer.

ORGANIZE LIKE FILES
• Windows → tab groups → tabs, in one tree. Fold and unfold like folders.
• Click to select, double-click to open, right-click for everything else.
• Ctrl/Shift+click to select several tabs, or click a window or group to select all of it.
• Drag tabs, groups and whole windows anywhere: into another window, into a group, into a new window. Drop one window on another to merge them.
• Name your windows ("Work", "Trip planning"). Names stay after Chrome restarts.

TAB GROUPS
• Group selected tabs (Ctrl+G) and name the group as you go.
• Rename, recolor, ungroup (Ctrl+Shift+G) or close a group.

NAPS: CLOSE TABS, KEEP THEM FOR LATER
• Nap a tab, a group, a window or every window: the tabs close and their links are kept.
• Wake them later: here, as a group, or in a new window.
• Alt+N naps the tab you're looking at; Alt+W naps the whole window.
• Import and export plain "URL | Title" lists. Optional sync through your Chrome bookmarks.

TAB TOOLS
• Sort a window by site, title or when you last used each tab.
• Spot and close duplicate tabs.
• Pin, mute, reload, duplicate, or put tabs to sleep to free memory.
• Rest the mouse on a tab to see its full address, when you last used it, and more. Optional page previews.
• Ctrl+Z undoes closing, napping, grouping and sorting.

YOUR WAY
• Opens in a full tab (Alt+T), Chrome's side panel, or a popup.
• Light and dark mode.
• Keyboard friendly: arrow keys, search with /, Del, N, Ctrl+G, Shift+F10. Press ? for the full list.
• Handy tips (that you can turn off) remind you of the shortcuts.

PRIVATE BY DESIGN
Everything stays on your computer. No account, no server, no analytics, no ads. Page previews and nap sync are off unless you turn them on, and only then ask for the extra permission they need.
```

**Images:** see "Images" at the end.

---

## Privacy tab

**Single purpose:**

> Tabbies is a tab manager: it shows the user's open windows, tab groups and tabs as a tree so they can find, organize, move and close them, and save tabs ("naps") to reopen later.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `tabs` | To show the titles, addresses and icons of the user's open tabs in the tree, and to switch to, move, close, reload, duplicate, pin, mute and nap them. |
| `tabGroups` | To show tab groups in the tree with their names and colors, and to create, rename, recolor, move and ungroup them. |
| `sidePanel` | Tabbies can be shown in Chrome's side panel (one of its three views). |
| `storage` | To save the user's naps, window names and settings on their computer (settings also sync through the user's Chrome profile). |
| `unlimitedStorage` | Naps can hold tens of thousands of saved links, which can go past the standard 10 MB extension storage limit. |
| `contextMenus` | Adds "Nap this tab", "Nap all tabs in this window", "Nap all tabs in every window" and "Open Tabbies in a tab" to the right-click menu of the Tabbies toolbar icon. |
| `bookmarks` (optional) | Asked for only when the user turns on "Sync naps": naps are then kept in a "Tabbies Naps" bookmarks folder so Chrome Sync brings them to the user's other computers. Only that folder is read or changed. |
| Host permission `<all_urls>` (optional) | Asked for only when the user turns on "Page previews": Tabbies calls chrome.tabs.captureVisibleTab to take a small picture of the tab the user is looking at, shown later when they point at that tab in Tabbies. Page content is never read, changed or sent anywhere; the pictures stay in memory on the user's computer and are deleted when previews are turned off or Chrome closes. |

**Are you using remote code?** No. All JavaScript is included in the package; there are no external scripts, eval or remote configuration.

**Data usage.** Tabbies sends nothing off the user's computer. The dashboard's form asks what user data the extension "collects". If you're unsure how strictly Google reads that word, declaring is the safe choice:

- ☑ **Web history** (titles and addresses of open tabs, saved in naps)
- ☑ **Website content** (page preview pictures, only if the user turns previews on)
- Leave everything else unticked.

Then tick all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** the address where `PRIVACY.md` is published (fill in its contact line first). This repository has no remote yet, so the policy needs a public address, for example:

- the file's page on GitHub, once the repository is pushed there (public), or
- a GitHub Pages site, or any static page that shows the same text.

---

## Test instructions (Distribution tab, optional)

> No account or setup needed. Click the Tabbies icon (or press Alt+T) to open it in a tab. Click a tab to select it, double-click to switch to it, right-click for its menu. The nap (cat) button on a tab, group or window closes those tabs and saves them under Naps at the bottom; the sun button wakes them. Page previews and nap sync are optional, under Settings (gear icon).

---

## Images

| File | Size | Use |
| --- | --- | --- |
| `screenshot-1-tree.png` | 1280×800 | Screenshot: the tree, with groups, a selection and naps |
| `screenshot-2-menu-dark.png` | 1280×800 | Screenshot: right-click menu, dark mode |
| `screenshot-3-hover-card.png` | 1280×800 | Screenshot: hover card with a page preview |
| `screenshot-4-side-panel.png` | 1280×800 | Screenshot: Tabbies in the side panel |
| `screenshot-5-naps.png` | 1280×800 | Screenshot: naps |
| `promo-small-440x280.png` | 440×280 | Small promo tile (required) |

The store icon is `icons/icon128.png`.
