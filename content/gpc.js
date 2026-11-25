// Global Privacy Control: navigator.globalPrivacyControl is true, matching
// the Sec-GPC: 1 header Bulwark sends with every request. MAIN world,
// document_start, all frames; registered only while the option is on.
(() => {
  try {
    const get = { get globalPrivacyControl() { return true; } };
    const desc = Object.getOwnPropertyDescriptor(get, 'globalPrivacyControl');
    Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { configurable: true, enumerable: true, get: desc.get });
  } catch { /* ignore */ }
})();
