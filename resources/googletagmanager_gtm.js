(function() {
  'use strict';
  const noop = function() {};
  const w = window;
  w.ga = w.ga || noop;
  const dl = w.dataLayer;
  if (dl instanceof Object) {
    if (dl.hide instanceof Object && typeof dl.hide.end === 'function') { dl.hide.end(); dl.hide.end = noop; }
    if (typeof dl.push === 'function') {
      const run = function(o) {
        if (o instanceof Object && typeof o.eventCallback === 'function') { setTimeout(o.eventCallback, 1); o.eventCallback = noop; }
      };
      dl.push = new Proxy(dl.push, { apply(t, th, args) { run(args[0]); return Reflect.apply(t, th, args); } });
      if (Array.isArray(dl)) for (const o of dl.slice()) run(o);
    }
  }
})();
