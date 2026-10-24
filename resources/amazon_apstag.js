(function() {
  'use strict';
  const w = window;
  const noop = function() {};
  const _Q = w.apstag && w.apstag._Q || [];
  const apstag = {
    _Q,
    fetchBids: function(a, b) { if (typeof b === 'function') b([]); },
    init: noop,
    setDisplayBids: noop,
    targetingKeys: noop
  };
  w.apstag = apstag;
})();
