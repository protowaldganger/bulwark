// Scriptlet runtime. `bulwarkScriptlets` is fully self-contained: the build
// tool serializes it into per-list content scripts (document_start, MAIN
// world) and the service worker passes it to scripting.executeScript for
// scriptlets that arrived with a list update. Do not reference anything
// outside the function body.

export function bulwarkScriptlets(entries) {
  'use strict';
  if (!Array.isArray(entries) || entries.length === 0) return;
  const win = window;
  const MAGIC = String.fromCharCode(Math.random() * 26 + 97) + Math.random().toString(36).slice(2);
  const native = {
    defineProperty: Object.defineProperty,
    getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    apply: Reflect.apply
  };

  const toRe = (p, def) => {
    if (p === undefined || p === '') return def === undefined ? /^/ : def;
    const m = /^\/(.+)\/([dgimsuy]*)$/.exec(p);
    if (m) { try { return new RegExp(m[1], m[2]); } catch { return /[^\s\S]/; } }
    return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  };
  const needleMatcher = (raw) => {
    let neg = false;
    if (typeof raw === 'string' && raw.startsWith('!')) { neg = true; raw = raw.slice(1); }
    const re = toRe(raw);
    return s => re.test(s) !== neg;
  };
  const delayMatcher = (raw) => {
    if (raw === undefined || raw === '') return () => true;
    let neg = false;
    if (raw.startsWith('!')) { neg = true; raw = raw.slice(1); }
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return () => true;
    return d => ((d | 0) === n) !== neg;
  };
  const proxyApply = (owner, prop, handler) => {
    const fn = owner && owner[prop];
    if (typeof fn !== 'function') return;
    try { owner[prop] = new Proxy(fn, { apply: handler }); } catch { /* frozen */ }
  };
  const parseValue = (raw, trusted) => {
    if (trusted) {
      if (typeof raw === 'string' && raw.startsWith('json:')) { try { return { v: JSON.parse(raw.slice(5)) }; } catch { return null; } }
      if (/^-?\d+(\.\d+)?$/.test(raw)) return { v: Number(raw) };
    }
    switch (raw) {
      case 'undefined': return { v: undefined };
      case 'false': return { v: false };
      case 'true': return { v: true };
      case 'null': return { v: null };
      case "''": case '""': case 'emptyStr': case '': return { v: '' };
      case 'noopFunc': return { v: function () {} };
      case 'trueFunc': return { v: function () { return true; } };
      case 'falseFunc': return { v: function () { return false; } };
      case 'throwFunc': return { v: function () { throw new Error(MAGIC); } };
      case 'noopCallbackFunc': return { v: function () { return function () {}; } };
      case 'emptyArr': case '[]': return { v: [] };
      case 'emptyObj': case '{}': return { v: {} };
      case 'noopPromise': case 'resolvedPromise': return { v: Promise.resolve() };
      case 'yes': return { v: 'yes' };
      case 'no': return { v: 'no' };
      case '-1': return { v: -1 };
      default: {
        if (/^\d+$/.test(raw)) { const n = parseInt(raw, 10); if (n <= 0x7fff) return { v: n }; }
        return trusted ? { v: raw } : null;
      }
    }
  };

  // Walks `chain` (a.b.c) and calls `onFinal(owner, prop)` once the parent
  // object exists, installing setters on missing links along the way.
  const trapChain = (root, chain, onFinal) => {
    const i = chain.indexOf('.');
    if (i === -1) { onFinal(root, chain); return; }
    const prop = chain.slice(0, i), rest = chain.slice(i + 1);
    let v;
    try { v = root[prop]; } catch { return; }
    if (v instanceof Object || (typeof v === 'object' && v !== null)) { trapChain(v, rest, onFinal); return; }
    const desc = native.getOwnPropertyDescriptor(root, prop);
    if (desc && desc.configurable === false) return;
    let current = v;
    try {
      native.defineProperty(root, prop, {
        configurable: true, enumerable: true,
        get() { return current; },
        set(nv) { current = nv; if (nv instanceof Object) trapChain(nv, rest, onFinal); }
      });
    } catch { /* ignore */ }
  };

  const S = {
    'set-constant'(chain, raw) {
      if (!chain) return;
      const parsed = parseValue(raw);
      if (!parsed) return;
      const value = parsed.v;
      trapChain(win, chain, (owner, prop) => {
        const desc = native.getOwnPropertyDescriptor(owner, prop);
        if (desc && desc.configurable === false) return;
        try {
          native.defineProperty(owner, prop, { configurable: true, enumerable: true, get() { return value; }, set() {} });
        } catch { /* ignore */ }
      });
    },
    'abort-on-property-read'(chain) {
      if (!chain) return;
      trapChain(win, chain, (owner, prop) => {
        try { native.defineProperty(owner, prop, { configurable: true, get() { throw new ReferenceError(MAGIC); }, set() {} }); } catch { /* ignore */ }
      });
    },
    'abort-on-property-write'(prop) {
      if (!prop) return;
      trapChain(win, prop, (owner, p) => {
        try { delete owner[p]; native.defineProperty(owner, p, { configurable: true, set() { throw new ReferenceError(MAGIC); } }); } catch { /* ignore */ }
      });
    },
    'abort-current-script'(chain, needle) {
      if (!chain) return;
      const re = toRe(needle);
      const thisScript = document.currentScript;
      const check = () => {
        const s = document.currentScript;
        if (!(s instanceof HTMLScriptElement) || s === thisScript) return;
        const text = s.src || s.textContent || '';
        if (needle && !re.test(text)) return;
        throw new ReferenceError(MAGIC);
      };
      let owner = win;
      const parts = chain.split('.');
      const prop = parts.pop();
      for (const p of parts) {
        try { owner = owner[p]; } catch { return; }
        if (!(owner instanceof Object)) return;
      }
      const desc = native.getOwnPropertyDescriptor(owner, prop);
      if (desc && desc.configurable === false) return;
      let value = owner[prop];
      const getter = desc && desc.get, setter = desc && desc.set;
      try {
        native.defineProperty(owner, prop, {
          configurable: true,
          get() { check(); return getter ? getter.call(this) : value; },
          set(v) { check(); if (setter) setter.call(this, v); else value = v; }
        });
      } catch { /* ignore */ }
      win.addEventListener('error', ev => { if (String(ev.message).includes(MAGIC)) ev.preventDefault(); }, true);
    },
    'no-setTimeout-if'(needle, delay) {
      const m = needleMatcher(needle || ''), d = delayMatcher(delay);
      proxyApply(win, 'setTimeout', (t, th, args) => {
        const a = String(args[0]);
        if ((needle === undefined || needle === '' || m(a)) && d(args[1])) args[0] = function () {};
        return native.apply(t, th, args);
      });
    },
    'no-setInterval-if'(needle, delay) {
      const m = needleMatcher(needle || ''), d = delayMatcher(delay);
      proxyApply(win, 'setInterval', (t, th, args) => {
        const a = String(args[0]);
        if ((needle === undefined || needle === '' || m(a)) && d(args[1])) args[0] = function () {};
        return native.apply(t, th, args);
      });
    },
    'prevent-addEventListener'(type, needle) {
      const tm = needleMatcher(type || ''), hm = needleMatcher(needle || '');
      proxyApply(EventTarget.prototype, 'addEventListener', (t, th, args) => {
        let h = '';
        try { h = String(args[1]); } catch { /* ignore */ }
        if (tm(String(args[0])) && hm(h)) return undefined;
        return native.apply(t, th, args);
      });
    },
    'no-window-open-if'(needle) {
      const m = needleMatcher(needle || '');
      proxyApply(win, 'open', (t, th, args) => {
        if (m(String(args[0] || ''))) return null;
        return native.apply(t, th, args);
      });
    },
    'no-fetch-if'(props) {
      const conds = parseProps(props);
      if (!conds) return;
      proxyApply(win, 'fetch', (t, th, args) => {
        let url = '', method = 'GET';
        try {
          const r = args[0];
          url = r instanceof Request ? r.url : String(r);
          method = (args[1] && args[1].method) || (r instanceof Request ? r.method : 'GET');
        } catch { /* ignore */ }
        if (matchProps(conds, { url, method })) return Promise.resolve(new Response('', { status: 200, statusText: 'OK' }));
        return native.apply(t, th, args);
      });
    },
    'no-xhr-if'(props) {
      const conds = parseProps(props);
      if (!conds) return;
      const map = new WeakMap();
      const proto = XMLHttpRequest.prototype;
      proxyApply(proto, 'open', (t, th, args) => {
        map.set(th, { method: String(args[0] || 'GET'), url: String(args[1] || '') });
        return native.apply(t, th, args);
      });
      proxyApply(proto, 'send', (t, th, args) => {
        const info = map.get(th);
        if (!info || !matchProps(conds, info)) return native.apply(t, th, args);
        const define = (k, v) => { try { native.defineProperty(th, k, { configurable: true, value: v }); } catch { /* ignore */ } };
        define('readyState', 4); define('status', 200); define('statusText', 'OK');
        define('responseText', ''); define('response', th.responseType === 'json' ? null : '');
        define('responseURL', info.url);
        setTimeout(() => {
          for (const type of ['readystatechange', 'load', 'loadend']) {
            try { th.dispatchEvent(new Event(type)); } catch { /* ignore */ }
          }
        }, 1);
        return undefined;
      });
    },
    'json-prune'(rawPaths, rawNeedles) {
      const paths = (rawPaths || '').split(/\s+/).filter(Boolean);
      const needles = (rawNeedles || '').split(/\s+/).filter(Boolean);
      if (!paths.length) return;
      const walk = (obj, segs, cb) => {
        if (obj === null || typeof obj !== 'object') return;
        const [seg, ...rest] = segs;
        if (seg === '[]' || seg === '*') {
          for (const k of Object.keys(obj)) {
            if (rest.length === 0) cb(obj, k); else walk(obj[k], rest, cb);
          }
          return;
        }
        if (!(seg in obj)) return;
        if (rest.length === 0) cb(obj, seg); else walk(obj[seg], rest, cb);
      };
      const has = (obj, path) => { let found = false; walk(obj, path.split('.'), () => { found = true; }); return found; };
      const prune = (obj) => {
        try {
          if (obj === null || typeof obj !== 'object') return obj;
          if (needles.length && !needles.every(n => has(obj, n))) return obj;
          for (const p of paths) walk(obj, p.split('.'), (o, k) => { delete o[k]; });
        } catch { /* ignore */ }
        return obj;
      };
      proxyApply(JSON, 'parse', (t, th, args) => prune(native.apply(t, th, args)));
      proxyApply(Response.prototype, 'json', (t, th, args) => native.apply(t, th, args).then(prune));
    },
    'remove-attr'(attrs, selector, behavior) {
      domTask(attrs, selector, behavior, (el, a) => el.removeAttribute(a), a => `[${a}]`);
    },
    'remove-class'(classes, selector, behavior) {
      domTask(classes, selector, behavior, (el, c) => el.classList.remove(c), c => `.${c}`);
    },
    'noeval'() {
      proxyApply(win, 'eval', () => undefined);
    },
    'noeval-if'(needle) {
      const m = needleMatcher(needle || '');
      proxyApply(win, 'eval', (t, th, args) => (m(String(args[0])) ? undefined : native.apply(t, th, args)));
    },
    'nowebrtc'() {
      const names = ['RTCPeerConnection', 'webkitRTCPeerConnection'];
      for (const n of names) {
        if (typeof win[n] !== 'function') continue;
        const Dummy = function () {
          this.close = function () {}; this.createDataChannel = function () {}; this.createOffer = function () { return Promise.resolve(); };
          this.setRemoteDescription = function () { return Promise.resolve(); }; this.addEventListener = function () {};
        };
        try { win[n] = Dummy; } catch { /* ignore */ }
      }
    },
    'nano-setInterval-booster'(needle, delay, boost) {
      const m = needleMatcher(needle || ''); const d = parseInt(delay || '1000', 10); let b = parseFloat(boost || '0.05');
      if (!(b >= 0.001 && b <= 50)) b = 0.05;
      proxyApply(win, 'setInterval', (t, th, args) => {
        if (m(String(args[0])) && (args[1] | 0) === d) args[1] = d * b;
        return native.apply(t, th, args);
      });
    },
    'nano-setTimeout-booster'(needle, delay, boost) {
      const m = needleMatcher(needle || ''); const d = parseInt(delay || '1000', 10); let b = parseFloat(boost || '0.05');
      if (!(b >= 0.001 && b <= 50)) b = 0.05;
      proxyApply(win, 'setTimeout', (t, th, args) => {
        if (m(String(args[0])) && (args[1] | 0) === d) args[1] = d * b;
        return native.apply(t, th, args);
      });
    },
    'set-local-storage-item'(key, value, ...va) { setStorage('local', false, key, value, va); },
    'set-session-storage-item'(key, value, ...va) { setStorage('session', false, key, value, va); },
    'trusted-set-local-storage-item'(key, value, ...va) { setStorage('local', true, key, value, va); },
    'trusted-set-session-storage-item'(key, value, ...va) { setStorage('session', true, key, value, va); },
    // Cookie-banner answers and similar, on the page's own domain.
    'set-cookie'(name, value, path, ...va) {
      if (!name) return;
      const v = String(value || '');
      const unq = v.toLowerCase().replace(/^"(.*)"$/, '$1');
      if (!SAFE_VALUES.includes(unq) && !(/^-?\d+$/.test(unq) && Math.abs(+unq) <= 32767)) return;
      setCookie(false, name, v, '', path, varargs(va));
    },
    'set-cookie-reload'(name, value, path, ...va) { S['set-cookie'](name, value, path, 'reload', '1', ...va); },
    'trusted-set-cookie'(name, value, offset, path, ...va) {
      if (!name) return;
      const now = new Date();
      let v = String(value || '').split('$now$').join(String(now.getTime()))
        .split('$currentDate$').join(now.toUTCString()).split('$currentISODate$').join(now.toISOString());
      let expires = '';
      if (offset) {
        if (offset === '1day') now.setDate(now.getDate() + 1);
        else if (offset === '1year') now.setFullYear(now.getFullYear() + 1);
        else if (/^\d+$/.test(offset)) now.setSeconds(now.getSeconds() + parseInt(offset, 10));
        else return;
        expires = now.toUTCString();
      }
      setCookie(true, name, v, expires, path, varargs(va));
    },
    'trusted-set-cookie-reload'(name, value, offset, path, ...va) { S['trusted-set-cookie'](name, value, offset, path, 'reload', '1', ...va); },
    // Clicks through elements in order (cookie banners: "Reject all"),
    // waiting for each to appear. "a, b, 500, c": numbers are waits in ms.
    'trusted-click-element'(selectors, extraMatch, delay) {
      if (!selectors) return;
      if (extraMatch && !extraMatches(extraMatch)) return;
      const raw = /^[;|]/.test(selectors) ? selectors.slice(1).split(selectors[0]) : selectors.split(',');
      const steps = raw.map(x => x.trim()).filter(Boolean).map(x => (/^\d+$/.test(x) ? parseInt(x, 10) : x));
      if (!steps.length) return;
      const pause = parseInt(delay, 10) || 1;
      for (let i = steps.length - 1; i > 0; i--) if (typeof steps[i] === 'string' && typeof steps[i - 1] === 'string') steps.splice(i, 0, pause);
      if (steps.length === 1 && delay) steps.unshift(pause);
      if (typeof steps[steps.length - 1] !== 'number') steps.push(11000);
      const timeout = steps.pop();
      const run = async () => {
        const until = Date.now() + timeout;
        for (const st of steps) {
          if (typeof st === 'number') { await new Promise(r => setTimeout(r, st)); continue; }
          if (st.startsWith('!')) continue;
          const el = await waitFor(st, until);
          if (!el) return;
          try { el.click(); } catch { return; }
        }
      };
      onReady(run, 'loading');
    },
    // Removes text nodes or scripts whose text matches, as they are added.
    'remove-node-text'(nodeName, pattern) { nodeText(nodeName, pattern, null); },
    'replace-node-text'(nodeName, pattern, replacement) { nodeText(nodeName, pattern, replacement === undefined ? '' : replacement); },
    'abort-on-stack-trace'(chain, needle) {
      if (!chain) return;
      const m = needleMatcher(needle || '');
      const token = MAGIC;
      const hit = () => {
        let st = '';
        try { st = new Error(token).stack || ''; } catch { /* ignore */ }
        const lines = st.split(/[\n\r]+/).filter(l => !l.includes(token)).map(l => l.trim());
        const docURL = location.href.split('#')[0];
        const norm = lines.map(l => l.split(docURL).join('inlineScript').replace(/<anonymous>/g, 'injectedScript')).join('\t');
        return m(norm);
      };
      trapChain(win, chain, (owner, prop) => {
        let v = owner[prop];
        try {
          native.defineProperty(owner, prop, {
            configurable: true,
            get() { if (hit()) throw new ReferenceError(token); return v; },
            set(a) { if (hit()) throw new ReferenceError(token); v = a; }
          });
        } catch { /* ignore */ }
      });
      win.addEventListener('error', ev => { if (String(ev.message).includes(token)) ev.preventDefault(); }, true);
    },
    // Rewrites tracking links on the page to their real destination.
    'href-sanitizer'(selector, source) {
      if (!selector) return;
      const src = source || 'text';
      const valid = (t) => {
        if (typeof t !== 'string' || !t || /[\x00-\x20\x7f]/.test(t)) return '';
        try { const u = new URL(t, location.href); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
      };
      const extract = (el) => {
        if (/^\[.*\]$/.test(src)) return el.getAttribute(src.slice(1, -1).trim()) || '';
        if (src === 'text') return (el.textContent || '').replace(/^[^\x21-\x7e]+/, '').replace(/[^\x21-\x7e]+$/, '');
        return urlSkip(el.href, src.replace(/(\S)\?/g, '$1 ?').split(/\s+/)) || '';
      };
      const sanitize = () => {
        let els;
        try { els = document.querySelectorAll(selector); } catch { return false; }
        for (const el of els) {
          if (el.localName !== 'a' || !el.hasAttribute('href')) continue;
          const after = valid(extract(el));
          if (after && after !== el.getAttribute('href')) el.setAttribute('href', after);
        }
        return true;
      };
      onReady(() => {
        if (!sanitize()) return;
        let t = 0;
        new MutationObserver(() => { if (!t) t = setTimeout(() => { t = 0; sanitize(); }, 100); })
          .observe(document.documentElement, { childList: true, subtree: true });
      }, 'interactive');
    },
    // Iframes created to fetch clean copies of functions get ours instead.
    'trusted-prevent-dom-bypass'(methodPath, targetProp) {
      if (!methodPath) return;
      proxyChain(methodPath, (ctx) => {
        const r = ctx.reflect();
        for (const el of ctx.args) {
          if (!(el instanceof HTMLElement)) continue;
          try {
            const cw = el.contentWindow;
            if (!cw || String(cw) !== '[object Window]') continue;
            const href = cw.location.href;
            if (href !== 'about:blank' && href !== location.href) continue;
            if (targetProp) {
              for (let chain of targetProp.split(/\s+/)) {
                let me = win, it = cw;
                let pos;
                while ((pos = chain.indexOf('.')) !== -1) { const p = chain.slice(0, pos); me = me[p]; it = it[p]; chain = chain.slice(pos + 1); }
                it[chain] = me[chain];
              }
            } else native.defineProperty(el, 'contentWindow', { value: win });
          } catch { /* cross-origin */ }
        }
        return r;
      });
    },
    'trusted-replace-argument'(chain, argpos, argraw, ...va) {
      if (!chain || argpos === undefined || argpos === '') return;
      const extra = varargs(va);
      let replacer;
      if (String(argraw).startsWith('repl:/')) {
        const m = /^repl:\/(.+)\/(.*)\/([gimsu]*)$/.exec(argraw);
        if (!m) return;
        let re; try { re = new RegExp(m[1], m[3]); } catch { return; }
        replacer = (a) => String(a).replace(re, m[2]);
      } else if (String(argraw).startsWith('add:')) {
        const d = parseFloat(argraw.slice(4));
        if (Number.isNaN(d)) return;
        replacer = (a) => Number(a) + d;
      } else {
        const pv = parseValue(argraw === undefined ? '' : argraw, true);
        if (!pv) return;
        replacer = () => pv.v;
      }
      const cond = extra.condition !== undefined ? toRe(String(extra.condition)) : null;
      const off = parseInt(argpos, 10) || 0;
      proxyChain(chain, (ctx) => {
        if (argpos === 'this') {
          if (!cond || cond.test(String(ctx.thisArg))) ctx.thisArg = replacer(ctx.thisArg);
          return ctx.reflect();
        }
        const i = off >= 0 ? off : ctx.args.length + off;
        if (i >= 0 && i < ctx.args.length && (!cond || cond.test(String(ctx.args[i])))) ctx.args[i] = replacer(ctx.args[i]);
        return ctx.reflect();
      });
    },
    // Fakes for BlockAdBlock / FuckAdBlock style detectors.
    'nofab'() {
      const Fake = function () {};
      Fake.prototype = {
        check() { return this; }, clearEvent() {}, emitEvent() {}, on(d, fn) { if (!d && typeof fn === 'function') setTimeout(fn, 1); return this; },
        onDetected() { return this; }, onNotDetected(fn) { if (typeof fn === 'function') setTimeout(fn, 1); return this; }, setOption() { return this; }, options: {}
      };
      const inst = new Fake();
      for (const [k, v] of [['FuckAdBlock', Fake], ['BlockAdBlock', Fake], ['SniffAdBlock', Fake], ['fuckAdBlock', inst], ['blockAdBlock', inst], ['sniffAdBlock', inst]]) {
        try { native.defineProperty(win, k, { configurable: true, get() { return v; }, set() {} }); } catch { /* ignore */ }
      }
    },
    'nobab'() {
      S.nofab();
      S['no-setTimeout-if']('/babasbm|blockadblock|\\.bab_elementid|fuckadblock/i');
    },
    'popads-dummy'() {
      for (const k of ['PopAds', 'popns']) { try { delete win[k]; native.defineProperty(win, k, { configurable: true, value: {} }); } catch { /* ignore */ } }
    },
    'popads.net'() { S['abort-on-property-read']('PopAds'); S['abort-on-property-read']('popns'); },
    'refresh-defuser'() {
      onReady(() => { for (const m of document.querySelectorAll('meta[http-equiv="refresh" i]')) m.remove(); }, 'interactive');
    },
    'alert-buster'() { try { win.alert = function () {}; } catch { /* ignore */ } },
    'set-attr'(selector, attr, value) { attrTask(selector, attr, value, false); },
    'trusted-set-attr'(selector, attr, value) { attrTask(selector, attr, value, true); },
    'json-prune-fetch-response'(paths, needles, ...va) {
      const pr = makePruner(paths, needles); if (!pr) return;
      const conds = parseProps(varargs(va).propsToMatch);
      proxyApply(win, 'fetch', (t, th, args) => {
        const p = native.apply(t, th, args);
        if (!matchRequest(conds, args)) return p;
        return p.then(res => res.clone().json().then(obj => {
          const out = new Response(JSON.stringify(pr(obj)), { status: res.status, statusText: res.statusText, headers: res.headers });
          try { native.defineProperty(out, 'url', { value: res.url }); native.defineProperty(out, 'type', { value: res.type }); } catch { /* ignore */ }
          return out;
        }).catch(() => res));
      });
    },
    'json-prune-xhr-response'(paths, needles, ...va) {
      const pr = makePruner(paths, needles); if (!pr) return;
      xhrRewrite(parseProps(varargs(va).propsToMatch), (text) => { try { return JSON.stringify(pr(JSON.parse(text))); } catch { return text; } });
    },
    'trusted-replace-fetch-response'(pattern, replacement, props) {
      const re = textPattern(pattern); if (!re) return;
      const conds = parseProps(props);
      proxyApply(win, 'fetch', (t, th, args) => {
        const p = native.apply(t, th, args);
        if (!matchRequest(conds, args)) return p;
        return p.then(res => res.clone().text().then(text => {
          const out = new Response(text.replace(re, replacement || ''), { status: res.status, statusText: res.statusText, headers: res.headers });
          try { native.defineProperty(out, 'url', { value: res.url }); } catch { /* ignore */ }
          return out;
        }).catch(() => res));
      });
    },
    'trusted-replace-xhr-response'(pattern, replacement, props) {
      const re = textPattern(pattern); if (!re) return;
      xhrRewrite(parseProps(props), (text) => text.replace(re, replacement || ''));
    },
    'remove-cookie'(needle) {
      const m = needleMatcher(needle || '');
      const run = () => {
        for (const part of document.cookie.split(';')) {
          const name = part.split('=')[0].trim();
          if (!name || !m(name)) continue;
          const parts = location.hostname.split('.');
          for (let i = 0; i < parts.length - 1; i++) {
            const d = parts.slice(i).join('.');
            document.cookie = `${name}=; max-age=0; path=/; domain=${d}`;
          }
          document.cookie = `${name}=; max-age=0; path=/`;
        }
      };
      run();
      win.addEventListener('beforeunload', run);
    }
  };

  const SAFE_VALUES = ['accept', 'reject', 'accepted', 'rejected', 'notaccepted', 'allow', 'disallow', 'deny', 'allowed', 'denied',
    'approved', 'disapproved', 'checked', 'unchecked', 'dismiss', 'dismissed', 'enable', 'disable', 'enabled', 'disabled',
    'essential', 'nonessential', 'forbidden', 'forever', 'hide', 'hidden', 'necessary', 'required', 'ok', 'on', 'off',
    'true', 't', 'false', 'f', 'yes', 'y', 'no', 'n', 'all', 'none', 'functional', 'granted', 'done', 'decline', 'declined',
    'closed', 'next', 'mandatory', 'disagree', 'agree', 'set', 'unset', 'given'];
  function varargs(list) {
    const out = {};
    for (let i = 0; i + 1 < list.length; i += 2) out[list[i]] = list[i + 1];
    return out;
  }
  function onReady(fn, when) {
    const ok = () => (when === 'interactive' ? document.readyState !== 'loading' : !!document.documentElement);
    if (ok()) { fn(); return; }
    if (when === 'interactive') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else { const mo = new MutationObserver(() => { if (ok()) { mo.disconnect(); fn(); } }); mo.observe(document, { childList: true }); }
  }
  function getCookie(name) {
    for (const part of document.cookie.split(/\s*;\s*/)) {
      const i = part.indexOf('=');
      if (i !== -1 && part.slice(0, i) === name) return part.slice(i + 1).trim();
    }
    return undefined;
  }
  function setCookie(trusted, name, value, expires, path, opts) {
    if (!trusted && /[^!#$%&'*+\-.0-9A-Z[\]^_`a-z|~]/.test(name)) name = encodeURIComponent(name);
    if (/[^ -:<-[\]-~]/.test(value)) value = encodeURIComponent(value);
    const before = getCookie(name);
    if (before !== undefined && opts.dontOverwrite) return;
    if (before === value && opts.reload) return;
    const parts = [name, '=', value];
    if (expires) parts.push('; expires=', expires);
    let p = path || '/';
    if (p === 'none') p = '';
    if (p !== '' && p !== '/') return;
    if (p === '/') parts.push('; path=/');
    if (trusted) {
      if (opts.domain) {
        let d = opts.domain;
        if (/^\/.+\/$/.test(d)) { const m = new RegExp(d.slice(1, -1)).exec(location.hostname); d = m ? m[0] : ''; }
        if (d) parts.push('; domain=' + d);
      }
      parts.push('; Secure');
    } else if (/^__(Host|Secure)-/.test(name)) parts.push('; Secure');
    try { document.cookie = parts.join(''); } catch { return; }
    if (getCookie(name) === value && opts.reload) location.reload();
  }
  function setStorage(which, trusted, key, value, va) {
    if (!key) return;
    let v = value === undefined ? '' : String(value);
    if (v === 'emptyArr') v = '[]'; else if (v === 'emptyObj') v = '{}';
    if (trusted) {
      v = v.split('$now$').join(String(Date.now())).split('$currentDate$').join(String(Date())).split('$currentISODate$').join(new Date().toISOString());
    } else {
      const unq = v.toLowerCase().replace(/^"(.*)"$/, '$1');
      const ok = ['', 'undefined', 'null', '{}', '[]', '""', '$remove$', ...SAFE_VALUES].includes(unq) || (/^-?\d+$/.test(unq) && Math.abs(+unq) <= 32767);
      if (!ok) return;
    }
    const opts = varargs(va || []);
    let changed = false;
    try {
      const st = win[which + 'Storage'];
      if (v === '$remove$') {
        const re = toRe(key);
        const keys = [];
        for (let i = 0; i < st.length; i++) { const k = st.key(i); if (re.test(k)) keys.push(k); }
        for (const k of keys) st.removeItem(k);
        changed = keys.length > 0;
      } else if (st.getItem(key) !== v) { st.setItem(key, v); changed = true; }
    } catch { /* storage blocked */ }
    if (changed && opts.reload !== undefined) setTimeout(() => location.reload(), parseInt(opts.reload, 10) || 0);
  }
  function extraMatches(spec) {
    const all = (kind) => {
      const out = [];
      try {
        if (kind === 'cookie') for (const p of document.cookie.split(/\s*;\s*/)) { const i = p.indexOf('='); if (i > 0) out.push(p.slice(0, i) + '=' + p.slice(i + 1)); }
        else for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out.push(k + '=' + localStorage.getItem(k)); }
      } catch { /* ignore */ }
      return out;
    };
    for (const part of spec.split(',')) {
      const i = part.indexOf(':');
      let type = (i !== -1 ? part.slice(0, i) : part).trim();
      const not = type.startsWith('!'); if (not) type = type.slice(1);
      const arg = i !== -1 ? part.slice(i + 1).trim() : '';
      if (!arg || (type !== 'cookie' && type !== 'localStorage')) continue;
      const m = /^\/(.+)\/(i?)$/.exec(arg);
      let re;
      if (m) re = new RegExp(m[1], m[2] || undefined);
      else { const j = arg.indexOf('='); const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); re = new RegExp('^' + esc(j !== -1 ? arg.slice(0, j).trim() : arg) + '=' + esc(j !== -1 ? arg.slice(j + 1).trim() : '')); }
      if (all(type).some(x => re.test(x)) === not) return false;
    }
    return true;
  }
  // "a >>> b" pierces shadow roots; "xpath:..." evaluates XPath.
  function query(sel, ctx) {
    const at = sel.indexOf(' >>> ');
    const one = (s, c) => {
      if (!s.startsWith('xpath:')) { try { return [...c.querySelectorAll(s)]; } catch { return []; } }
      const out = [];
      try { const r = document.evaluate(s.slice(6), c, null, 7, null); for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i)); } catch { /* ignore */ }
      return out;
    };
    if (at === -1) return one(sel, ctx);
    const out = [];
    for (const el of one(sel.slice(0, at).trim(), ctx)) {
      let sr = el.shadowRoot;
      try { const cd = win.chrome && win.chrome.dom; if (!sr && cd && cd.openOrClosedShadowRoot) sr = cd.openOrClosedShadowRoot(el); } catch { /* ignore */ }
      if (sr) out.push(...query(sel.slice(at + 5).trim(), sr));
    }
    return out;
  }
  function waitFor(sel, until) {
    return new Promise((resolve) => {
      const found = () => query(sel, document)[0];
      const el = found();
      if (el) { resolve(el); return; }
      let done = false;
      const finish = (v) => { if (done) return; done = true; mo.disconnect(); clearTimeout(timer); resolve(v); };
      const mo = new MutationObserver(() => { const e = found(); if (e) finish(e); });
      mo.observe(document, { childList: true, subtree: true });
      const timer = setTimeout(() => finish(found() || null), Math.max(0, until - Date.now()));
    });
  }
  function nodeText(nodeName, pattern, replacement) {
    if (!nodeName || pattern === undefined || pattern === '') return;
    const name = nodeName.toLowerCase();
    const re = textPattern(pattern);
    if (!re) return;
    const handle = (node) => {
      const n = node.nodeName.toLowerCase();
      if (n !== name && !(name === '#text' && node.nodeType === 3)) return;
      const text = node.textContent;
      re.lastIndex = 0;
      if (!re.test(text)) return;
      re.lastIndex = 0;
      if (replacement === null) {
        if (node.nodeType === 3) node.textContent = '';
        else { node.textContent = ''; try { node.remove(); } catch { /* ignore */ } }
      } else node.textContent = text.replace(re, replacement);
    };
    const scan = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n = walker.currentNode; n; n = walker.nextNode()) handle(n);
    };
    if (document.documentElement) scan(document.documentElement);
    const mo = new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) { handle(n); if (n.nodeType === 1 && n.firstChild) scan(n); } });
    mo.observe(document, { childList: true, subtree: true });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(() => mo.disconnect(), 5000), { once: true });
  }
  function textPattern(p) {
    if (typeof p !== 'string' || !p) return null;
    const m = /^\/(.+)\/([gimsu]*)$/.exec(p);
    try { return m ? new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g') : new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'); } catch { return null; }
  }
  // Wraps the function at a dotted path ("Node.prototype.appendChild").
  function proxyChain(chain, handler) {
    const parts = chain.split('.');
    const prop = parts.pop();
    let owner = win;
    for (const p of parts) { try { owner = owner[p]; } catch { return; } if (!owner) return; }
    const fn = owner[prop];
    if (typeof fn !== 'function') return;
    const wrap = (t, th, args, construct) => {
      const ctx = { thisArg: th, args: [...args], reflect() { return construct ? Reflect.construct(t, ctx.args) : native.apply(t, ctx.thisArg, ctx.args); } };
      return handler(ctx);
    };
    try {
      owner[prop] = new Proxy(fn, { apply: (t, th, args) => wrap(t, th, args, false), construct: (t, args) => wrap(t, null, args, true) });
    } catch { /* frozen */ }
  }
  function makePruner(rawPaths, rawNeedles) {
    const paths = (rawPaths || '').split(/\s+/).filter(Boolean);
    const needles = (rawNeedles || '').split(/\s+/).filter(Boolean);
    if (!paths.length) return null;
    const walk = (obj, segs, cb) => {
      if (obj === null || typeof obj !== 'object') return;
      const [seg, ...rest] = segs;
      if (seg === '[]' || seg === '*') { for (const k of Object.keys(obj)) { if (!rest.length) cb(obj, k); else walk(obj[k], rest, cb); } return; }
      if (!(seg in obj)) return;
      if (!rest.length) cb(obj, seg); else walk(obj[seg], rest, cb);
    };
    const has = (obj, p) => { let f = false; walk(obj, p.split('.'), () => { f = true; }); return f; };
    return (obj) => {
      try {
        if (obj === null || typeof obj !== 'object') return obj;
        if (needles.length && !needles.every(n => has(obj, n))) return obj;
        for (const p of paths) walk(obj, p.split('.'), (o, k) => { delete o[k]; });
      } catch { /* ignore */ }
      return obj;
    };
  }
  function matchRequest(conds, args) {
    if (!conds) return true;
    let url = '', method = 'GET';
    try { const r = args[0]; const isReq = r && typeof r === 'object' && typeof r.url === 'string'; url = isReq ? r.url : String(r); method = (args[1] && args[1].method) || (isReq && r.method) || 'GET'; } catch { /* ignore */ }
    return matchProps(conds, { url, method });
  }
  function xhrRewrite(conds, edit) {
    const info = new WeakMap();
    const proto = XMLHttpRequest.prototype;
    proxyApply(proto, 'open', (t, th, args) => { info.set(th, { method: String(args[0] || 'GET'), url: String(args[1] || '') }); return native.apply(t, th, args); });
    const desc = (k) => native.getOwnPropertyDescriptor(proto, k);
    const rText = desc('responseText'), rResp = desc('response');
    const cache = new WeakMap();
    const edited = (xhr) => {
      if (xhr.readyState !== 4) return null;
      const i = info.get(xhr);
      if (!i || (conds && !matchProps(conds, i))) return null;
      if (cache.has(xhr)) return cache.get(xhr);
      let text;
      try { text = rText.get.call(xhr); } catch { return null; }
      const out = edit(text);
      cache.set(xhr, out);
      return out;
    };
    try {
      native.defineProperty(proto, 'responseText', { configurable: true, enumerable: true, get() { const e = edited(this); return e === null ? rText.get.call(this) : e; } });
      native.defineProperty(proto, 'response', { configurable: true, enumerable: true, get() {
        const type = this.responseType;
        if (type !== '' && type !== 'text' && type !== 'json') return rResp.get.call(this);
        const e = edited(this);
        if (e === null) return rResp.get.call(this);
        if (type === 'json') { try { return JSON.parse(e); } catch { return null; } }
        return e;
      } });
    } catch { /* ignore */ }
  }
  function attrTask(selector, attr, value, trusted) {
    if (!selector || !attr) return;
    let v = value === undefined ? '' : String(value);
    const copy = /^\[.+\]$/.test(v) ? v.slice(1, -1) : null;
    if (!trusted && copy === null && !['', 'true', 'false'].includes(v) && !(/^\d+$/.test(v) && +v <= 32767)) return;
    if (/^on/i.test(attr) || /^(src|href|srcdoc|style)$/i.test(attr) && !trusted) return;
    const run = () => {
      let els; try { els = document.querySelectorAll(selector); } catch { return; }
      for (const el of els) {
        const nv = copy !== null ? el.getAttribute(copy) : v;
        if (nv !== null && el.getAttribute(attr) !== nv) el.setAttribute(attr, nv);
      }
    };
    onReady(() => {
      run();
      let t = 0;
      new MutationObserver(() => { if (!t) t = setTimeout(() => { t = 0; run(); }, 50); }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: [attr] });
    }, 'loading');
  }
  // Same transformation steps as the urlskip= filter option.
  function urlSkip(url, steps) {
    try {
      let out = url;
      for (const step of steps) {
        const inp = out;
        if (step === '#') { const p = inp.indexOf('#'); out = p !== -1 ? inp.slice(p + 1) : ''; continue; }
        if (step[0] === '&') { const i = (parseInt(step.slice(1), 10) || 0) - 1; if (i < 0) return; const keys = [...new URL(inp).searchParams.keys()]; if (i >= keys.length) return; out = decodeURIComponent(keys[i]); continue; }
        if (step === '+https') { const x = inp.replace(/^https?:\/\//, ''); if (/^[\w-]:\/\//.test(x)) return; out = 'https://' + x; continue; }
        if (step === '-base64') { out = atob(inp); continue; }
        if (step === '-safebase64') { out = atob(inp.replace(/[-_]/g, c => (c === '-' ? '+' : '/'))); continue; }
        if (step === '-uricomponent') { out = decodeURIComponent(inp); continue; }
        if (step === '-blocked') continue;
        if (step[0] === '/') { const m = new RegExp(step.slice(1, -1)).exec(inp); if (!m || m.length <= 1) return; out = m[1]; continue; }
        if (step[0] === '?') { out = new URL(inp).searchParams.get(step.slice(1)); if (out === null) return; out = out.replace(/ /g, '%20'); continue; }
        return;
      }
      const u = new URL(out);
      return u.protocol === 'https:' || u.protocol === 'http:' ? out : undefined;
    } catch { return undefined; }
  }
  function parseProps(raw) {
    if (raw === undefined) return null;
    const conds = [];
    for (const tok of String(raw).split(/\s+/).filter(Boolean)) {
      const i = tok.indexOf(':');
      if (i > 0 && /^[a-z]+$/.test(tok.slice(0, i))) conds.push([tok.slice(0, i), toRe(tok.slice(i + 1))]);
      else conds.push(['url', toRe(tok)]);
    }
    return conds;
  }
  function matchProps(conds, info) {
    if (!conds.length) return true;
    return conds.every(([k, re]) => re.test(String(info[k] ?? '')));
  }
  function domTask(tokens, selector, behavior, apply, toSel) {
    const list = String(tokens || '').split(/\s*\|\s*/).filter(Boolean);
    if (!list.length) return;
    const sel = selector || list.map(toSel).join(',');
    const run = () => {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch { return; }
      for (const el of nodes) for (const t of list) apply(el, t);
    };
    const stay = /stay/.test(behavior || '');
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
    else run();
    if (/complete/.test(behavior || '')) win.addEventListener('load', run, { once: true });
    if (stay) {
      let timer = 0;
      new MutationObserver(() => { if (!timer) timer = setTimeout(() => { timer = 0; run(); }, 50); })
        .observe(document, { childList: true, subtree: true, attributes: true });
    }
  }

  for (const [name, ...args] of entries) {
    const fn = S[name];
    if (!fn) continue;
    try { fn(...args); } catch { /* one broken scriptlet must not stop the rest */ }
  }
}

// Builds the source of a content script that applies the scriptlets of one
// list for the current hostname. `table` maps hostnames to entries and
// `exceptions` maps hostnames to excepted entry keys ("name|args" or "*").
// The first line holds the table so the service worker can read it back
// (see bundledScriptletTable) and the data never has to ship twice.
// `runtime` is the source of bulwarkScriptlets (minified by the build).
export function buildScriptletFile(table, exceptions, runtime = bulwarkScriptlets.toString()) {
  return '(()=>{const T=' + JSON.stringify(table) + '\n,E=' + JSON.stringify(exceptions) + `
;const h=location.hostname;if(!h)return;const L=h.split('.'),x=new Set(),out=[];
for(let i=0;i<L.length;i++){const e=E[L.slice(i).join('.')];if(e)for(const k of e)x.add(k)}
if(x.has('*'))return;
for(let i=0;i<L.length;i++){const l=T[L.slice(i).join('.')];if(l)for(const e of l)if(!x.has(e[0]+'|'+e.slice(1).join('|')))out.push(e)}
if(out.length)(${runtime})(out)})();
`;
}
