// Brave only. MAIN world, document_start, www.youtube.com top frame.
//
// Brave Shields runs uBlock Origin's quick fixes on YouTube. Those ask for
// the ad-free version of a video in several ways, chosen by a marker in the
// player's user agent string, and try them in the order channel, YAHI,
// inline, oaeb. Tested on 24 November 2026 (signed in), the first three
// were refused or still carried ads, so every video could reload three
// times (10 to 20 s on a spinner) before reaching the one that works.
//
// This script adds the "oaeb" marker up front, in the same place and form
// the quick fixes use, so Shields' own rule asks the working way first.
//
// It also switches off two YouTube experiments, all_web_enable_network_machine
// and all_web_network_machine_raw_request. With them on (seen on a signed-in
// account), the player builds its requests without JSON.stringify, so no
// request rule (Shields' or Bulwark's) ever applies. Brave's community
// workaround and uBlock Origin's earlier fix switch them off the same way.
// It removes the ad schedule from the page's built-in first answer, and
// shortens the start-up wait YouTube's streaming server asks for (see
// below). Bulwark changes nothing else on YouTube in
// Brave. The quick fixes strip the markers from comment requests themselves.
(() => {
  'use strict';
  if (window.top !== window || location.hostname !== 'www.youtube.com') return;
  const TAG = 'oaeb';
  const FLAGS_OFF = ['all_web_enable_network_machine', 'all_web_network_machine_raw_request'];
  function flags() {
    try {
      const d = window.ytcfg && window.ytcfg.data_;
      if (!d) return;
      const f = d.EXPERIMENT_FLAGS;
      if (f && typeof f === 'object') for (const k of FLAGS_OFF) if (f[k] !== false) f[k] = false;
      // The player gets its own packed copy ("a=1&b=true&...") per context.
      const pc = d.WEB_PLAYER_CONTEXT_CONFIGS;
      if (pc && typeof pc === 'object') {
        for (const c of Object.values(pc)) {
          if (!c || typeof c.serializedExperimentFlags !== 'string') continue;
          let s = c.serializedExperimentFlags;
          for (const k of FLAGS_OFF) s = s.replace(new RegExp('(^|&)' + k + '=true(?=&|$)'), '$1' + k + '=false');
          if (s !== c.serializedExperimentFlags) c.serializedExperimentFlags = s;
        }
      }
    } catch { /* ignore */ }
  }
  function tag() {
    flags();
    try {
      const d = window.ytcfg && window.ytcfg.data_;
      const c = d && d.INNERTUBE_CONTEXT && d.INNERTUBE_CONTEXT.client;
      if (!c || typeof c.userAgent !== 'string') return false;
      if (c.clientName && c.clientName !== 'WEB') return true; // not the desktop site
      if (/;\s*oaeb\b/.test(c.userAgent)) return true;
      const m = c.userAgent.match(/Mozilla\/5\.0 \([^)]+/);
      if (!m) return true; // unknown form: leave it alone
      c.userAgent = c.userAgent.replace(m[0], m[0] + '; ' + TAG);
      return true;
    } catch { return false; }
  }
  // ytcfg arrives with the page's first inline scripts and is filled in by
  // several of them, so this keeps applying until the page has loaded.
  tag();
  let mo = null;
  const stop = () => { if (mo) { tag(); mo.disconnect(); mo = null; } };
  try {
    mo = new MutationObserver(tag);
    mo.observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', () => window.setTimeout(stop, 0), { once: true });
    window.setTimeout(stop, 15000);
  } catch { /* ignore */ }

  // ------------------------------------------- page's built-in answer
  // A page opened directly carries its first player answer inline
  // (ytInitialPlayerResponse). Seen on 24 November 2026: in Brave it still
  // held a full ad schedule, the player waited about 12 s for an ad that
  // Shields then blocked, and only then asked for the video. So the ad
  // schedule is removed from that one answer before the player reads it.
  // Answers fetched later go through Shields' own rules.
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];
  const strip = (v) => {
    try {
      if (v && typeof v === 'object' && v.videoDetails && v.playabilityStatus && !(v.videoDetails.isLive || v.videoDetails.isUpcoming)) {
        for (const k of AD_KEYS) if (k in v) delete v[k];
      }
      // The "Ad blockers are not allowed on YouTube" pop-up in the same
      // answer is left exactly as it is: removing it, or only marking it
      // not visible, makes YouTube stop with "Something went wrong" (error
      // 282054944, both seen live on 25 November 2026). The stylesheet
      // hides it on screen.
    } catch { /* ignore */ }
    return v;
  };
  try {
    const existing = Object.getOwnPropertyDescriptor(window, 'ytInitialPlayerResponse');
    if (!existing || existing.configurable) {
      let value = existing && 'value' in existing ? strip(existing.value) : undefined;
      Object.defineProperty(window, 'ytInitialPlayerResponse', {
        configurable: true, enumerable: true,
        get() { return value; },
        set(v) { value = strip(v); }
      });
    }
  } catch { /* ignore */ }

  // ------------------------------------------------ 17 s penalty
  // YouTube holds back flagged accounts with a fixed 17 second timer before
  // the first video request (seen live on 25 November 2026: first request
  // at 19.5 s). uBlock Origin's quick fixes run it at once
  // (nano-stb, [native code], 17000, 0.001), as Bulwark does elsewhere.
  try {
    const fnToString = Function.prototype.toString;
    window.setTimeout = new Proxy(window.setTimeout, {
      apply(target, thisArg, args) {
        if (args[1] === 17000 && typeof args[0] === 'function') {
          try { if (fnToString.call(args[0]).indexOf('[native code]') >= 0) args[1] = 17; } catch { /* ignore */ }
        }
        return Reflect.apply(target, thisArg, args);
      }
    });
  } catch { /* ignore */ }

  // ------------------------------------------------- start-up wait
  // When ads YouTube scheduled are blocked, its streaming server tells the
  // player to wait before asking for video ("backoff", about 80% of the
  // ads' length: the 10 to 15 s spinner on a page opened directly). The
  // wait arrives in small SABR control responses from googlevideo.com as
  // protobuf field 4 in milliseconds. Those values are shortened to about
  // 0.1 s, keeping the byte length. Responses of 1000 bytes or more are
  // video data and pass through untouched. This follows Brave's own
  // brave-yt-sabr-fix.js (adblock-resources), which Brave has switched off
  // since May 2026 without saying why; see the README.
  const nativeFetch = window.fetch;
  const LIMIT = 1000;
  // Rewrites field-4 varints holding a plausible wait (0.5 s to 100 s).
  // Returns true when something changed.
  function shorten(b) {
    let hit = false;
    for (let i = 0; i < b.length - 1; i++) {
      if (b[i] !== 0x20) continue;
      let v = 0, n = 0, j = i + 1, shift = 0;
      while (j < b.length && n < 5) { const x = b[j]; v += (x & 0x7f) * Math.pow(2, shift); shift += 7; n++; j++; if (!(x & 0x80)) break; }
      if (j > b.length || (b[j - 1] & 0x80) || n < 2 || n > 3 || v <= 500 || v >= 100000) continue;
      // The same number of bytes, so every length around it stays right.
      let w = 50 + Math.floor(Math.random() * 100);
      for (let k = 0; k < n; k++) { b[i + 1 + k] = (w & 0x7f) | (k < n - 1 ? 0x80 : 0); w = Math.floor(w / 128); }
      hit = true;
      i = j - 1;
    }
    return hit;
  }
  async function patched(res) {
    if (!res || !res.body || !res.ok) return res;
    const [mine, theirs] = res.body.tee();
    const reader = mine.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); size += value.length;
      if (size >= LIMIT) { reader.cancel().catch(() => {}); return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers }); }
    }
    const b = new Uint8Array(size);
    let o = 0;
    for (const p of parts) { b.set(p, o); o += p.length; }
    theirs.cancel().catch(() => {});
    shorten(b);
    return new Response(b, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  try {
    window.fetch = new Proxy(nativeFetch, {
      apply(target, thisArg, args) {
        const p = Reflect.apply(target, thisArg, args);
        let url = '';
        try { const a = args[0]; url = typeof a === 'string' ? a : (a && a.url) || String(a || ''); } catch { /* ignore */ }
        if (url.indexOf('googlevideo.com') < 0 || url.indexOf('sabr=1') < 0) return p;
        return p.then((res) => patched(res).catch(() => res));
      }
    });
  } catch { /* ignore */ }
})();
