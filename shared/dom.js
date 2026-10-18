// shared/dom.js — a tiny helper for building page elements, used by the
// explorer and the Settings page.

/**
 * h('span', { class: 'title' }, 'Hello') creates <span class="title">Hello</span>.
 * Attributes that are false/null are skipped. Children that are strings
 * become text nodes, never HTML, so a page title like "<img onerror=…>"
 * is shown as plain text and can't inject anything into Tabbies.
 */
export function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value == null) continue;
    element.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === false || child == null || child === '') continue;
    element.append(child);
  }
  return element;
}
