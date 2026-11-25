// YouTube ad layer. MAIN world, document_start, every YouTube frame.
//
// Rule one: a video that plays beats an ad that is blocked. Everything
// below gives way when YouTube pushes back.
//
// 1. Ad-free playback requests (youtube.com watch pages). When YouTube
//    schedules ads for a video and they are removed, its streaming server
//    holds back the video ("fake buffering": a spinner at 0:00, then
//    "Experiencing interruptions?"). So Bulwark asks for a variant of the
//    video that comes without ads. Only the player's own request is changed
//    (the one that carries an attestationRequest), in the forms uBlock
//    Origin's quick fixes use. The page address is never changed: YouTube
//    answers a changed address with a full-page "This content isn't
//    available" error. If a form gets ads anyway, or ends in an error screen
//    while a normal request plays, it is retired: the video is loaded again
//    and new pages start with the next form (the service worker remembers it).
//
// 2. Ad payload pruning (everywhere). adPlacements, adSlots and playerAds
//    are removed from player responses before the player reads them, from
//    JSON.parse, Response.json and the inline ytInitialPlayerResponse.
//
// 3. Safety net. If a video on the watch page stays stuck at 0:00 with
//    nothing loaded, or YouTube shows its error screen, the video is loaded
//    again once with nothing changed and nothing removed (ads that then
//    play are skipped by the isolated script). "Fix this video" in the
//    popup does the same on demand, for the rest of the page.
//
// 4. Ads stitched into the stream are jumped over, YouTube's "abnormality"
//    check (which stops the video with "Something went wrong") is never
//    registered, and a fixed 17 s anti-adblock wait runs right away.
//
// Hot path cost: a typeof check per JSON.stringify/parse call and a shape
// check on objects.
//
// Nothing is left on window for the page to find: no globals, no symbols,
// and the hooks report themselves as native code. Running twice is harmless
// because every step is idempotent.
(() => {
  'use strict';
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];
  const reflectApply = Reflect.apply;
  const fnToString = Function.prototype.toString;
  const later = window.setTimeout.bind(window);
  const URLParams = URLSearchParams;
  const now = performance.now.bind(performance);
  let pruned = 0, cost = 0, samples = 0, timer = 0;

  // Stats go to the isolated content script over a private channel: a
  // random event name passed through an attribute that the content script
  // removes before any page script runs. The isolated script sends
  // "fix this video" back on the same name plus "f".
  const dispatch = EventTarget.prototype.dispatchEvent;
  const CE = CustomEvent;
  const channel = 'x' + Math.random().toString(36).slice(2);
  const root = document.documentElement;
  try { root.setAttribute('data-bwy', channel); } catch { /* no root yet */ }
  const report = () => {
    timer = 0;
    try {
      dispatch.call(document, new CE(channel, { detail: pruned + ',' + Math.round(cost * 1000) + ',' + samples }));
    } catch { /* ignore */ }
    pruned = 0; cost = 0; samples = 0;
  };

  // Settings arrive the same way: a content/youtube-flag-N.js file,
  // registered in front of this one, sets data-bwf="N" when ad-free
  // requests are on. N is the method to start with (background/ytadfree.js).
  let adFree = false, method = 0;
  try {
    const f = root.getAttribute('data-bwf');
    if (f !== null) {
      root.removeAttribute('data-bwf');
      const n = parseInt(f, 10);
      if (n >= 0) { adFree = true; method = n; }
    }
  } catch { /* ignore */ }
  const host = location.hostname;
  const isTop = window.top === window;
  adFree = adFree && isTop && (host === 'www.youtube.com' || host === 'youtube.com');

  // ------------------------------------------------- ad-free playback

  // Ways of asking, best first. Keep in step with background/ytadfree.js.
  // Tested on 24 November 2026 (signed in and signed out) against every
  // form in uBlock Origin's quick fixes and experimental list: only these
  // three params values came back without ads. The channel-page form was
  // refused ("Something went wrong"); YAHI, inline, ADUNIT and lactmilli
  // still carried ads.
  const METHODS = [
    { apply: (pr) => { pr.params = 'oAEBogYBLg'; return true; } },
    { apply: (pr) => { pr.params = 'eAFgAQ'; return true; } },
    { apply: (pr) => { pr.params = 'YAF4AaIGAS4'; return true; } }
  ];
  if (method > METHODS.length) method = METHODS.length;
  // Statuses that mean the video itself needs something (sign-in, age
  // check, a live stream that has not started), not that we were refused.
  const GENUINE = new Set(['LOGIN_REQUIRED', 'AGE_CHECK_REQUIRED', 'CONTENT_CHECK_REQUIRED', 'AGE_VERIFICATION_REQUIRED', 'LIVE_STREAM_OFFLINE']);

  const marked = new Map(); // videoId -> { m: method, t: time }
  const reloaded = new Set(); // videos reloaded ad-free after ads arrived
  const reloads = new Map(); // videoId -> reloads after fake buffering
  const plainTried = new Set(); // videos reloaded with a normal request
  const prefetched = new Set(); // videos fetched ahead for autoplay
  // Videos left completely alone: requests unchanged, ads not removed.
  // Filled by the safety net, and for every video after "Fix this video".
  const raw = new Set();
  let allRaw = false;
  const isRaw = (vid) => allRaw || raw.has(vid);
  let bypass = null; // { vid, until }: requests for vid go out unchanged
  let verify = null; // { vid, m }: a plain retry that decides about method m
  let watchToken = 0;

  // Signed-in viewers: YouTube ties the player's own request to an
  // integrity check, and refuses a changed one with "Something went wrong"
  // (error 282054944), seen live on 24 November 2026. The same change is
  // accepted for signed-out viewers. So signed-in pages never ask ad-free;
  // their ads are skipped instead.
  function signedIn() {
    try { const c = window.ytcfg && window.ytcfg.data_; return !!(c && c.LOGGED_IN === true); } catch { return false; }
  }

  function wantsAdFree(pr) {
    if (signedIn()) return false;
    const path = location.pathname;
    if (path.startsWith('/shorts') || path.startsWith('/embed') || path.startsWith('/live_chat')) return false;
    const client = pr.context && pr.context.client;
    if (!client || (client.clientName && client.clientName !== 'WEB')) return false;
    const graft = (client.mainAppWebInfo && client.mainAppWebInfo.graftUrl) || '';
    if (graft.indexOf('/shorts/') >= 0) return false;
    return path === '/watch' || graft.indexOf('/watch') === 0 || graft.indexOf('youtube.com/watch') >= 0;
  }

  // The player's own request for a video. Navigation bundles (get_watch),
  // caption and settings requests are never changed.
  function editRequest(o) {
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return;
    const pr = o.playerRequest !== null && typeof o.playerRequest === 'object' ? o.playerRequest : o;
    const vid = pr.videoId;
    if (typeof vid !== 'string' || pr.playbackContext === null || typeof pr.playbackContext !== 'object') return;
    // YouTube fetches the next video ahead of time while one plays.
    if (pr.playbackContext.prefetchPlaybackContext || (pr.context && pr.context.request && pr.context.request.isPrefetch)) prefetched.add(vid);
    else prefetched.delete(vid); // asked for in earnest: it is being played
    // The untouched retry is on its way: answers from now on are its own.
    if (verify && verify.vid === vid && pr === o) verify.sent = true;
    if (pr !== o || pr.attestationRequest === undefined || pr.captionsRequested !== undefined || pr.settingItemIds !== undefined) return;
    if (isRaw(vid) || (bypass && bypass.vid === vid && Date.now() < bypass.until)) return;
    if (method >= METHODS.length || !wantsAdFree(pr)) return;
    try {
      for (let m = method; m < METHODS.length; m++) {
        if (METHODS[m].apply(pr)) { marked.set(vid, { m, t: Date.now() }); return; }
      }
    } catch { /* never break the request */ }
  }

  const hasAds = (x) => AD_KEYS.slice(0, 3).some(k => Array.isArray(x[k]) ? x[k].length > 0 : x[k] !== undefined);

  // Method m failed: move on, and tell the service worker so new pages
  // start at the next one.
  // The video that failed is loaded untouched anyway; other videos on this
  // page keep asking ad-free until the method fails a second time here.
  let pageFails = 0;
  const reported = new Set();
  function retire(m, vid) {
    if (method > m) return;
    const key = m + ':' + (vid || '');
    if (reported.has(key)) return; // one report per video
    reported.add(key);
    if (++pageFails >= 2) method = m + 1;
    try { dispatch.call(document, new CE(channel, { detail: 'm' + (m + 1) })); } catch { /* ignore */ }
  }

  function player() {
    const pl = document.getElementById('movie_player');
    return pl && typeof pl.loadVideoById === 'function' ? pl : null;
  }

  // An ad stitched into the video stream by YouTube's server ("SSAP"), the
  // kind signed-in viewers get. No request form avoids these, so they never
  // count against one: the player is simply moved to the end of the ad, the
  // way uBlock Origin's quick fixes do it.
  function stitchedAd(pl) {
    try {
      const st = pl.getStatsForNerds && pl.getStatsForNerds();
      return !!st && typeof st.debug_info === 'string' && st.debug_info.startsWith('SSAP, AD');
    } catch { return false; }
  }
  // The card some ads end with ("Visit site", with a skip button): YouTube
  // ignores clicks that do not come from a person, so the player is asked
  // to skip it the way its own button does.
  const cardsSkipped = new Set();
  function skipCard(pl) {
    if (!pl.classList.contains('ytp-ad-display-override') || typeof pl.onAdUxClicked !== 'function') return;
    const btn = pl.querySelector('button[id^="skip-button"]');
    if (!btn || cardsSkipped.has(btn.id) || !btn.getClientRects().length) return;
    cardsSkipped.add(btn.id);
    try { pl.onAdUxClicked('skip-button', btn.id.split(':')[1]); } catch { /* ignore */ }
  }
  function skipStitched() {
    const pl = player();
    if (!pl || !pl.classList.contains('ad-showing')) return;
    skipCard(pl);
    if (!stitchedAd(pl)) return;
    try {
      const p = pl.getProgressState && pl.getProgressState();
      if (p && p.duration > 0 && p.duration - p.current > 0.3) pl.seekTo(p.duration);
    } catch { /* ignore */ }
  }
  if (isTop && (host === 'www.youtube.com' || host === 'youtube.com')) {
    try { window.setInterval(skipStitched, 250); } catch { /* ignore */ }
  }

  // Loads the video again, which sends a fresh player request: ad-free, or
  // unchanged when `plain`. Waits for the player to have the video (or 2 s,
  // in case it is stuck on an error screen without it).
  function loadAgain(vid, x, plain) {
    const sc = x && x.playerConfig && x.playerConfig.playbackStartConfig;
    const start = (sc && +sc.startSeconds) || 0;
    const t0 = Date.now();
    const tick = () => {
      const pl = player();
      let d = null;
      try { d = pl && typeof pl.getVideoData === 'function' ? pl.getVideoData() : null; } catch { /* not ready */ }
      // A player holding no video, or after 2 s one stuck on an error screen,
      // is loaded too, but only if this page is still for that video.
      if (pl && ((d && d.video_id === vid) || (vid === pageVideo() && ((d && !d.video_id) || Date.now() - t0 > 2000)))) {
        let at = start;
        try { if (d && d.video_id === vid) at = Math.max(start, +pl.getCurrentTime() || 0); } catch { /* ignore */ }
        if (plain) bypass = { vid, until: Date.now() + 8000 };
        try { pl.loadVideoById({ videoId: vid, startSeconds: at }); } catch { /* ignore */ }
        revive(vid);
        return;
      }
      if (Date.now() - t0 < 15000) later(tick, 50);
    };
    later(tick, 0);
  }

  // The watch page's own error screen ("Something went wrong", "This
  // content isn't available") sits outside the player, over it. Loading
  // the video again plays it behind that screen, so once the new response
  // is fine the screen is taken down and playback started.
  function pageError() {
    const f = document.querySelector('ytd-watch-flexy[player-unavailable]');
    const es = document.getElementById('error-screen');
    return !!f || !!(es && !es.hidden && es.offsetWidth > 0);
  }
  function revive(vid) {
    const t0 = Date.now();
    const tick = () => {
      const pl = player();
      let ok = false;
      try { const r = pl && pl.getPlayerResponse(); ok = !!r && r.videoDetails && r.videoDetails.videoId === vid && r.playabilityStatus && r.playabilityStatus.status === 'OK'; } catch { /* ignore */ }
      if (ok && vid === pageVideo()) {
        if (pageError()) {
          const f = document.querySelector('ytd-watch-flexy[player-unavailable]');
          if (f) f.removeAttribute('player-unavailable');
          const es = document.getElementById('error-screen');
          if (es) es.hidden = true;
          try { pl.playVideo(); } catch { /* ignore */ }
        }
        return;
      }
      if (Date.now() - t0 < 8000) later(tick, 250);
    };
    later(tick, 250);
  }

  function pageErrorOrPlayerError() {
    if (pageError()) return true;
    const pl = player();
    const err = pl && pl.querySelector('.ytp-error');
    return !!(err && err.offsetWidth > 0);
  }

  // Last resort for a video: load it once more exactly as YouTube sent it,
  // ads and all. The isolated script skips any ad that then plays.
  const rawTried = new Set();
  function untouched(vid, x) {
    if (!vid || rawTried.has(vid)) return false;
    rawTried.add(vid);
    raw.add(vid);
    plainTried.add(vid);
    // Its answer must not be judged as the ad-free request's answer.
    marked.delete(vid);
    loadAgain(vid, x || {}, true);
    return true;
  }

  // Safety net: an error screen on the watch page is answered at any time,
  // not only while a watch below runs. A video asked for ad-free is retried
  // normally (which decides about the method); any other video is loaded
  // once untouched.
  function rescue() {
    const vid = pageVideo();
    if (!vid || !pageErrorOrPlayerError()) return;
    const mk = marked.get(vid);
    if (mk && !plainTried.has(vid)) { suspect(vid, mk.m, {}); return; }
    untouched(vid, {});
  }
  // The error screen shows by YouTube setting player-unavailable on the
  // watch page and un-hiding #error-screen.
  if (isTop) {
    try {
      new MutationObserver(() => later(rescue, 300)).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['player-unavailable', 'hidden'] });
    } catch { /* ignore */ }
  }

  // An ad-free request for vid ended in an error. Retry it untouched; if
  // that plays, the method was at fault and is retired.
  function suspect(vid, m, x) {
    if (plainTried.has(vid)) return;
    verify = { vid, m };
    untouched(vid, x);
  }

  // A video with nothing buffered and no picture while the player waits.
  function starving(pl) {
    try {
      if (+pl.getCurrentTime() > 0.5) return false;
      const st = pl.getPlayerStateObject && pl.getPlayerStateObject();
      const nerd = st && st.isBuffering && pl.getStatsForNerds && pl.getStatsForNerds();
      return !!nerd && nerd.buffer_health_seconds === '0.00 s' && nerd.resolution === '0x0';
    } catch { return false; }
  }

  // Makes sure a video really starts. m >= 0: it was asked for ad-free, and
  // trouble retires that method. m < 0: a normal request whose ads were
  // removed; if YouTube then holds the video back or shows its error
  // screen, it is loaded once more untouched.
  function watch(vid, m, x) {
    const token = ++watchToken;
    const t0 = Date.now();
    let starved = 0;
    const tick = () => {
      if (token !== watchToken) return;
      const pl = player();
      let d = null;
      try { d = pl && pl.getVideoData(); } catch { /* not ready */ }
      // The watch page's error screen can come up with the player holding
      // no video at all, so this page's video counts as ours too.
      if (vid === pageVideo() && pageError()) { if (m >= 0) suspect(vid, m, x); else untouched(vid, x); return; }
      if (pl && d && (d.video_id === vid || (!d.video_id && vid === pageVideo()))) {
        const err = pl.querySelector('.ytp-error');
        let status = 'OK';
        try { const r = pl.getPlayerResponse && pl.getPlayerResponse(); status = (r && r.videoDetails && r.videoDetails.videoId === vid && r.playabilityStatus && r.playabilityStatus.status) || 'OK'; } catch { /* ignore */ }
        if ((err && err.offsetWidth > 0) || (status !== 'OK' && !GENUINE.has(status))) { if (m >= 0) suspect(vid, m, x); else untouched(vid, x); return; }
        // Ads arrived anyway. They now also come in the video stream itself
        // (not listed in the player response), so the player is checked too.
        if (m >= 0 && pl.classList.contains('ad-showing') && !stitchedAd(pl)) {
          retire(m, vid);
          if ((reloads.get(vid) || 0) < 2 && method < METHODS.length) { reloads.set(vid, (reloads.get(vid) || 0) + 1); loadAgain(vid, x, false); }
          return;
        }
        try { if (+pl.getCurrentTime() > 0.5) return; } catch { /* ignore */ } // playing
        starved = starving(pl) ? starved + 250 : 0;
        if (starved >= 4000) {
          if (m >= 0) {
            retire(m, vid);
            if ((reloads.get(vid) || 0) < 2 && method < METHODS.length) { reloads.set(vid, (reloads.get(vid) || 0) + 1); loadAgain(vid, x, false); return; }
          }
          untouched(vid, x);
          return;
        }
      } else if (Date.now() - t0 > 4000 && d && d.video_id && d.video_id !== vid) return; // moved on
      if (Date.now() - t0 < 20000) later(tick, 250);
    };
    later(tick, 250);
  }

  // The video this watch page is for.
  function pageVideo() {
    if (location.pathname !== '/watch') return '';
    try { return new URLParams(location.search).get('v') || ''; } catch { return ''; }
  }

  // Only the video being watched may be reloaded or judged. Responses for
  // other videos (the next one, fetched ahead for autoplay) are only
  // cleaned: reloading the player with one of those started it on top of
  // the video playing, so two soundtracks played at once.
  function isCurrent(vid, mk) {
    if (vid === pageVideo()) return true;
    if (prefetched.has(vid)) return false;
    return !!mk; // a navigation's request, sent before the address changes
  }

  // Runs on every player response before pruning.
  function review(x, initial) {
    const vd = x.videoDetails, ps = x.playabilityStatus;
    if (!vd || typeof vd.videoId !== 'string' || !ps || typeof ps !== 'object') return;
    const vid = vd.videoId;
    const mk = marked.get(vid);
    const m = mk && Date.now() - mk.t < 30000 ? mk.m : -1;
    const ads = hasAds(x);
    if (isRaw(vid)) {
      // The untouched retry is back. If it works, the method was at fault.
      if (verify && verify.vid === vid && verify.sent) {
        if (ps.status === 'OK') retire(verify.m, vid);
        verify = null;
      }
      return;
    }
    if (m >= 0) {
      const ac = x.playerConfig && x.playerConfig.audioConfig;
      if (ac && ac.muteOnStart) delete ac.muteOnStart;
      if (ps.status === 'OK' && !ps.miniplayer) ps.miniplayer = { miniplayerRenderer: { playbackMode: 'PLAYBACK_MODE_ALLOW' } };
      if (!isCurrent(vid, mk)) return;
      if (ps.status !== 'OK') {
        if (!GENUINE.has(ps.status)) suspect(vid, m, x);
        return;
      }
      if (ads) {
        // Got ads anyway: removing them makes YouTube hold the video back,
        // so this method no longer helps.
        retire(m, vid);
        if (!reloaded.has(vid) && method < METHODS.length) { reloaded.add(vid); loadAgain(vid, x, false); }
        else untouched(vid, x);
        return;
      }
      watch(vid, m, x);
      return;
    }
    if (!isTop || isRaw(vid) || ps.status !== 'OK' || vd.isLive || vd.isUpcoming || vid !== pageVideo() || prefetched.has(vid)) return;
    if (!ads) return;
    // Ads were scheduled in a response we did not change (a page load, or a
    // navigation): ask again ad-free while a method is left.
    if (adFree && method < METHODS.length && !reloaded.has(vid) && !signedIn()) {
      reloaded.add(vid);
      loadAgain(vid, x, false);
      return;
    }
    // Otherwise the ads are removed; make sure the video still starts.
    watch(vid, -1, x);
  }

  // "Fix this video" from the popup: everything on this page from now on
  // is left as YouTube sends it, and the current video is loaded again.
  if (isTop) {
    try {
      document.addEventListener(channel + 'f', () => {
        allRaw = true;
        const vid = pageVideo();
        if (!vid) return;
        rawTried.add(vid); plainTried.add(vid);
        loadAgain(vid, {}, true);
      }, true);
    } catch { /* ignore */ }
  }

  // YouTube's "network machine" experiments build player requests without
  // JSON.stringify, so the ad-free request above never applies (seen on a
  // signed-in account, 24 November 2026). They are switched off as soon as
  // the page's settings arrive, before the player starts.
  if (adFree && isTop) {
    const FLAGS_OFF = ['all_web_enable_network_machine', 'all_web_network_machine_raw_request'];
    const flags = () => {
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
    };
    flags();
    try {
      const mo = new MutationObserver(flags);
      mo.observe(document, { childList: true, subtree: true });
      const stop = () => { flags(); mo.disconnect(); };
      document.addEventListener('DOMContentLoaded', () => later(stop, 0), { once: true });
      later(stop, 15000);
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------- pruning

  function pruneTarget(o) {
    let hit = false;
    const vd = o.videoDetails;
    // Signed in, YouTube sends the ads inside the stream regardless (seen
    // live: the player calls it SABR), and a schedule removed from the
    // player data only makes it stop with "Something went wrong". So the
    // schedule stays and the ads are skipped.
    const keepAds = signedIn() || (vd && typeof vd.videoId === 'string' ? isRaw(vd.videoId) : allRaw);
    if (!keepAds) {
      for (let i = 0; i < AD_KEYS.length; i++) {
        if (AD_KEYS[i] in o) { delete o[AD_KEYS[i]]; hit = true; }
      }
    }
    // The anti-adblock pop-up ("Ad blockers are not allowed on YouTube")
    // is left exactly as it is: removing it, or only marking it not
    // visible, makes YouTube stop with "Something went wrong" (error
    // 282054944, both seen live on 25 November 2026). The stylesheet and
    // the isolated script hide it on screen.
    return hit;
  }

  function isPlayerResponse(o) {
    return o.videoDetails !== undefined && o.playabilityStatus !== undefined;
  }

  function prune(root, initial) {
    let hit = false;
    if (Array.isArray(root)) {
      // /watch?pbj=1 responses: [{ playerResponse }, { response }]
      for (let i = 0; i < root.length && i < 8; i++) {
        const it = root[i];
        if (it && typeof it === 'object' && !Array.isArray(it)) hit = prune(it, initial) || hit;
      }
      return hit;
    }
    if (isPlayerResponse(root)) review(root, initial);
    if ('adPlacements' in root || 'playerAds' in root || 'adSlots' in root || 'adBreakHeartbeatParams' in root || 'auxiliaryUi' in root) {
      hit = pruneTarget(root) || hit;
    }
    const pr = root.playerResponse;
    if (pr && typeof pr === 'object') {
      if (isPlayerResponse(pr)) review(pr, initial);
      hit = pruneTarget(pr) || hit;
    }
    // Ads engagement panel next to the video (/next and ytInitialData)
    const ep = root.engagementPanels;
    if (Array.isArray(ep)) {
      const kept = ep.filter(p => !(p && p.engagementPanelSectionListRenderer && p.engagementPanelSectionListRenderer.targetId === 'engagement-panel-ads'));
      if (kept.length !== ep.length) { root.engagementPanels = kept; hit = true; }
    }
    // Shorts ads inside the reel sequence
    const entries = root.entries;
    if (Array.isArray(entries) && entries.length && entries[0] && entries[0].command) {
      const kept = entries.filter(e => !(e && e.command && e.command.reelWatchEndpoint && e.command.reelWatchEndpoint.adClientParams && e.command.reelWatchEndpoint.adClientParams.isAd));
      if (kept.length !== entries.length) { root.entries = kept; hit = true; }
    }
    return hit;
  }

  function isCandidate(o) {
    if (o === null || typeof o !== 'object') return false;
    if (Array.isArray(o)) {
      return o.length > 0 && o.length < 8 && o[0] !== null && typeof o[0] === 'object' && ('playerResponse' in o[0] || 'response' in o[0]);
    }
    return o.playerResponse !== undefined || o.adPlacements !== undefined || o.playerAds !== undefined ||
      o.adSlots !== undefined || o.auxiliaryUi !== undefined || o.engagementPanels !== undefined ||
      o.adBreakHeartbeatParams !== undefined || (o.videoDetails !== undefined && o.playabilityStatus !== undefined) ||
      (o.entries !== undefined && Array.isArray(o.entries));
  }

  function inspect(o, initial) {
    if (!isCandidate(o)) return o;
    const t0 = now();
    let hit = false;
    try { hit = prune(o, initial === true); } catch { /* never break the page */ }
    cost += now() - t0;
    samples++;
    if (hit) pruned++;
    if (!timer) timer = later(report, 1500);
    return o;
  }

  // ------------------------------------------------------------ hooks

  // 1. JSON.stringify: player request bodies (ad-free variant)
  if (adFree) {
    try {
      JSON.stringify = new Proxy(JSON.stringify, {
        apply(target, thisArg, args) { editRequest(args[0]); return reflectApply(target, thisArg, args); }
      });
    } catch { /* ignore */ }
  }

  // 2. JSON.parse (XHR bodies, embedded player responses, cached data)
  try {
    JSON.parse = new Proxy(JSON.parse, {
      apply(target, thisArg, args) { return inspect(reflectApply(target, thisArg, args)); }
    });
  } catch { /* ignore */ }

  // 3. fetch(...).json() used by /youtubei/v1/player and /next
  try {
    const proto = Response.prototype;
    proto.json = new Proxy(proto.json, {
      apply(target, thisArg, args) { return reflectApply(target, thisArg, args).then(o => inspect(o)); }
    });
  } catch { /* ignore */ }

  // 4. Inline globals assigned by the watch page HTML:
  //    var ytInitialPlayerResponse = {...}; var ytInitialData = {...};
  for (const name of ['ytInitialPlayerResponse', 'ytInitialData', 'ytInitialReelWatchSequenceResponse']) {
    const initial = name === 'ytInitialPlayerResponse';
    const existing = Object.getOwnPropertyDescriptor(window, name);
    if (existing && !existing.configurable) continue;
    let value = existing && 'value' in existing ? inspect(existing.value, initial) : undefined;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get() { return value; },
        set(v) { value = inspect(v, initial); }
      });
    } catch { /* ignore */ }
  }

  // 5. The player reports "abnormalities" (an ad that was rushed or cut
  //    short) to a listener that stops the video and shows "Something went
  //    wrong". The page registers it inside a promise callback; that
  //    callback is replaced with a no-op, as uBlock Origin's quick fixes do.
  try {
    const then = Promise.prototype.then;
    const noop = function () {};
    Promise.prototype.then = new Proxy(then, {
      apply(target, thisArg, args) {
        const f = args[0];
        if (typeof f === 'function') {
          try { if (fnToString.call(f).indexOf('onAbnormalityDetected') >= 0) args[0] = noop; } catch { /* ignore */ }
        }
        return reflectApply(target, thisArg, args);
      }
    });
  } catch { /* ignore */ }

  // 6. A fixed 17 second anti-adblock wait runs right away (uBlock Origin's
  //    quick fixes do the same).
  try {
    window.setTimeout = new Proxy(window.setTimeout, {
      apply(target, thisArg, args) {
        if (args[1] === 17000 && typeof args[0] === 'function') {
          try { if (fnToString.call(args[0]).indexOf('[native code]') >= 0) args[1] = 17; } catch { /* ignore */ }
        }
        return reflectApply(target, thisArg, args);
      }
    });
  } catch { /* ignore */ }
})();
