// Ad-free YouTube playback: which request method page loads start with.
// See content/youtube-main.js. YouTube changes which variants it accepts,
// so the page script tries them in order and, when one fails (an error
// screen, or ads arriving anyway) and a normal request then works, it tells
// the service worker to start new pages at the next method. After a while
// the first method gets another chance, in case YouTube changed back.
//
// Keep in step with METHODS in content/youtube-main.js.
export const YT_METHODS = [
  { id: 'yaf4', pp: 'YAF4AaIGAS4' },   // params fields 12, 15 and 100 (no ads at all)
  { id: 'eafg', pp: 'eAFgAQ' },        // params fields 15 and 12 (no ads at all)
  { id: 'inline', pp: null },          // isInlinePlaybackNoAd (player requests only)
  { id: 'lactmilli', pp: null },       // params field 94 and a fresh activity time
  { id: 'yahi', pp: null },            // params YAHI
  { id: 'channel', pp: null }          // clientScreen CHANNEL
];
const KEY = 'ytAdFree';
export const YT_RETRY_AFTER = 12 * 3600 * 1000;

// 0..YT_METHODS.length; YT_METHODS.length means none works right now.
export async function ytStartMethod() {
  try {
    const { [KEY]: v } = await chrome.storage.local.get(KEY);
    if (v && Number.isInteger(v.m) && v.m > 0 && v.m <= YT_METHODS.length && Date.now() - v.at < YT_RETRY_AFTER) return v.m;
  } catch { /* storage unavailable */ }
  return 0;
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
  try { await chrome.storage.local.remove(KEY); } catch { /* ignore */ }
}

// The flag file registered in front of youtube-main.js, or null when no
// method is left.
export function ytFlagFile(m) {
  return m < YT_METHODS.length ? `content/youtube-flag-${m}.js` : null;
}
