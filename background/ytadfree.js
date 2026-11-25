// Ad-free YouTube playback: which request method page loads start with.
// See content/youtube-main.js. Only the player's own request is changed,
// never the page address (a changed address got a full-page "This content
// isn't available" error). YouTube changes which variants it accepts,
// so the page script tries them in order and, when one fails (an error
// screen, or ads arriving anyway) and a normal request then works, it tells
// the service worker to start new pages at the next method. After a while
// the first method gets another chance, in case YouTube changed back.
//
// Keep in step with METHODS in content/youtube-main.js.
// The other forms in uBlock Origin's lists (clientScreen CHANNEL or
// ADUNIT, params YAHI or 8AUB, isInlinePlaybackNoAd) were refused or still
// got ads in testing on 24 November 2026, signed in and out.
export const YT_METHODS = [
  { id: 'oaeb' },     // params oAEBogYBLg
  { id: 'eafg' },     // params eAFgAQ
  { id: 'yaf4' }      // params YAF4AaIGAS4
];
// Renamed when the list of methods changes, so an old index is not reused.
const KEY = 'ytAdFree8';
export const YT_RETRY_AFTER = 2 * 3600 * 1000;

// 0..YT_METHODS.length; YT_METHODS.length means none works right now.
export async function ytStartMethod() {
  try {
    const { [KEY]: v } = await chrome.storage.local.get(KEY);
    if (v && Number.isInteger(v.m) && v.m > 0 && v.m <= YT_METHODS.length && Date.now() - v.at < YT_RETRY_AFTER) return v.m;
  } catch { /* storage unavailable */ }
  return 0;
}

// A page found that method m - 1 failed. One bad answer can be a fluke
// (YouTube refuses a single request now and then), so a method is only
// dropped for new pages after it fails three times within an hour, and
// gets another chance two hours later.
const STRIKES = 'ytStrikes2';
export async function ytStrike(m) {
  if (!Number.isInteger(m) || m < 1 || m > YT_METHODS.length) return false;
  let st = null;
  try { st = (await chrome.storage.local.get(STRIKES))[STRIKES]; } catch { /* storage unavailable */ }
  if (!st || typeof st !== 'object' || Date.now() - (st.at || 0) > 3600 * 1000) st = { at: Date.now(), n: {} };
  st.n = st.n && typeof st.n === 'object' ? st.n : {};
  st.n[m] = (st.n[m] | 0) + 1;
  if (st.n[m] < 3) { await chrome.storage.local.set({ [STRIKES]: st }).catch(() => {}); return false; }
  delete st.n[m];
  await chrome.storage.local.set({ [STRIKES]: st }).catch(() => {});
  return ytRetireTo(m);
}

// Moves forward only. Returns true when the start method changed.
export async function ytRetireTo(m) {
  if (!Number.isInteger(m) || m < 1 || m > YT_METHODS.length) return false;
  if (m <= await ytStartMethod()) return false;
  await chrome.storage.local.set({ [KEY]: { m, at: Date.now() } });
  try { chrome.alarms.create('bw-ytadfree', { when: Date.now() + YT_RETRY_AFTER + 1000 }); } catch { /* ignore */ }
  return true;
}

export async function ytResetMethod() {
  try { await chrome.storage.local.remove([KEY, STRIKES]); } catch { /* ignore */ }
}

// The flag file registered in front of youtube-main.js, or null when no
// method is left.
export function ytFlagFile(m) {
  return m < YT_METHODS.length ? `content/youtube-flag-${m}.js` : null;
}
