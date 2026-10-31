// Counters for the popup, badge and dashboard. All updates are in memory
// and flushed to storage on a timer, so counting never sits on a hot path.

import { ID, dynamicState } from './ids.js';
import { siteOf, rawHostOf, getSettings, effective } from './state.js';

const tabs = new Map();          // tabId -> { blocked, cookies, yt, host }
const siteCookies = new Map();   // site -> removed count (this session)
let day = null;                  // today's totals
let topDomains = null;           // host -> count (persisted, capped)
let dirty = false, flushTimer = 0, loaded = null;
let quietIds = null;             // per-ruleset Set of rule ids that are exceptions
let dynQuiet = null, dynVersion = -1;

const today = () => new Date().toISOString().slice(0, 10);

async function load() {
  if (!loaded) {
    loaded = (async () => {
      const [{ stats }, sess] = await Promise.all([
        chrome.storage.local.get('stats'),
        chrome.storage.session ? chrome.storage.session.get(['tabStats', 'siteCookies']).catch(() => ({})) : {}
      ]);
      const st = stats || {};
      day = st.days && st.days[today()] ? st.days[today()] : blankDay();
      topDomains = new Map(Object.entries(st.top || {}));
      if (sess && sess.tabStats) for (const [k, v] of Object.entries(sess.tabStats)) if (!tabs.has(+k)) tabs.set(+k, v);
      if (sess && sess.siteCookies) for (const [k, v] of Object.entries(sess.siteCookies)) siteCookies.set(k, v);
    })();
  }
  return loaded;
}

function blankDay() {
  return { blocked: 0, cookies: 0, cosmetic: 0, ytPruned: 0, ytSkipped: 0, sbSkipped: 0, ytCostMicros: 0, ytSamples: 0, pages: 0 };
}

function tab(tabId) {
  let t = tabs.get(tabId);
  if (!t) { t = { blocked: 0, cookies: 0, yt: 0, host: '' }; tabs.set(tabId, t); }
  return t;
}

function schedule() {
  dirty = true;
  if (!flushTimer) flushTimer = setTimeout(flush, 5000);
}

export async function flush() {
  flushTimer = 0;
  if (!dirty || !day) return;
  dirty = false;
  const { stats } = await chrome.storage.local.get('stats');
  const st = stats || { days: {}, since: Date.now() };
  st.days = st.days || {};
  for (const [k, v] of Object.entries(pendingDays)) { st.days[k] = v; delete pendingDays[k]; }
  st.days[day._d || today()] = day;
  const keys = Object.keys(st.days).sort();
  while (keys.length > 30) delete st.days[keys.shift()];
  if (topDomains.size > 300) {
    topDomains = new Map([...topDomains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200));
  }
  // Strict privacy keeps the per-site breakdown in memory only.
  const keep = effective(await getSettings()).keepHistory;
  st.top = keep ? Object.fromEntries(topDomains) : {};
  await chrome.storage.local.set({ stats: st });
  if (chrome.storage.session) {
    const tabStats = Object.fromEntries([...tabs.entries()].slice(-50));
    chrome.storage.session.set({ tabStats, siteCookies: Object.fromEntries(siteCookies) }).catch(() => {});
  }
}

const pendingDays = {};
function rollDay() {
  const d = today();
  if (!day) day = blankDay();
  if (day._d && day._d !== d) {
    pendingDays[day._d] = day;
    day = blankDay();
    dirty = true;
  }
  day._d = d;
}

async function loadQuietIds() {
  if (quietIds) return quietIds;
  quietIds = new Map();
  try {
    const res = await fetch(chrome.runtime.getURL('generated/meta.json'));
    const meta = await res.json();
    for (const [id, m] of Object.entries(meta.lists || {})) quietIds.set(id, m.quiet || 0);
  } catch { /* ignore */ }
  return quietIds;
}

