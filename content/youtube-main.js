// YouTube ad payload pruner. MAIN world, document_start, every YouTube frame.
//
// YouTube delivers its ad schedule inside the player response
// (adPlacements, adSlots, playerAds), both inline in the watch page HTML
// and through /youtubei/v1/player. Removing those keys before the player
// reads them means no ad is ever scheduled: no pre-roll, no mid-roll, no
// ad request, and the video starts as soon as content is buffered.
//
// Hot path cost: one cheap shape check per JSON.parse / Response.json call.
// Pruning only runs on objects that look like player responses.
//
// Nothing is left on window for the page to find: no globals, no symbols,
// and the hooks report themselves as native code. Running twice is
// harmless because pruning is idempotent.
(() => {
  'use strict';
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];
  const reflectApply = Reflect.apply;
  const now = performance.now.bind(performance);
  let pruned = 0, cost = 0, samples = 0, timer = 0;

  // Stats go to the isolated content script over a private channel: a
  // random event name passed through an attribute that the content script
  // removes before any page script runs.
  const dispatch = EventTarget.prototype.dispatchEvent;
  const CE = CustomEvent;
  const channel = 'x' + Math.random().toString(36).slice(2);
  try { document.documentElement.setAttribute('data-bwy', channel); } catch { /* no root yet */ }
  const report = () => {
    timer = 0;
    try {
      dispatch.call(document, new CE(channel, { detail: pruned + ',' + Math.round(cost * 1000) + ',' + samples }));
    } catch { /* ignore */ }
    pruned = 0; cost = 0; samples = 0;
  };

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

  function prune(root) {
    let hit = false;
    if (Array.isArray(root)) {
      // /watch?pbj=1 responses: [{ playerResponse }, { response }]
      for (let i = 0; i < root.length && i < 8; i++) {
        const it = root[i];
        if (it && typeof it === 'object' && !Array.isArray(it)) hit = prune(it) || hit;
      }
      return hit;
    }
    if ('adPlacements' in root || 'playerAds' in root || 'adSlots' in root || 'adBreakHeartbeatParams' in root || 'auxiliaryUi' in root) {
      hit = pruneTarget(root) || hit;
    }
    const pr = root.playerResponse;
    if (pr && typeof pr === 'object') hit = pruneTarget(pr) || hit;
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
      o.adBreakHeartbeatParams !== undefined || (o.entries !== undefined && Array.isArray(o.entries));
  }

  function inspect(o) {
    if (!isCandidate(o)) return o;
    const t0 = now();
    let hit = false;
    try { hit = prune(o); } catch { /* never break the page */ }
    cost += now() - t0;
    samples++;
    if (hit) pruned++;
    if (!timer) timer = setTimeout(report, 1500);
    return o;
  }

  // 1. JSON.parse (XHR bodies, embedded player responses, cached data)
  try {
    JSON.parse = new Proxy(JSON.parse, {
      apply(target, thisArg, args) { return inspect(reflectApply(target, thisArg, args)); }
    });
  } catch { /* ignore */ }

  // 2. fetch(...).json() used by /youtubei/v1/player and /next
  try {
    const proto = Response.prototype;
    proto.json = new Proxy(proto.json, {
      apply(target, thisArg, args) { return reflectApply(target, thisArg, args).then(inspect); }
    });
  } catch { /* ignore */ }

  // 3. Inline globals assigned by the watch page HTML:
  //    var ytInitialPlayerResponse = {...}; var ytInitialData = {...};
  for (const name of ['ytInitialPlayerResponse', 'ytInitialData', 'ytInitialReelWatchSequenceResponse']) {
    const existing = Object.getOwnPropertyDescriptor(window, name);
    if (existing && !existing.configurable) continue;
    let value = existing && 'value' in existing ? inspect(existing.value) : undefined;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get() { return value; },
        set(v) { value = inspect(v); }
      });
    } catch { /* ignore */ }
  }
})();
