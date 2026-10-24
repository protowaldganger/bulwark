(function() {
  'use strict';
  const noopthis = function() { return this; };
  const noopfalse = function() { return false; };
  const FAB = function() {};
  FAB.prototype.check = noopfalse;
  FAB.prototype.clearEvent = noopthis;
  FAB.prototype.emitEvent = noopthis;
  FAB.prototype.on = function(a, b) { if (!a) b(); return this; };
  FAB.prototype.onDetected = noopthis;
  FAB.prototype.onNotDetected = function(a) { a(); return this; };
  FAB.prototype.setOption = noopthis;
  FAB.prototype.options = { set: noopthis, get: noopthis };
  const fab = new FAB();
  const props = ['BlockAdBlock', 'FuckAdBlock', 'SniffAdBlock'];
  for (const p of props) {
    window[p] = FAB;
    window[p.charAt(0).toLowerCase() + p.slice(1)] = fab;
  }
})();
