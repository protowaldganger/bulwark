// YouTube fallback layer. ISOLATED world, document_start, every YouTube frame.
//
// The MAIN-world pruner stops ads from being scheduled. This layer handles
// whatever still gets through (server-side inserted ads, new payload
// shapes, experiments): it detects the player's ad state and skips it,
// removes the anti-adblock dialog, and auto-skips SponsorBlock segments.
// It also relays stats from the MAIN world to the service worker.
//
// Cost model: one attribute observer per player (fires only when the
// player's class changes) plus a 1 s tick that touches live collections
// only, and pauses while the tab is hidden.
(() => {
  'use strict';
  if (window.__bwYt) return;
  window.__bwYt = true;

  const cfg = { skipper: true, sponsorblock: false, strict: true, sbCategories: ['sponsor'], sbToast: true };
  const counters = { skipped: 0, sb: 0, pruned: 0, cost: 0, samples: 0 };
  let flushTimer = 0;
  const flush = () => {
    flushTimer = 0;
    if (!counters.skipped && !counters.sb && !counters.samples) return;
    const msg = { t: 'yt-stats', ...counters };
    counters.skipped = counters.sb = counters.pruned = counters.cost = counters.samples = 0;
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch { /* extension reloaded */ }
  };
  const bump = () => { if (!flushTimer) flushTimer = setTimeout(flush, 2000); };

  // Private channel from the MAIN-world pruner (see youtube-main.js).
  const onStats = (e) => {
    const d = String(e.detail);
    // "m<N>": the page found that ad-free method N-1 fails; new pages
    // should start at method N (see background/ytadfree.js).
    if (d.charAt(0) === 'm') {
      const m = parseInt(d.slice(1), 10);
      if (m > 0 && m < 10) { try { chrome.runtime.sendMessage({ t: 'yt-adfree-method', m }).catch(() => {}); } catch { /* extension reloaded */ } }
      return;
    }
    const [p, c, n] = d.split(',').map(x => parseInt(x, 10) || 0);
    counters.pruned += p; counters.cost += c; counters.samples += n;
    bump();
  };
  let mainChannel = '';
  (() => {
    const de = document.documentElement;
    if (!de) return;
    const take = () => {
      const name = de.getAttribute('data-bwy');
      if (!name) return false;
      de.removeAttribute('data-bwy');
      mainChannel = name;
      document.addEventListener(name, onStats, true);
      return true;
    };
    if (take()) return;
    const mo = new MutationObserver(() => { if (take()) mo.disconnect(); });
    mo.observe(de, { attributes: true, attributeFilter: ['data-bwy'] });
  })();

  const applySettings = (s) => {
    if (!s) return;
    if (s.youtube) Object.assign(cfg, s.youtube);
    cfg.strict = !s.privacy || s.privacy.strict !== false;
  };
  try {
    chrome.storage.local.get('settings').then(({ settings }) => applySettings(settings)).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.settings && ch.settings.newValue) { applySettings(ch.settings.newValue); segmentsFor = ''; lastHref = ''; }
    });
  } catch { /* ignore */ }
  const sbOn = () => cfg.sponsorblock && !cfg.strict;
  // In Brave, Shields handles YouTube video ads; rushing an ad on top of
  // that ends in "Something went wrong", so the skipper stays out of it.
  const brave = (() => {
    try {
      if (navigator.brave) return true;
      const b = navigator.userAgentData && navigator.userAgentData.brands;
      return Array.isArray(b) && b.some(x => /brave/i.test(x && x.brand));
    } catch { return false; }
  })();

  // ------------------------------------------------------------ ad skipper
  const players = document.getElementsByClassName('html5-video-player');
  const dialogs = document.getElementsByTagName('ytd-enforcement-message-view-model');
  const watched = new WeakSet();
  const saved = new WeakMap(); // video -> { muted, rate }
  const SKIP_SEL = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot button, button[id^="skip-button"]';

  function isAdShowing(p) {
    const c = p.classList;
    return c.contains('ad-showing') || c.contains('ad-interrupting');
  }

  function handlePlayer(p) {
    if (!cfg.skipper || brave) return;
    const video = p.querySelector('video');
    if (!video) return;
    if (isAdShowing(p)) {
      if (!saved.has(video)) {
        saved.set(video, { muted: video.muted, rate: video.playbackRate || 1 });
        counters.skipped++; bump();
      }
      const btn = p.querySelector(SKIP_SEL);
      if (btn) { try { btn.click(); } catch { /* ignore */ } }
      if (!video.muted) video.muted = true;
      try { if (video.playbackRate !== 16) video.playbackRate = 16; } catch { /* ignore */ }
      // No jumping inside the ad: YouTube now treats a jump as tampering
      // and stops with "Something went wrong" (error 282054944, seen live on
      // 24 November 2026). Playing it muted at 16x takes a second or two.
    } else if (saved.has(video)) {
      const s = saved.get(video);
      saved.delete(video);
      try { video.playbackRate = s.rate; } catch { /* ignore */ }
      video.muted = s.muted;
    }
  }

  function attach(p) {
    if (watched.has(p)) return;
    watched.add(p);
    new MutationObserver(() => handlePlayer(p)).observe(p, { attributes: true, attributeFilter: ['class'] });
    handlePlayer(p);
    const v = p.querySelector('video');
    if (v) {
      v.addEventListener('timeupdate', onTime, { passive: true });
      v.addEventListener('playing', () => refocus(p), { passive: true });
    }
  }

  // Keyboard shortcuts (space, k, arrows) only work while the player or
  // the page has focus. If focus sits on nothing visible (a pop-up that is
  // hidden, or was removed, still holding it), keys go nowhere until the
  // player is clicked. When a video starts, focus goes back to the player,
  // as YouTube does itself on a normal page load. Never taken from
  // anything visible, such as the search box or a comment field.
  function refocus(p) {
    if (p.id !== 'movie_player' || location.pathname !== '/watch' || !document.hasFocus()) return;
    const a = document.activeElement;
    if (a && a !== document.body && a !== document.documentElement && a.getClientRects().length) return;
    try { p.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  // ------------------------------------------------- anti-adblock dialog
  function clearEnforcement() {
    const msg = dialogs[0];
    const dialog = msg.closest('tp-yt-paper-dialog');
    (dialog || msg).remove();
    for (const b of document.querySelectorAll('tp-yt-iron-overlay-backdrop')) b.remove();
    if (document.body) document.body.style.removeProperty('overflow');
    const v = document.querySelector('#movie_player video');
    if (v && v.paused) v.play().catch(() => {});
  }

  // --------------------------------------------------------- SponsorBlock
  let segmentsFor = '', segments = [], skippedSeg = new Set(), lastHref = '';

  function currentVideoId() {
    const u = location;
    if (u.pathname === '/watch') return new URLSearchParams(u.search).get('v') || '';
    const m = /^\/(?:shorts|embed|live)\/([\w-]{11})/.exec(u.pathname);
    return m ? m[1] : '';
  }

  function refreshSegments() {
    if (!sbOn()) { segments = []; return; }
    const id = currentVideoId();
    if (!id || id === segmentsFor) return;
    segmentsFor = id; segments = []; skippedSeg = new Set();
    try {
      chrome.runtime.sendMessage({ t: 'sb-segments', id, categories: cfg.sbCategories }).then(res => {
        if (segmentsFor === id && res && Array.isArray(res.segments)) segments = res.segments;
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  function onTime(ev) {
    if (!segments.length) return;
    const v = ev.target;
    const p = v.closest('.html5-video-player');
    if (p && isAdShowing(p)) return;
    const t = v.currentTime;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (t >= s.start && t < s.end - 0.3 && !skippedSeg.has(i)) {
        skippedSeg.add(i);
        v.currentTime = s.end;
        counters.sb++; bump();
        if (cfg.sbToast && p) toast(p, s, v);
        return;
      }
    }
  }

  function toast(player, seg, video) {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:12px;bottom:64px;z-index:70;pointer-events:auto';
    const root = host.attachShadow({ mode: 'closed' });
    const label = seg.category === 'sponsor' ? 'sponsor' : String(seg.category).replace(/_/g, ' ');
    root.innerHTML = `<style>
      div{font:500 13px/1.2 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",system-ui,sans-serif;color:#171717;
        background:rgba(255,255,255,.94);border-radius:999px;padding:8px 8px 8px 14px;display:flex;gap:10px;align-items:center;
        box-shadow:0 10px 24px rgba(0,0,0,.18);animation:in .25s cubic-bezier(.22,1,.36,1)}
      button{all:unset;cursor:pointer;background:#171717;color:#fff;border-radius:999px;padding:4px 10px;font-weight:500}
      @keyframes in{from{opacity:0;transform:translateY(6px)}}
    </style><div>Skipped ${label} <button type="button">Undo</button></div>`;
    root.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      video.currentTime = seg.start;
      host.remove();
    });
    player.appendChild(host);
    setTimeout(() => host.remove(), 4000);
  }

  // ------------------------------------------------- "Fix this video"
  // From the popup: the MAIN-world script leaves this page alone from now
  // on and loads the video again. Answers false when it is not there, so
  // the service worker reloads the tab instead.
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.t !== 'yt-fix' || window.top !== window) return false;
      if (!mainChannel) { sendResponse({ ok: false }); return false; }
      try { document.dispatchEvent(new CustomEvent(mainChannel + 'f')); } catch { /* ignore */ }
      sendResponse({ ok: true, video: location.pathname === '/watch' });
      return false;
    });
  } catch { /* ignore */ }

  // ------------------------------------- "Experiencing interruptions?"
  // YouTube moved this notice from a toast to a snackbar (late 2026), so the
  // stylesheet rule no longer catches it. Matched by its text, so other
  // notices ("Saved to Watch later") stay.
  const INTERRUPTIONS = /experiencing interruptions\?|upplever du störningar\?/i;
  const snackbars = document.getElementsByTagName('snackbar-view-model');
  function hideInterruptions() {
    for (let i = 0; i < snackbars.length; i++) {
      const el = snackbars[i];
      if (el.style.display !== 'none' && INTERRUPTIONS.test(el.textContent || '')) el.style.setProperty('display', 'none', 'important');
    }
  }

  // ------------------------------------------------ cookie consent prompt
  // "Before you continue to YouTube" comes back on every visit when the
  // answer is not stored. Bulwark answers it the way you would: Reject all.
  // Only a button whose label is exactly "Reject all" (in a few languages)
  // is ever clicked, at most once a minute per tab (the service worker
  // keeps count), so a page that reloads after the answer cannot loop.
  const REJECT = /^(reject all|avvisa alla|alle ablehnen|tout refuser|rechazar todo|rifiuta tutto|alles afwijzen|afvis alle|avvis alle|hylkää kaikki|odrzuć wszystko|rejeitar tudo)$/i;
  let consentDone = false;
  function answerConsent() {
    if (consentDone || window.top !== window) return;
    const scope = location.hostname === 'consent.youtube.com' ? document : document.querySelector('ytd-consent-bump-v2-lightbox, tp-yt-paper-dialog:has(ytd-consent-bump-v2-lightbox)');
    if (!scope) return;
    let target = null;
    for (const b of scope.querySelectorAll('button, [role="button"]')) {
      const text = (b.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = (b.getAttribute('aria-label') || '').trim();
      if ((REJECT.test(text) || REJECT.test(aria)) && b.getClientRects().length) { target = b; break; }
    }
    if (!target) return;
    consentDone = true;
    try {
      chrome.runtime.sendMessage({ t: 'yt-consent' }).then((r) => { if (r && r.ok) target.click(); }).catch(() => {});
    } catch { /* extension reloaded */ }
  }

  // ------------------------------------------------------------- driver
  let seen = 0;
  function tick() {
    if (players.length !== seen) {
      seen = players.length;
      for (let i = 0; i < players.length; i++) attach(players[i]);
    }
    // Ads arrive at playing speed, so keep moving through one as it loads.
    for (let i = 0; i < players.length; i++) if (isAdShowing(players[i])) handlePlayer(players[i]);
    if (dialogs.length) clearEnforcement();
    if (snackbars.length) hideInterruptions();
    if (!consentDone) answerConsent();
    if (location.href !== lastHref) { lastHref = location.href; refreshSegments(); }
  }

  let timer = 0;
  const start = () => { if (!timer) timer = setInterval(tick, 1000); tick(); };
  const stop = () => { clearInterval(timer); timer = 0; };
  document.addEventListener('yt-navigate-finish', tick);
  document.addEventListener('yt-player-updated', () => { seen = -1; tick(); });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  document.addEventListener('DOMContentLoaded', start, { once: true });
})();
