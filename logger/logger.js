// Request log page (see background/logger.js).
import { LISTS, YT_RULESET } from '../engine/lists.js';

const $ = (id) => document.getElementById(id);
const tabId = parseInt(location.hash.slice(1), 10);
const NAMES = Object.fromEntries(LISTS.map(l => [l.id, l.name]));
NAMES[YT_RULESET] = 'Bulwark YouTube rules';

let since = 0, paused = false, kind = 'all', query = '';
const entries = [];
const ruleCache = new Map(); // rulesetId -> Map(ruleId -> rule)
let dynamic = null;

// What a rule id in the dynamic or session range is (see background/ids.js).
function dynamicName(id) {
  if (id < 10) return ['Allow-listed site', 'Paused', 'YouTube ad-free', 'YouTube ad-free', 'Global Privacy Control', '"Open anyway" site'][id - 1] || 'Bulwark';
  if (id >= 60 && id < 70) return 'Switch for this site';
  if (id < 1000) return 'Cookie control';
  if (id < 100000) return 'My filters';
  const l = LISTS[Math.floor((id - 100000) / 100000)];
  return l ? l.name + ' (update)' : 'List update';
}

async function rulesFor(rulesetId) {
  if (rulesetId === '_dynamic' || rulesetId === '_session') {
    if (!dynamic) {
      const r = await chrome.runtime.sendMessage({ t: 'log-rules' }).catch(() => null);
      dynamic = new Map([...(r?.dynamic || []), ...(r?.session || [])].map(x => [x.id, x]));
      setTimeout(() => { dynamic = null; }, 5000);
    }
    return dynamic;
  }
  if (!ruleCache.has(rulesetId)) {
    const p = fetch(chrome.runtime.getURL(`rulesets/${rulesetId}.json`)).then(r => r.json()).then(list => new Map(list.map(x => [x.id, x]))).catch(() => new Map());
    ruleCache.set(rulesetId, p);
  }
  return ruleCache.get(rulesetId);
}

function outcome(rule) {
  if (!rule) return 'blocked';
  const t = rule.action.type;
  if (t === 'allow' || t === 'allowAllRequests' || t === 'upgradeScheme') return 'allowed';
  if (t === 'block') return 'blocked';
  if (t === 'redirect' && rule.action.redirect.extensionPath) {
    const p = rule.action.redirect.extensionPath;
    return p.startsWith('/blocked/') ? 'blocked' : p.startsWith('/skip/') ? 'changed' : 'blocked';
  }
  return 'changed';
}
const LABEL = { blocked: 'Blocked', allowed: 'Allowed', changed: 'Changed' };

function describe(rule, url) {
  if (!rule) return '';
  const c = rule.condition;
  if (c.urlFilter) return c.urlFilter;
  if (c.regexFilter) return '/' + c.regexFilter + '/';
  if (c.requestDomains) {
    let host = ''; try { host = new URL(url).hostname; } catch { /* ignore */ }
    const hit = c.requestDomains.find(d => host === d || host.endsWith('.' + d));
    return '||' + (hit || c.requestDomains[0]) + '^';
  }
  if (c.initiatorDomains) return 'on ' + c.initiatorDomains.slice(0, 3).join(', ');
  return '';
}

