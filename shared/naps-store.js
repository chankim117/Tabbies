// shared/naps-store.js
//
// Where naps are kept. Two interchangeable stores with the same functions:
//
//   localStore     chrome.storage.local, on this computer only (the default).
//   bookmarkStore  a "Tabbies Naps" folder under Other bookmarks, which
//                  Chrome Sync copies to every computer signed in to the same
//                  Chrome profile. Used when Settings → "Sync naps" is on
//                  (needs the optional "bookmarks" permission).
//
// Each store has:
//   read()                  → Nap[]  newest first
//   addNap(nap, index)      → the saved nap with its new ids (index -1 = at the end)
//   appendLinks(napId, links) → the saved links with their new ids
//   removeLinks(linkIds)    removes links; a nap left empty disappears
//   removeNap(napId)
//   rename(napId, title)
//   moveLinks(linkIds, to)  to = { napId, beforeLinkId? | afterLinkId? } or { newNap: true };
//                           a nap left empty disappears
//   moveNap(napId, to)      to = { beforeNapId } | { afterNapId }
//
// Nap  = { id, title, createdAt, color?, links: Link[] }
// Link = { id, url, title, favIconUrl }

import { formatNapDate } from './nap-data.js';

// ---- This computer: chrome.storage.local -------------------------------------------------

export const localStore = {
  async read() {
    // chrome.storage.local.get returns { naps } if anything was saved yet.
    const { naps = [] } = await chrome.storage.local.get('naps');
    return naps;
  },

  async addNap(nap, index) {
    const naps = await this.read();
    const saved = {
      ...nap,
      id: nap.id ?? crypto.randomUUID(),
      links: nap.links.map((link) => ({ ...link, id: link.id ?? crypto.randomUUID() })),
    };
    naps.splice(index === -1 ? naps.length : index, 0, saved);
    await writeLocal(naps);
    return saved;
  },

  async appendLinks(napId, links) {
    const naps = await this.read();
    const nap = naps.find((n) => n.id === napId);
    const saved = links.map((link) => ({ ...link, id: crypto.randomUUID() }));
    nap.links.push(...saved);
    await writeLocal(naps);
    return saved;
  },

  async removeLinks(linkIds) {
    const ids = new Set(linkIds);
    const naps = await this.read();
    await writeLocal(
      naps.map((nap) => ({ ...nap, links: nap.links.filter((link) => !ids.has(link.id)) })).filter((nap) => nap.links.length > 0),
    );
  },

  async removeNap(napId) {
    await writeLocal((await this.read()).filter((nap) => nap.id !== napId));
  },

  async rename(napId, title) {
    await writeLocal((await this.read()).map((nap) => (nap.id === napId ? { ...nap, title } : nap)));
  },

  async moveLinks(linkIds, to) {
    const naps = await this.read();
    const ids = new Set(linkIds);
    const all = naps.flatMap((nap) => nap.links);
    const moving = linkIds.map((id) => all.find((link) => link.id === id)).filter(Boolean);
    for (const nap of naps) nap.links = nap.links.filter((link) => !ids.has(link.id));

    const dest = !to.newNap && naps.find((nap) => nap.id === to.napId);
    if (dest) {
      let at = dest.links.length;
      if (to.beforeLinkId) at = dest.links.findIndex((link) => link.id === to.beforeLinkId);
      else if (to.afterLinkId) at = dest.links.findIndex((link) => link.id === to.afterLinkId) + 1;
      dest.links.splice(at < 0 ? dest.links.length : at, 0, ...moving);
    } else {
      naps.unshift({ id: crypto.randomUUID(), title: '', createdAt: Date.now(), links: moving });
    }
    await writeLocal(naps.filter((nap) => nap.links.length > 0));
  },

  async moveNap(napId, to) {
    const naps = await this.read();
    const from = naps.findIndex((nap) => nap.id === napId);
    if (from === -1) return;
    const [nap] = naps.splice(from, 1);
    const anchor = naps.findIndex((other) => other.id === (to.beforeNapId ?? to.afterNapId));
    naps.splice(anchor === -1 ? naps.length : anchor + (to.afterNapId ? 1 : 0), 0, nap);
    await writeLocal(naps);
  },
};

