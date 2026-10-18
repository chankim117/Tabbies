// shared/nap-data.js
//
// Plain helpers for Naps (tabs closed and kept for later), with no chrome.*
// calls: display names, and the plain-text format used for
// import and export.
//
// The text has one link per line as "URL | Title", with a
// blank line between lists; its "Import URLs" reads the same. So text copied
// out of other tab tools that use this common format can be imported too.

const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const dateFormatWithYear = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** "Oct 17, 4:32 PM" (the year is added when it isn't this year). */
export function formatNapDate(time) {
  const date = new Date(time);
  return (date.getFullYear() === new Date().getFullYear() ? dateFormat : dateFormatWithYear).format(date);
}

/** A nap's name: what you renamed it to, otherwise when it was made. */
export function napName(nap) {
  return nap.title || formatNapDate(nap.createdAt);
}

/**
 * Text → lists of links: [{ links: [{ url, title }] }].
 * Lines that aren't web or browser addresses are skipped.
 */
export function parseNapText(text) {
  const lists = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      current = null; // a blank line ends the list
      continue;
    }
    const bar = line.indexOf(' | ');
    const url = (bar === -1 ? line : line.slice(0, bar)).trim();
    const title = bar === -1 ? '' : line.slice(bar + 3).trim();
    if (!isRestorableUrl(url)) continue;
    if (!current) {
      current = { links: [] };
      lists.push(current);
    }
    current.links.push({ url, title: title || url });
  }
  return lists;
}

/** Naps → text. */
export function formatNapText(naps) {
  return naps
    .filter((nap) => nap.links.length > 0)
    .map((nap) => nap.links.map((link) => `${link.url} | ${link.title.replace(/\s+/g, ' ')}`).join('\n'))
    .join('\n\n');
}

/** Addresses we'll save and reopen: web pages, files and browser pages; never scripts. */
export function isRestorableUrl(text) {
  try {
    return ['http:', 'https:', 'ftp:', 'file:', 'chrome:', 'about:'].includes(new URL(text).protocol);
  } catch {
    return false;
  }
}
