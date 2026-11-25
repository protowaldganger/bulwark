// Warning page for a blocked page (see background/blocked.js).
(async () => {
  const $ = (id) => document.getElementById(id);
  let info = null;
  try { info = await chrome.runtime.sendMessage({ t: 'blocked-info' }); } catch { /* ignore */ }
  if (info && info.url) {
    $('host').textContent = info.host || info.url;
    $('url').textContent = info.url;
    $('url').hidden = false;
    $('more').hidden = false;
    document.title = 'Blocked: ' + (info.host || info.url);
  }
  $('back').addEventListener('click', () => {
    if (history.length > 1) { history.back(); return; }
    try { chrome.tabs.getCurrent((t) => { if (t) chrome.tabs.remove(t.id); }); } catch { window.close(); }
  });
  $('go').addEventListener('click', async () => {
    if (!info || !info.url) return;
    $('go').disabled = true;
    let res = null;
    try { res = await chrome.runtime.sendMessage({ t: 'blocked-proceed', url: info.url, always: $('always').checked }); } catch { /* ignore */ }
    if (res && res.ok) location.replace(info.url);
    else { $('go').disabled = false; $('go').textContent = 'Could not open it'; }
  });
})();