function writeLocal(naps) {
  // chrome.storage.local.set saves values (as JSON) under their keys.
  return chrome.storage.local.set({ naps });
}

// ---- Synced: a Chrome bookmarks folder -----------------------------------------------------
//
// Folder layout:  Other bookmarks / Tabbies Naps / <one folder per nap> / <one bookmark per link>
//   - a nap's id and its links' ids are their bookmark ids;
//   - createdAt is the folder's dateAdded (Chrome sets and syncs it);
//   - a nap that came from a tab group ends with that group's color dot, e.g. "Reading 🟣";
//   - an untitled nap's folder is named with its date.
// Site icons aren't part of bookmarks, so the icons of tabs napped on this
// computer are remembered locally (key "napIcons").

const FOLDER_TITLE = 'Tabbies Naps';
const COLOR_MARKS = {
  grey: '⚪',
  blue: '🔵',
  red: '🔴',
  yellow: '🟡',
  green: '🟢',
  pink: '🩷',
  purple: '🟣',
  cyan: '🩵',
  orange: '🟠',
};

export const bookmarkStore = {
  async read() {
    const [[folder], { napIcons = {} }] = await Promise.all([
      // chrome.bookmarks.getSubTree returns a folder with all its contents.
      chrome.bookmarks.getSubTree(await napsFolderId()),
      chrome.storage.local.get('napIcons'),
    ]);
    return (folder.children ?? [])
      .filter((node) => !node.url)
      .map((napFolder) => {
        const { title, color } = parseFolderTitle(napFolder.title, napFolder.dateAdded);
        const links = (napFolder.children ?? [])
          .filter((node) => node.url)
          .map((bookmark) => ({
            id: bookmark.id,
            url: bookmark.url,
            title: bookmark.title || bookmark.url,
            favIconUrl: napIcons[bookmark.url] ?? '',
          }));
        return { id: napFolder.id, title, color, createdAt: napFolder.dateAdded, links };
      })
      .filter((nap) => nap.links.length > 0);
  },

  async addNap(nap, index) {
    // chrome.bookmarks.create makes a folder (no url) or a bookmark (with url).
    const folder = await chrome.bookmarks.create({
      parentId: await napsFolderId(),
      title: folderTitle(nap),
      ...(index === -1 ? {} : { index }),
    });
    const links = await createBookmarks(folder.id, nap.links);
    return { ...nap, id: folder.id, createdAt: folder.dateAdded, links };
  },

  async appendLinks(napId, links) {
    return createBookmarks(napId, links);
  },

  async removeLinks(linkIds) {
    const parents = new Set();
    for (const id of linkIds) {
      // chrome.bookmarks.get fails for a bookmark that's already gone.
      const [bookmark] = await chrome.bookmarks.get(id).catch(() => []);
      if (!bookmark) continue;
      parents.add(bookmark.parentId);
      await chrome.bookmarks.remove(id);
    }
    // A nap folder left empty disappears, like an emptied nap.
    for (const parentId of parents) {
      const left = await chrome.bookmarks.getChildren(parentId).catch(() => null);
      if (left && left.length === 0) await chrome.bookmarks.remove(parentId);
    }
  },

  async removeNap(napId) {
    // chrome.bookmarks.removeTree removes a folder and everything in it.
    await chrome.bookmarks.removeTree(napId).catch(() => {});
  },

  async rename(napId, title) {
    const [folder] = await chrome.bookmarks.get(napId);
    const { color } = parseFolderTitle(folder.title, folder.dateAdded);
    // chrome.bookmarks.update changes a bookmark's or folder's title.
    await chrome.bookmarks.update(napId, { title: folderTitle({ title, color, createdAt: folder.dateAdded }) });
  },

  async moveLinks(linkIds, to) {
    const parentId = to.newNap
      ? (await chrome.bookmarks.create({ parentId: await napsFolderId(), title: folderTitle({}), index: 0 })).id
      : to.napId;
    const sources = new Set();
    let after = to.afterLinkId;
    for (const id of linkIds) {
      const [bookmark] = await chrome.bookmarks.get(id).catch(() => []);
      if (!bookmark) continue;
      sources.add(bookmark.parentId);
      await chrome.bookmarks.move(id, { parentId, ...(await bookmarkIndex(to.beforeLinkId, after)) });
      // The next link goes right after this one, so they stay in order.
      if (!to.beforeLinkId) after = id;
    }
    await removeIfEmpty([...sources].filter((id) => id !== parentId));
  },

  async moveNap(napId, to) {
    await chrome.bookmarks.move(napId, { parentId: await napsFolderId(), ...(await bookmarkIndex(to.beforeNapId, to.afterNapId)) });
  },
};

