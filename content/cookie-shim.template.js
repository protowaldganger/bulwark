// document.cookie guard, MAIN world, document_start, all frames.
// Generated into generated/cookie-<mode>.js by tools/build.mjs.
// "necessary": drops known tracking cookies and every cookie written from a
//   cross-site frame; the service worker removes the remaining
//   non-essential cookies asynchronously.
// "block": the page can neither read nor write cookies.
(() => {
  'use strict';
  const MODE = '__MODE__';
  const TRACKER = new RegExp(String.raw`__TRACKER__`, 'i');
  const proto = Document.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'cookie');
  if (!desc || !desc.get || !desc.set || desc.configurable === false) return;

  const site = (host) => {
    const p = host.split('.');
    if (p.length <= 2) return host;
    const sld = p[p.length - 2];
    const twoLevel = p[p.length - 1].length === 2 && /^(co|com|net|org|gov|ac|edu|ne|or|go)$/.test(sld);
    return p.slice(twoLevel ? -3 : -2).join('.');
  };
  const ENTITIES = __ENTITIES__;
  const entityOf = (s) => { for (let i = 0; i < ENTITIES.length; i++) if (ENTITIES[i].includes(s)) return i; return -1; };
  let thirdParty = false;
  try {
    if (window.top !== window) {
      const ao = location.ancestorOrigins;
      const topOrigin = ao && ao.length ? ao[ao.length - 1] : document.referrer;
      if (!topOrigin) thirdParty = true;
      else {
        const a = site(new URL(topOrigin).hostname), b = site(location.hostname);
        thirdParty = a !== b && (entityOf(a) === -1 || entityOf(a) !== entityOf(b));
      }
    }
  } catch { thirdParty = true; }

  // Private, random event name, handed to the isolated content script
  // through an attribute it removes before any page script runs.
  const dispatch = EventTarget.prototype.dispatchEvent;
  const CE = CustomEvent;
  const channel = 'x' + Math.random().toString(36).slice(2);
  try { document.documentElement.setAttribute('data-bwc', channel); } catch { /* no root yet */ }
  let dropped = 0, timer = 0;
  const report = () => {
    timer = 0;
    if (!dropped) return;
    try { dispatch.call(document, new CE(channel, { detail: String(dropped) })); } catch { /* ignore */ }
    dropped = 0;
  };
  const note = () => { dropped++; if (!timer) timer = setTimeout(report, 1000); };

  const isDeletion = (s) => /;\s*max-age\s*=\s*(0|-)/i.test(s) || /;\s*expires\s*=\s*[^;]*(19[0-9]{2}|1970)/i.test(s);
  const allowWrite = (s) => {
    if (isDeletion(s)) return true;
    if (MODE === 'block' || thirdParty) return false;
    const name = s.split('=')[0].trim();
    return !TRACKER.test(name);
  };
  const blockRead = MODE === 'block' || thirdParty;

  const getter = new Proxy(desc.get, {
    apply(t, th, args) { return blockRead ? '' : Reflect.apply(t, th, args); }
  });
  const setter = new Proxy(desc.set, {
    apply(t, th, args) {
      const s = String(args[0]);
      if (allowWrite(s)) return Reflect.apply(t, th, args);
      note();
      return undefined;
    }
  });
  try {
    Object.defineProperty(proto, 'cookie', { configurable: true, enumerable: desc.enumerable, get: getter, set: setter });
  } catch { /* ignore */ }

  // Async Cookie Store API
  const CS = window.CookieStore && window.CookieStore.prototype;
  if (CS && typeof CS.set === 'function') {
    const origSet = CS.set;
    try {
      CS.set = new Proxy(origSet, {
        apply(t, th, args) {
          const a = args[0];
          const name = typeof a === 'string' ? a : (a && a.name) || '';
          const expired = a && typeof a === 'object' && typeof a.expires === 'number' && a.expires < Date.now();
          if (!expired && (MODE === 'block' || thirdParty || TRACKER.test(name))) { note(); return Promise.resolve(); }
          return Reflect.apply(t, th, args);
        }
      });
      if (blockRead) {
        CS.get = new Proxy(CS.get, { apply() { return Promise.resolve(null); } });
        CS.getAll = new Proxy(CS.getAll, { apply() { return Promise.resolve([]); } });
      }
    } catch { /* ignore */ }
  }
})();
