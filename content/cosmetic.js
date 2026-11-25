// Cosmetic filtering, page side. ISOLATED world, document_start, all frames.
//
// 1. Asks the service worker for this frame's CSS (injected by the worker
//    at user origin, so the page cannot undo it).
// 2. Reports class/id tokens so lowly generic filters are only applied
//    when something could match (the uBlock Origin / Brave technique).
// 3. Runs procedural filters (:has-text, :upward, ...) when the site has any.
// 4. Answers element counts for the popup and remembers the last
//    right-clicked element for the picker.
// Globals set here live in the extension's isolated world and are never
// visible to the page.
(() => {
  'use strict';
  if (window.__bw) return;
  window.__bw = {};
  if (!/^https?:$/.test(location.protocol)) return;

  // Brave Search opens result links through /go/v1#<token>, a page that
  // decodes the token in the browser. When that page fails it shows
  // "500 Internal Error" and only falls back to the server after 15 s.
  // Go to the server's version (Brave's own fallback) as soon as it fails.
  if (window === window.top && location.hostname === 'search.brave.com' && location.pathname === '/go/v1') {
    const token = location.hash.slice(1);
    if (/^[\w-]{40,}$/.test(token)) {
      const t0 = Date.now();
      const check = () => {
        if (location.pathname !== '/go/v1') return;
        const text = document.body ? document.body.innerText || document.body.textContent || '' : '';
        if (/^\s*500\b/.test(text) || /Internal Error/i.test(document.title + ' ' + text.slice(0, 200))) {
          // Like Brave's page: no "Check this link" step for a link that
          // came from a search made in this browser.
          let seen = false;
          try {
            const b = Uint8Array.from(atob(token.slice(0, 40).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
            const nonce = Array.from(b.subarray(1, 9), x => x.toString(16).padStart(2, '0')).join('');
            const iat = new DataView(b.buffer, 9, 4).getUint32(0);
            const list = JSON.parse(localStorage.getItem('app.urlCloakSeenNonces') || '[]');
            seen = b[0] === 1 && Date.now() / 1000 - iat <= 7 * 86400 && Array.isArray(list) && list.includes(nonce);
          } catch { /* ask */ }
          location.replace('/go/v1/' + token + '?' + (seen ? '' : 'confirm&') + 'r=1');
          return;
        }
        if (Date.now() - t0 < 15000) setTimeout(check, 200);
      };
      setTimeout(check, 200);
    }
  }

  let procedural = [];
  let generic = false;
  const sentTokens = new Set();
  let pending = new Set();
  let tokenTimer = 0;
  let on = true;

  const send = (msg) => {
    try { return chrome.runtime.sendMessage(msg); } catch { return Promise.resolve(null); }
  };

  // Private channel to the cookie guard (MAIN world). The guard announces a
  // random event name through a temporary attribute that is removed here
  // before any page script can run, so the page can neither see nor spoof
  // the channel.
  let ck = 0, ckTimer = 0;
  const onCk = (e) => {
    ck += parseInt(e.detail, 10) || 0;
    if (!ckTimer) ckTimer = setTimeout(() => { ckTimer = 0; send({ t: 'ck-stats', n: ck }); ck = 0; }, 1500);
  };
  claimChannel('data-bwc', (name) => document.addEventListener(name, onCk, true));

  // Picker support: remember the element under the last right click.
  document.addEventListener('contextmenu', (e) => { window.__bw.ctx = e.target; }, true);

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.t === 'count') { reply({ count: countHidden(Array.isArray(msg.sels) ? msg.sels : []) }); }
    return false;
  });

  send({ t: 'frame-init', url: location.href }).then((res) => {
    if (!res || !res.on) { on = false; return; }
    procedural = res.proc || [];
    generic = !!res.generic;
    if (generic || procedural.length) whenReady(start);
  }).catch(() => {});

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function start() {
    if (generic) { collect(document.documentElement); flushTokens(); }
    if (procedural.length) runProcedural();
    let procTimer = 0;
    const mo = new MutationObserver((records) => {
      if (generic) {
        for (const r of records) {
          for (const n of r.addedNodes) if (n.nodeType === 1) collect(n);
          if (r.type === 'attributes' && r.target.nodeType === 1) addTokens(r.target);
        }
        if (pending.size && !tokenTimer) tokenTimer = setTimeout(flushTokens, 120);
      }
      if (procedural.length && !procTimer) procTimer = setTimeout(() => { procTimer = 0; runProcedural(); }, 200);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: generic, attributeFilter: generic ? ['class', 'id'] : undefined });
  }

  function addTokens(el) {
    const id = el.id;
    if (id && typeof id === 'string') { const t = '#' + id; if (!sentTokens.has(t)) pending.add(t); }
    const cl = el.classList;
    if (cl) for (let i = 0; i < cl.length; i++) { const t = '.' + cl[i]; if (!sentTokens.has(t)) pending.add(t); }
  }

  function collect(root) {
    addTokens(root);
    if (!root.querySelectorAll) return;
    const nodes = root.querySelectorAll('[id],[class]');
    const max = Math.min(nodes.length, 4000);
    for (let i = 0; i < max; i++) addTokens(nodes[i]);
  }

  function flushTokens() {
    tokenTimer = 0;
    if (!pending.size || !on) return;
    const tokens = [...pending];
    pending = new Set();
    for (const t of tokens) sentTokens.add(t);
    for (let i = 0; i < tokens.length; i += 1500) {
      send({ t: 'tokens', url: location.href, tokens: tokens.slice(i, i + 1500) }).catch(() => {});
    }
  }

  // ------------------------------------------------------------- counting
  function countHidden(applied) {
    const seen = new Set();
    for (const sel of applied) {
      let list;
      try { list = document.querySelectorAll(sel); } catch { continue; }
      for (const el of list) seen.add(el);
    }
    return seen.size + procHidden.size;
  }

  // ----------------------------------------------------------- procedural
  const procHidden = new Set();
  const toRe = (s) => {
    const m = /^\/(.+)\/([imsu]*)$/.exec(s);
    if (m) { try { return new RegExp(m[1], m[2]); } catch { return null; } }
    return null;
  };

  function step(nodes, [op, arg]) {
    const out = [];
    switch (op) {
      case 'has-text': {
        const re = toRe(arg);
        for (const n of nodes) {
          const t = n.textContent || '';
          if (re ? re.test(t) : t.includes(arg)) out.push(n);
        }
        return out;
      }
      case 'min-text-length': {
        const min = parseInt(arg, 10) || 0;
        for (const n of nodes) if ((n.textContent || '').length >= min) out.push(n);
        return out;
      }
      case 'upward': {
        const n2 = parseInt(arg, 10);
        for (const n of nodes) {
          let p = n;
          if (!Number.isNaN(n2) && String(n2) === arg.trim()) {
            for (let i = 0; i < n2 && p; i++) p = p.parentElement;
          } else {
            try { p = n.parentElement && n.parentElement.closest(arg); } catch { p = null; }
          }
          if (p && p !== document.documentElement && p !== document.body) out.push(p);
        }
        return out;
      }
      case 'matches-css': {
        // "::before|prop: value" checks a pseudo-element.
        let pseudo = null, a = arg;
        const bar = /^(::before|::after)\|/.exec(a);
        if (bar) { pseudo = bar[1]; a = a.slice(bar[0].length); }
        const i = a.indexOf(':');
        if (i < 0) return out;
        const prop = a.slice(0, i).trim(), val = a.slice(i + 1).trim();
        const re = toRe(val);
        for (const n of nodes) {
          const v = getComputedStyle(n, pseudo).getPropertyValue(prop);
          if (re ? re.test(v) : v === val) out.push(n);
        }
        return out;
      }
      case 'matches-attr': {
        const m = /^("?)(.+?)\1(?:=("?)(.*)\3)?$/.exec(arg);
        if (!m) return out;
        const nameRe = toRe(m[2]), valRe = m[4] !== undefined ? toRe(m[4]) : null;
        for (const n of nodes) {
          for (const a of n.attributes) {
            const nameOk = nameRe ? nameRe.test(a.name) : a.name === m[2];
            if (!nameOk) continue;
            if (m[4] === undefined || (valRe ? valRe.test(a.value) : a.value === m[4])) { out.push(n); break; }
          }
        }
        return out;
      }
      case 'matches-path': {
        const re = toRe(arg);
        const path = location.pathname + location.search;
        return (re ? re.test(path) : path.includes(arg)) ? nodes : [];
      }
      case 'xpath': {
        for (const n of nodes) {
          let r;
          try { r = document.evaluate(arg, n, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); } catch { continue; }
          for (let i = 0; i < r.snapshotLength; i++) { const x = r.snapshotItem(i); if (x.nodeType === 1) out.push(x); }
        }
        return out;
      }
      case 'watch-attr': return nodes;
      case 'has': {
        // Keep nodes with a descendant matching a nested procedural filter.
        for (const n of nodes) if (select(arg, n).length) out.push(n);
        return out;
      }
      case 'spath': {
        const sel = arg.trim();
        for (const n of nodes) {
          if (/^[+~]/.test(sel)) {
            const rest = sel.slice(1).trim();
            let sib = n.nextElementSibling;
            while (sib) {
              try { if (sib.matches(rest)) out.push(sib); } catch { return out; }
              if (sel[0] === '+') break;
              sib = sib.nextElementSibling;
            }
          } else {
            try { out.push(...n.querySelectorAll(':scope ' + sel)); } catch { return out; }
          }
        }
        return out;
      }
      default: return out;
    }
  }

  // Runs one filter's selector and steps; `root` scopes nested (:has) ones.
  function select(f, root) {
    let nodes;
    try {
      if (root) nodes = f.s ? [...root.querySelectorAll(':scope ' + f.s)] : [root];
      else nodes = f.s ? [...document.querySelectorAll(f.s)] : [document.documentElement];
    } catch { return []; }
    for (const st of f.t) { if (!nodes.length) break; nodes = step(nodes, st); }
    return nodes;
  }

  const nameMatcher = (arg) => {
    const re = toRe(arg);
    return re ? (x) => re.test(x) : (x) => x === arg;
  };

  function runProcedural() {
    for (const f of procedural) {
      const nodes = select(f, null);
      if (Array.isArray(f.a) && (f.a[0] === 'remove-attr' || f.a[0] === 'remove-class')) {
        // Re-applied on every run: pages put these back.
        const m = nameMatcher(f.a[1]);
        for (const n of nodes) {
          if (f.a[0] === 'remove-attr') { for (const a of [...n.attributes]) if (m(a.name)) n.removeAttribute(a.name); }
          else for (const c of [...n.classList]) if (m(c)) n.classList.remove(c);
        }
        continue;
      }
      for (const n of nodes) {
        if (procHidden.has(n)) continue;
        if (f.a === 'remove') { n.remove(); procHidden.add(n); continue; }
        if (Array.isArray(f.a) && f.a[0] === 'style') {
          for (const decl of f.a[1].split(';')) {
            const i = decl.indexOf(':');
            if (i > 0) n.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).replace(/!important/, '').trim(), 'important');
          }
        } else {
          n.style.setProperty('display', 'none', 'important');
        }
        procHidden.add(n);
      }
    }
  }

  // Shared with youtube-iso.js: take a channel name from a MAIN-world
  // script, whichever of the two scripts runs first.
  function claimChannel(attr, use) {
    const de = document.documentElement;
    if (!de) return;
    const take = () => {
      const name = de.getAttribute(attr);
      if (!name) return false;
      de.removeAttribute(attr);
      use(name);
      return true;
    };
    if (take()) return;
    const mo = new MutationObserver(() => { if (take()) mo.disconnect(); });
    mo.observe(de, { attributes: true, attributeFilter: [attr] });
  }
})();