/**
 * The `index` for chrome.bookmarks.move to land just before or after another
 * bookmark. Unlike chrome.tabs.move, it counts positions as they are *before*
 * the move, so no adjusting is needed. Neither given: {} (= at the end).
 */
async function bookmarkIndex(beforeId, afterId) {
  const anchorId = beforeId ?? afterId;
  if (!anchorId) return {};
  const [anchor] = await chrome.bookmarks.get(anchorId).catch(() => []);
  if (!anchor) return {};
  return { index: beforeId ? anchor.index : anchor.index + 1 };
}

async function removeIfEmpty(folderIds) {
  for (const id of folderIds) {
    const left = await chrome.bookmarks.getChildren(id).catch(() => null);
    if (left && left.length === 0) await chrome.bookmarks.remove(id);
  }
}

async function createBookmarks(parentId, links) {
  const saved = [];
  for (const link of links) {
    const bookmark = await chrome.bookmarks.create({ parentId, title: link.title, url: link.url });
    saved.push({ ...link, id: bookmark.id });
  }
  await rememberIcons(saved);
  return saved;
}

async function rememberIcons(links) {
  const withIcons = links.filter((link) => link.favIconUrl);
  if (withIcons.length === 0) return;
  const { napIcons = {} } = await chrome.storage.local.get('napIcons');
  for (const link of withIcons) napIcons[link.url] = link.favIconUrl;
  await chrome.storage.local.set({ napIcons });
}

let folderIdPromise = null;

/** The id of the "Tabbies Naps" folder, made under Other bookmarks if it's missing. */
function napsFolderId() {
  folderIdPromise ??= findOrCreateFolder().finally(() => {
    folderIdPromise = null;
  });
  return folderIdPromise;
}

async function findOrCreateFolder() {
  // Remembered from last time? (Bookmark ids differ between computers, so
  // this is stored locally, not synced.)
  const { napFolderId } = await chrome.storage.local.get('napFolderId');
  if (napFolderId) {
    const [folder] = await chrome.bookmarks.get(napFolderId).catch(() => []);
    if (folder && !folder.url) return folder.id;
  }
  // Otherwise look for it under Other bookmarks (it may have arrived through
  // sync from another computer) and create it if it isn't there.
  // chrome.bookmarks.getTree returns the whole tree; its root's children are
  // the bookmarks bar, Other bookmarks and Mobile bookmarks.
  const [root] = await chrome.bookmarks.getTree();
  const other = root.children.find((node) => node.folderType === 'other') ?? root.children[1] ?? root.children[0];
  const existing = (await chrome.bookmarks.getChildren(other.id)).find(
    (node) => !node.url && node.title === FOLDER_TITLE,
  );
  const folder = existing ?? (await chrome.bookmarks.create({ parentId: other.id, title: FOLDER_TITLE }));
  await chrome.storage.local.set({ napFolderId: folder.id });
  return folder.id;
}

function folderTitle({ title, color, createdAt }) {
  const name = title || formatNapDate(createdAt ?? Date.now());
  return color && COLOR_MARKS[color] ? `${name} ${COLOR_MARKS[color]}` : name;
}

function parseFolderTitle(text, dateAdded) {
  let title = text;
  let color;
  for (const [name, mark] of Object.entries(COLOR_MARKS)) {
    if (title.endsWith(` ${mark}`)) {
      color = name;
      title = title.slice(0, -(mark.length + 1));
      break;
    }
  }
  // A folder named with its own date is an untitled nap.
  if (title === formatNapDate(dateAdded)) title = '';
  return { title, color };
}
