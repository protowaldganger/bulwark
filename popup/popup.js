const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => {
  if (r && r.error) throw new Error(r.error);
  return r;
});

const fmt = new Intl.NumberFormat();
const HINTS = {
  block: 'No cookies at all. Sign-ins and carts will not work.',
  necessary: 'Only what the site needs to work: sign-in, security, consent, cart.',
  allow: 'All first-party cookies. Third-party trackers stay blocked.'
};

let tab = null;
let state = null;

function ago(ts) {
  if (!ts) return 'never';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function render() {
  const s = state;
  renderLists(s);
  $('privacy').hidden = !s.strict;
  $('global').checked = s.enabled;
  document.body.classList.toggle('paused', !s.enabled || !s.siteEnabled);
  if (!s.web || !s.host) {
    $('main').hidden = true;
    $('inactive').hidden = false;
    $('pick').disabled = true;
    return;
  }
  $('main').hidden = false;
  $('inactive').hidden = true;
  $('host').textContent = s.host;
  $('site').checked = s.siteEnabled;
  $('site').disabled = !s.enabled;
  const st = $('state');
  if (!s.enabled) { st.textContent = 'Paused everywhere'; st.className = 'state'; }
  else if (s.siteEnabled) { st.innerHTML = '<span class="dot"></span>Protected'; st.className = 'state on'; }
  else { st.textContent = 'Blocking is off for this site'; st.className = 'state'; }

  $('n-blocked').textContent = fmt.format(s.blocked);
  $('n-hidden').textContent = fmt.format(s.hidden);
  $('n-cookies').textContent = fmt.format(s.cookies);
  const isYt = /(^|\.)youtube\.com$/.test(s.host);
  $('n-yt').textContent = fmt.format(s.yt);
  $('tiles').classList.toggle('four', isYt);
  $('tile-yt').hidden = !isYt;

  for (const b of document.querySelectorAll('#cookies button')) {
    b.setAttribute('aria-pressed', String(b.dataset.p === s.cookiePolicy));
  }
  $('cookie-hint').textContent = HINTS[s.cookiePolicy] + (s.cookiePolicy === s.cookieDefault ? ' Default.' : '');
}

function renderLists(s) {
  const l = s.lists;
  $('lists-text').textContent = l.errors
    ? `${l.errors} list update failed · open filter lists`
    : `${l.enabled} lists · ${fmt.format(l.filters)} filters · updated ${ago(l.lastUpdate)}`;
  $('lists').classList.toggle('warn', l.errors > 0);
  $('pick').disabled = !s.enabled || !s.siteEnabled || !s.web;
}

async function refresh() {
  state = await send({ t: 'popup', tabId: tab.id });
  render();
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  await refresh();

  $('global').addEventListener('change', async (e) => {
    await send({ t: 'set-global', enabled: e.target.checked });
    await chrome.tabs.reload(tab.id);
    await refresh();
  });
  $('site').addEventListener('change', async (e) => {
    await send({ t: 'set-site-enabled', host: state.host, enabled: e.target.checked });
    await chrome.tabs.reload(tab.id);
    await refresh();
  });
  $('cookies').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.p === state.cookiePolicy) return;
    state.cookiePolicy = b.dataset.p;
    render();
    await send({ t: 'set-cookie-policy', host: state.host, policy: b.dataset.p });
    await chrome.tabs.reload(tab.id);
  });
  $('lists').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#lists') });
    window.close();
  });
  $('options').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
  $('pick').addEventListener('click', async () => {
    await send({ t: 'open-picker', tabId: tab.id });
    window.close();
  });

  // Live counters while the popup is open.
  setInterval(() => { refresh().catch(() => {}); }, 1500);
}

init().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<p style="padding:12px;color:var(--warn)">${String(e.message).replace(/</g, '&lt;')}</p>`);
});
