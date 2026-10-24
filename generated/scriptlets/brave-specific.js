(()=>{const T={"dev-pages.brave.software":[["set-constant","window.BRAVE_TEST_VALUE","true"]],"dev-pages.bravesoftware.com":[["set-constant","window.BRAVE_TEST_VALUE","true"]]}
,E={}
;const h=location.hostname;if(!h)return;const L=h.split('.'),x=new Set(),out=[];
for(let i=0;i<L.length;i++){const e=E[L.slice(i).join('.')];if(e)for(const k of e)x.add(k)}
if(x.has('*'))return;
for(let i=0;i<L.length;i++){const l=T[L.slice(i).join('.')];if(l)for(const e of l)if(!x.has(e[0]+'|'+e.slice(1).join('|')))out.push(e)}
if(out.length)(function bulwarkScriptlets(entries) {
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
  const parseValue = (raw) => {
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
        return null;
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
    'set-local-storage-item'(key, value) {
      if (!key) return;
      const allowed = { undefined: null, false: 'false', true: 'true', null: 'null', "''": '', '': '', emptyArr: '[]', emptyObj: '{}', yes: 'yes', no: 'no', on: 'on', off: 'off', '$remove$': null };
      let v;
      if (Object.prototype.hasOwnProperty.call(allowed, value)) v = allowed[value];
      else if (/^\d+$/.test(value) && +value <= 0x7fff) v = value;
      else return;
      try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, v); } catch { /* ignore */ }
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
})(out)})();
