(function() {
  'use strict';
  const noop = function() {};
  const Tracker = function() {};
  Tracker.prototype.get = noop; Tracker.prototype.set = noop; Tracker.prototype.send = noop;
  const w = window;
  const gaName = w.GoogleAnalyticsObject || 'ga';
  const gaQueue = w[gaName];
  const ga = function() {
    const len = arguments.length;
    if (len === 0) return;
    const args = Array.prototype.slice.call(arguments);
    const last = args[len - 1];
    let cb;
    if (last instanceof Object && typeof last.hitCallback === 'function') cb = last.hitCallback;
    else if (typeof last === 'function') cb = () => last(ga.create());
    else {
      const i = args.indexOf('hitCallback');
      if (i !== -1 && typeof args[i + 1] === 'function') cb = args[i + 1];
    }
    if (cb) { try { cb(); } catch (e) { /* ignore */ } }
  };
  ga.create = function() { return new Tracker(); };
  ga.getByName = function() { return new Tracker(); };
  ga.getAll = function() { return [new Tracker()]; };
  ga.remove = noop;
  ga.loaded = true;
  w[gaName] = ga;
  const dl = w.dataLayer;
  if (dl instanceof Object && dl.hide instanceof Object && typeof dl.hide.end === 'function') { dl.hide.end(); dl.hide.end = noop; }
  if (gaQueue instanceof Function && Array.isArray(gaQueue.q)) {
    for (const entry of gaQueue.q) ga(...entry);
  }
})();