async function enrich(e) {
  if (e.event) return;
  const rules = await rulesFor(e.ruleset);
  const rule = rules.get(e.rule);
  e.result = outcome(rule);
  e.list = e.ruleset === '_dynamic' || e.ruleset === '_session' ? (e.ruleset === '_session' ? 'One-off allow' : dynamicName(e.rule)) : (NAMES[e.ruleset] || e.ruleset);
  e.how = describe(rule, e.url);
  if (rule && rule.action.type === 'modifyHeaders') e.how = (rule.action.responseHeaders || rule.action.requestHeaders || []).map(h => h.header).join(', ') + (e.how ? ' · ' + e.how : '');
  if (rule && rule.action.type === 'redirect' && rule.action.redirect.transform) e.how = 'tracking parameters removed' + (e.how ? ' · ' + e.how : '');
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function urlHtml(u) {
  try {
    const x = new URL(u);
    return esc(x.protocol + '//') + '<b>' + esc(x.host) + '</b>' + esc((x.pathname + x.search).slice(0, 400));
  } catch { return esc(String(u).slice(0, 400)); }
}

function visible(e) {
  if (e.event === 'navigation') return kind === 'all' && !query;
  if (kind !== 'all') {
    const r = e.event ? 'blocked' : e.result;
    if (r !== kind) return false;
  }
  if (query) {
    const hay = (e.url + ' ' + e.type + ' ' + (e.list || '') + ' ' + (e.how || '')).toLowerCase();
    if (!hay.includes(query)) return false;
  }
  return true;
}

function render() {
  const rows = [];
  let shown = 0;
  for (let i = entries.length - 1; i >= 0 && rows.length < 600; i--) {
    const e = entries[i];
    if (!visible(e)) continue;
    if (e.event === 'navigation') {
      rows.push(`<tr class="nav"><td class="time">${time(e.t)}</td><td colspan="4" class="url">Page loaded: ${urlHtml(e.url)}</td></tr>`);
      continue;
    }
    shown++;
    const r = e.event ? 'blocked' : e.result;
    const what = e.event ? 'Closed' : LABEL[r];
    rows.push(`<tr><td class="time">${time(e.t)}</td><td><span class="pill ${r}">${what}</span></td><td>${esc(e.event ? 'pop-up' : e.type)}</td><td class="url">${urlHtml(e.url)}</td><td class="rule">${esc(e.event ? (e.event.includes('switch') ? 'Switch for this site' : 'Pop-up filter') : e.list)}${e.how ? `<code>${esc(e.how)}</code>` : ''}</td></tr>`);
  }
  $('rows').innerHTML = rows.join('');
  $('empty').hidden = rows.length > 0;
  const total = entries.filter(e => e.event !== 'navigation').length;
  $('count').textContent = shown === total ? `${total} requests` : `${shown} of ${total}`;
}

async function poll() {
  if (paused) return;
  let res = null;
  try { res = await chrome.runtime.sendMessage({ t: 'log-get', tabId, since }); } catch { return; }
  if (!res) return;
  if (!res.available) {
    $('note').hidden = false;
    $('note').textContent = 'Chrome only reports which rule matched to extensions loaded unpacked (Developer mode, "Load unpacked"). Load Bulwark that way to use the request log.';
  }
  if (!res.entries.length) return;
  since = res.last;
  for (const e of res.entries) await enrich(e);
  entries.push(...res.entries);
  if (entries.length > 3000) entries.splice(0, entries.length - 3000);
  render();
}

async function init() {
  if (!Number.isInteger(tabId)) { $('empty').textContent = 'Open the request log from the Bulwark button on the tab you want to watch.'; return; }
  try {
    const t = await chrome.tabs.get(tabId);
    $('tabname').textContent = t.title || t.url || '';
    document.title = 'Request log: ' + (t.title || '');
  } catch { $('tabname').textContent = 'Tab closed'; }
  $('kind').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    kind = b.dataset.k;
    for (const x of $('kind').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    render();
  });
  $('q').addEventListener('input', () => { query = $('q').value.trim().toLowerCase(); render(); });
  $('pause').addEventListener('click', () => { paused = !paused; $('pause').setAttribute('aria-pressed', String(paused)); $('pause').textContent = paused ? 'Resume' : 'Pause'; });
  $('clear').addEventListener('click', async () => { await chrome.runtime.sendMessage({ t: 'log-clear', tabId }).catch(() => {}); entries.length = 0; render(); });
  render();
  await poll();
  setInterval(poll, 1000);
}
init();
