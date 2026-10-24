(function() {
  'use strict';
  const hex = 'ac9d8f1a6b2e4c7d0f3e5a8b1c2d4e6f';
  const Fingerprint2 = function() {};
  Fingerprint2.get = function(opts, cb) {
    if (!cb) cb = opts;
    setTimeout(() => { if (cb) cb([]); }, 1);
  };
  Fingerprint2.getPromise = function() { return Promise.resolve([]); };
  Fingerprint2.getV18 = function() { return hex; };
  Fingerprint2.x64hash128 = function() { return hex; };
  Fingerprint2.prototype = { get: function(opts, cb) { if (!cb) cb = opts; setTimeout(() => { if (cb) cb(hex, []); }, 1); } };
  window.Fingerprint2 = Fingerprint2;
})();
