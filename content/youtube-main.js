// YouTube ad layer. MAIN world, document_start, every YouTube frame.
//
// 1. Ad-free playback requests (youtube.com watch pages). When YouTube
//    schedules ads for a video, its streaming server holds back the first
//    video data for about 80% of the ads' length ("fake buffering"). Removing
//    the ads in the browser cannot undo that: the video sits on a spinner
//    with no ad. So Bulwark asks for the ad-free variant of each video
//    instead. The player request takes a `params` blob (base64 protobuf);
//    field 15 = 1 requests the channel-page autoplay variant, which YouTube
//    serves without ads and therefore without the wait. Page loads get the
//    same through a `pp` parameter that a network rule sets on watch URLs.
//    That variant starts muted and hides the miniplayer button, so both are
//    put back. If YouTube still sends ads, or refuses the variant, Bulwark
//    falls back to the next method and reloads the video once.
//
// 2. Ad payload pruning (everywhere). adPlacements, adSlots and playerAds
//    are removed from player responses before the player reads them, from
//    JSON.parse, Response.json and the inline ytInitialPlayerResponse.
//
// 3. Anti-adblock hooks: the "abnormality" listener that swaps the video for
//    an enforcement screen is never registered, and a fixed 17 s penalty
//    timer runs immediately.
//
// Hot path cost: a typeof check per JSON.stringify/parse call, a shape
// check on objects, one toString per promise callback.
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
  const atob_ = window.atob.bind(window), btoa_ = window.btoa.bind(window);
  const dURI = decodeURIComponent, eURI = encodeURIComponent;
  const URLParams = URLSearchParams;
  const now = performance.now.bind(performance);
  let pruned = 0, cost = 0, samples = 0, timer = 0;

  // Stats go to the isolated content script over a private channel: a
  // random event name passed through an attribute that the content script
  // removes before any page script runs.
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

  // Settings arrive the same way: content/youtube-flag.js, registered in
  // front of this file, sets data-bwf="1" when ad-free requests are on.
  let adFree = false;
  try {
    const f = root.getAttribute('data-bwf');
    if (f !== null) { root.removeAttribute('data-bwf'); adFree = f === '1'; }
  } catch { /* ignore */ }
  const host = location.hostname;
  const startSearch = location.search; // YouTube tidies the URL later
  adFree = adFree && window.top === window && (host === 'www.youtube.com' || host === 'youtube.com');

  // ------------------------------------------------- ad-free playback

  const NO_ADS = '\x78\x01'; // protobuf: field 15, varint 1
  const URL_PARAM = 'eAE='; // the same, alone, as the network rule adds it

  function withNoAds(p) {
    let raw = '', urlSafe = false;
    if (typeof p === 'string' && p) {
      let s = p;
      try { s = dURI(p); } catch { /* keep as is */ }
      urlSafe = /[-_]/.test(s);
      s = s.replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      try { raw = atob_(s); } catch { return null; }
      if (raw.slice(-2) === NO_ADS) return p;
    } else if (p !== undefined && p !== null && p !== '') return null;
    let out = btoa_(raw + NO_ADS);
    if (urlSafe) out = out.replace(/\+/g, '-').replace(/\//g, '_');
    return eURI(out);
  }

  // Methods, best first. Each returns false when it cannot apply.
  const METHODS = [
    (pr) => {
      const p = withNoAds(pr.params);
      if (p === null) return false;
      pr.params = p;
      return true;
    },
    (pr) => {
      const pc = pr.playbackContext;
      const c = pc.contentPlaybackContext && typeof pc.contentPlaybackContext === 'object' ? pc.contentPlaybackContext : (pc.contentPlaybackContext = {});
      c.isInlinePlaybackNoAd = true;
      return true;
    }
  ];
  let method = 0;
  const marked = new Map(); // videoId -> { m: method, t: time }
  const reloaded = new Set();
  let bypass = null; // { vid, until }: next request for vid goes out unchanged

  function wantsAdFree(o, pr) {
    const path = location.pathname;
    if (path.startsWith('/shorts') || path.startsWith('/embed') || path.startsWith('/live_chat')) return false;
    const ctx = o.context || pr.context;
    const client = ctx && ctx.client;
    if (!client || (client.clientName && client.clientName !== 'WEB')) return false;
    const graft = (client.mainAppWebInfo && client.mainAppWebInfo.graftUrl) || '';
    if (graft.indexOf('/shorts/') >= 0) return false;
    if (o !== pr) return true; // get_watch: a navigation to a watch page
    return path === '/watch' || graft.indexOf('/watch') === 0 || graft.indexOf('youtube.com/watch') >= 0;
  }

  function editRequest(o) {
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return;
    const pr = o.playerRequest !== null && typeof o.playerRequest === 'object' ? o.playerRequest : o;
    const vid = pr.videoId;
    if (typeof vid !== 'string' || pr.playbackContext === null || typeof pr.playbackContext !== 'object') return;
    if (bypass && bypass.vid === vid && Date.now() < bypass.until) return;
    if (method >= METHODS.length || !wantsAdFree(o, pr)) return;
    try {
      for (let m = method; m < METHODS.length; m++) {
        if (METHODS[m](pr)) { marked.set(vid, { m, t: Date.now() }); return; }
      }
    } catch { /* never break the request */ }
  }

  const hasAds = (x) => AD_KEYS.slice(0, 3).some(k => Array.isArray(x[k]) ? x[k].length > 0 : x[k] !== undefined);

  function fromAdFreeUrl() {
    try { return new URLParams(startSearch).get('pp') === URL_PARAM; } catch { return false; }
  }

  function retire(m) { if (method === m) method++; }

  // Loads the video again once the player has it, which sends a fresh
  // player request (ad-free, or unchanged when `plain`).
  function reload(vid, x, plain) {
    if (reloaded.has(vid) || (!plain && method >= METHODS.length)) return;
    reloaded.add(vid);
    const sc = x.playerConfig && x.playerConfig.playbackStartConfig;
    const start = (sc && +sc.startSeconds) || 0;
    const t0 = Date.now();
    const tick = () => {
      const pl = document.getElementById('movie_player');
      let d = null;
      try { d = pl && typeof pl.getVideoData === 'function' ? pl.getVideoData() : null; } catch { /* not ready */ }
      if (d && d.video_id === vid && typeof pl.loadVideoById === 'function') {
        let at = start;
        try { at = Math.max(start, +pl.getCurrentTime() || 0); } catch { /* ignore */ }
        if (plain) bypass = { vid, until: Date.now() + 5000 };
        try { pl.loadVideoById({ videoId: vid, startSeconds: at }); } catch { /* ignore */ }
        return;
      }
      if (Date.now() - t0 < 15000) later(tick, 50);
    };
    later(tick, 0);
  }

  // Runs on every player response before pruning.
  function review(x, initial) {
    const vd = x.videoDetails, ps = x.playabilityStatus;
    if (!vd || typeof vd.videoId !== 'string' || !ps || typeof ps !== 'object') return;
    const vid = vd.videoId;
    const mk = marked.get(vid);
    const ours = (mk && Date.now() - mk.t < 30000) || (initial && fromAdFreeUrl());
    const ads = hasAds(x);
    if (ours) {
      const ac = x.playerConfig && x.playerConfig.audioConfig;
      if (ac && ac.muteOnStart) delete ac.muteOnStart;
      if (ps.status === 'OK' && !ps.miniplayer) ps.miniplayer = { miniplayerRenderer: { playbackMode: 'PLAYBACK_MODE_ALLOW' } };
      if (ps.status !== 'OK') {
        // Refused with YouTube's "content isn't available" screen: this
        // method stopped working. Play the video normally instead.
        let refused = false;
        try { refused = JSON.stringify(ps.errorScreen || '').indexOf('3037019') >= 0; } catch { /* ignore */ }
        if (refused) { retire(mk ? mk.m : 0); reload(vid, x, true); }
        return;
      }
      if (ads) { retire(mk ? mk.m : 0); reload(vid, x, false); }
      return;
    }
    // Ads were scheduled in a response we did not ask for (the network
    // rule was off or missed this load): ask again, ad-free.
    if (ads && adFree && ps.status === 'OK' && !vd.isLive && !vd.isUpcoming && location.pathname === '/watch') reload(vid, x, false);
  }

  // ---------------------------------------------------------- pruning

  function pruneTarget(o) {
    let hit = false;
    for (let i = 0; i < AD_KEYS.length; i++) {
      if (AD_KEYS[i] in o) { delete o[AD_KEYS[i]]; hit = true; }
    }
    // Anti-adblock enforcement dialog payload
    const mr = o.auxiliaryUi && o.auxiliaryUi.messageRenderers;
    if (mr && typeof mr === 'object') {
      for (const k of Object.keys(mr)) {
        if (/enforcement/i.test(k)) { delete mr[k]; hit = true; }
      }
    }
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

  // 5. The player reports "abnormalities" (ad bytes missing, skip button
  //    integrity) to a listener that stops the video and shows the
  //    anti-adblock screen. The page registers it inside a promise
  //    callback; that callback is replaced with a no-op.
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

  // 6. A fixed 17 second anti-adblock wait runs right away.
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
