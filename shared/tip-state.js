// shared/tip-state.js
//
// Which tips you've retired ("Got it"), which one was shown last, and whether
// tips are off. Kept in localStorage: it belongs to this Chrome profile on
// this computer (it doesn't sync), and every Tabbies page shares it. Used by
// the explorer (the tip banner) and Settings (Tips).

const TIPS_KEY = 'tabbies-tips';
const OLD_KEY = 'tabbies-tip-dismissed'; // before rotating tips: the one "clicks" tip

/** @returns {{ done: string[], last: string|null, off: boolean }} */
export function readTipState() {
  try {
    const saved = JSON.parse(localStorage.getItem(TIPS_KEY) ?? '{}');
    const done = Array.isArray(saved.done) ? saved.done : [];
    const oldDismissed = localStorage.getItem(OLD_KEY) === '1';
    return {
      done: oldDismissed && !done.includes('clicks') ? [...done, 'clicks'] : done,
      last: saved.last ?? null,
      off: Boolean(saved.off),
    };
  } catch {
    return { done: [], last: null, off: false };
  }
}

export function writeTipState(state) {
  try {
    localStorage.setItem(TIPS_KEY, JSON.stringify(state));
  } catch {
    // storage blocked: tips just start over next time
  }
}

/** Turns tips on or off (Settings → Tips). */
export function setTipsOn(on) {
  writeTipState({ ...readTipState(), off: !on });
}

/** Brings every tip back, from the first one, and turns tips on. */
export function resetTips() {
  try {
    localStorage.removeItem(OLD_KEY);
  } catch {
    // storage blocked: nothing to reset
  }
  writeTipState({ done: [], last: null, off: false });
}