// onRuleMatchedDebug (unpacked installs): exact per-rule attribution.
export async function onRuleMatched(info) {
  await load(); rollDay();
  const { request, rule } = info;
  const t = request.tabId >= 0 ? tab(request.tabId) : null;
  if (rule.rulesetId === '_dynamic' || rule.rulesetId === '_session') {
    if (rule.ruleId >= ID.cookieTrackers && rule.ruleId < ID.customBase) {
      if (t) t.cookies++;
      day.cookies++;
      schedule();
      return;
    }
    if (rule.ruleId < ID.cookieTrackers) return; // whitelist / pause
    if (dynVersion !== dynamicState.version || !dynQuiet) {
      dynVersion = dynamicState.version;
      const rules = await chrome.declarativeNetRequest.getDynamicRules().catch(() => []);
      dynQuiet = new Set(rules.filter(r => r.action.type === 'allow' || r.action.type === 'allowAllRequests' || (r.action.type === 'redirect' && r.action.redirect.transform)).map(r => r.id));
    }
    if (dynQuiet.has(rule.ruleId)) return;
  } else {
    const q = (await loadQuietIds()).get(rule.rulesetId);
    if (q && rule.ruleId <= q) return;
  }
  countBlocked(t, request.url);
}

// webRequest fallback for packed installs.
export async function onBlockedError(details) {
  if (details.error !== 'net::ERR_BLOCKED_BY_CLIENT') return;
  await load(); rollDay();
  countBlocked(details.tabId >= 0 ? tab(details.tabId) : null, details.url);
}

function countBlocked(t, url) {
  if (t) t.blocked++;
  day.blocked++;
  const h = rawHostOf(url);
  if (h) { const k = siteOf(h); topDomains.set(k, (topDomains.get(k) || 0) + 1); }
  schedule();
}

export async function resetTab(tabId, url) {
  await load(); rollDay();
  tabs.set(tabId, { blocked: 0, cookies: 0, yt: 0, host: rawHostOf(url) });
  day.pages++;
  schedule();
}

export function forgetTab(tabId) { tabs.delete(tabId); }

export async function countCookie(domain, n) {
  await load(); rollDay();
  const site = siteOf(domain);
  siteCookies.set(site, (siteCookies.get(site) || 0) + n);
  day.cookies += n;
  schedule();
}

export async function countShimCookies(tabId, n) {
  await load(); rollDay();
  if (tabId >= 0) tab(tabId).cookies += n;
  day.cookies += n;
  schedule();
}

export async function countYouTube(tabId, m) {
  await load(); rollDay();
  day.ytPruned += m.pruned | 0;
  day.ytSkipped += m.skipped | 0;
  day.sbSkipped += m.sb | 0;
  day.ytCostMicros += m.cost | 0;
  day.ytSamples += m.samples | 0;
  if (tabId >= 0) tab(tabId).yt += (m.pruned | 0) + (m.skipped | 0);
  schedule();
}

// Safari has no per-request rule events, but can list the rules matched in
// a tab on demand (declarativeNetRequestFeedback). Used when the popup opens.
export async function matchedCount(tabId) {
  const DNR = chrome.declarativeNetRequest;
  if (!DNR.getMatchedRules) return null;
  try {
    const res = await DNR.getMatchedRules({ tabId });
    const quiet = await loadQuietIds();
    let n = 0;
    for (const m of (res && res.rulesMatchedInfo) || []) {
      const r = m.rule || {};
      if (r.rulesetId === '_dynamic' || r.rulesetId === '_session') { if (r.ruleId >= ID.customBase) n++; continue; }
      const q = quiet.get(r.rulesetId);
      if (!(q && r.ruleId <= q)) n++;
    }
    return n;
  } catch { return null; }
}

export async function tabStats(tabId, host) {
  await load();
  const t = tabs.get(tabId) || { blocked: 0, cookies: 0, yt: 0 };
  const site = host ? siteOf(host) : '';
  return { ...t, siteCookies: site ? (siteCookies.get(site) || 0) : 0 };
}

export async function dashboard() {
  await load(); rollDay();
  await flush().catch(() => {});
  const { stats } = await chrome.storage.local.get('stats');
  const st = stats || { days: {} };
  const days = st.days || {};
  days[today()] = day;
  const top = [...topDomains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  return { days, top, since: st.since || Date.now() };
}

export async function resetStats() {
  day = blankDay(); day._d = today();
  topDomains = new Map();
  await chrome.storage.local.set({ stats: { days: {}, since: Date.now() } });
}
