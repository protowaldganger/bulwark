// Asks the service worker where this tracking link really leads and goes
// there, replacing this page in history (see background/skip.js).
(async () => {
  const steps = new URLSearchParams(location.search).get('s') || '';
  let res = null;
  try { res = await chrome.runtime.sendMessage({ t: 'skip-target', s: steps }); } catch { /* ignore */ }
  if (res && res.url) location.replace(res.url);
  else document.getElementById('m').textContent = 'This tracking link could not be skipped. Go back to try again.';
})();
