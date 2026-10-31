// Bulwark service worker: event wiring and the message API used by the
// popup, options page and content scripts. Every listener is registered
// synchronously at the top level, as Manifest V3 requires.

import { LISTS } from '../engine/lists.js';
import {
  VERSION, DEFAULT_SETTINGS, getSettings, saveSettings, deepMerge, getCustomFilters,
  hostOf, rawHostOf, hostChain, isWhitelisted, cookiePolicyFor, isValidHostname, report, diagnostics, serial,
  effective, netPolicy, IS_SAFARI
} from './state.js';
import { netFetch, SB_HOST } from './net.js';
import { syncStaticRulesets, syncSystemRules, syncCustomRules, syncListDeltas, ruleStats, testUrl } from './rules.js';
import { rebuildCosmeticIndex, buildCosmeticIndex, frameInit, genericTokens, applyNow, invalidateCustomCosmetic, forgetTab as forgetCosmeticTab, indexInfo, prepareFrame, appliedSelectors } from './cosmetic.js';
import { syncRegistrations, onCommitted, getMeta, fallbackActive } from './scripts.js';
import { updateLists, rebuildOverlay, listStates, forgetList, scheduleUpdates } from './updater.js';
import { onCookieChanged, sweepSite, cookieSummary } from './cookies.js';
import * as stats from './stats.js';
import { MENU, createMenus, refreshMenus } from './menus.js';
import * as idb from './idb.js';

const DNR = chrome.declarativeNetRequest;
const EXT_ORIGIN = chrome.runtime.getURL('');

// --------------------------------------------------------------- lifecycle

async function fullSync(reason) {
  const t0 = performance.now();
  const s = await getSettings();
  await saveSettings(s);
  await step('rulesets', syncStaticRulesets);
  await step('system-rules', syncSystemRules);
  await step('custom-rules', syncCustomRules);
  await step('list-deltas', syncListDeltas);
  await step('overlay', rebuildOverlay);
  await step('cosmetic', buildCosmeticIndex);
  await step('scripts', syncRegistrations);
  await step('menus', createMenus);
  await step('badge', applyBadge);
  await step('alarms', ensureAlarm);
  await idb.kv.set('syncedVersion', VERSION);
  await idb.kv.set('lastSync', { at: Date.now(), reason, ms: Math.round(performance.now() - t0) });
}

async function step(name, fn) {
  try { await fn(); } catch (e) { report(name, e); }
}

chrome.runtime.onInstalled.addListener((details) => {
  serial(() => fullSync(details.reason)).then(() => {
    if (details.reason === 'install') chrome.runtime.openOptionsPage().catch(() => {});
  });
});

chrome.runtime.onStartup.addListener(() => {
  serial(async () => {
    const v = await idb.kv.get('syncedVersion').catch(() => null);
    if (v !== VERSION) return fullSync('version');
    await step('scripts', syncRegistrations);
    await step('alarms', ensureAlarm);
    await step('badge', applyBadge);
  });
});

async function ensureAlarm() {
  const s = await getSettings();
  const cur = await chrome.alarms.get('bw-update');
  const period = Math.max(1, s.update.intervalHours) * 60;
  if (!effective(s).autoUpdate) { if (cur) chrome.alarms.clear('bw-update'); return; }
  if (!cur || cur.periodInMinutes !== period) scheduleUpdates(s);
}

async function applyBadge() {
  const s = await getSettings();
  try {
    if (DNR.setExtensionActionOptions) await DNR.setExtensionActionOptions({ displayActionCountAsBadgeText: !!s.ui.badge });
    chrome.action.setBadgeBackgroundColor({ color: '#3b3f4a' });
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });
  } catch (e) { report('badge', e); }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'bw-update') return;
  // Strict privacy may have been switched on after the alarm was set.
  getSettings().then(s => { if (effective(s).autoUpdate) return updateLists(); chrome.alarms.clear('bw-update'); })
    .catch(e => report('update', e));
});

// ------------------------------------------------------------- navigation

chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0) stats.resetTab(d.tabId, d.url);
});

chrome.webNavigation.onCommitted.addListener((d) => {
  prepareFrame(d).catch(e => report('commit-css', e));
  onCommitted(d).catch(e => report('commit', e));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  offTabs.delete(tabId);
  stats.forgetTab(tabId);
  forgetCosmeticTab(tabId);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { const t = await chrome.tabs.get(tabId); refreshTabUi(tabId, t.url); refreshMenus(t.url); } catch { /* ignore */ }
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'loading') {
    refreshTabUi(tabId, tab.url);
    if (tab.active) refreshMenus(tab.url);
  }
});

// The "off" toolbar icon is drawn from the normal one at runtime (faded),
// so it does not have to ship as separate files. Icons are only touched
// for tabs whose state differs from the default.
const ICON_ON = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' };
let iconOff = null;
const offTabs = new Set();

async function offIcon() {
  if (iconOff) return iconOff;
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return null;
  const out = {};
  for (const size of [16, 32]) {
    const blob = await (await fetch(chrome.runtime.getURL(`icons/icon-${size}.png`))).blob();
    const bmp = await createImageBitmap(blob);
    const ctx = new OffscreenCanvas(size, size).getContext('2d');
    ctx.globalAlpha = 0.3;
    ctx.drawImage(bmp, 0, 0, size, size);
    out[size] = ctx.getImageData(0, 0, size, size);
  }
  return (iconOff = out);
}

async function refreshTabUi(tabId, url) {
  const s = await getSettings();
  const host = hostOf(url || '');
  const off = !s.enabled || (host && isWhitelisted(host, s));
  if (!off && !offTabs.has(tabId)) return;
  try {
    if (off) {
      const imageData = await offIcon();
      if (imageData) await chrome.action.setIcon({ tabId, imageData });
      offTabs.add(tabId);
    } else {
      await chrome.action.setIcon({ tabId, path: ICON_ON });
      offTabs.delete(tabId);
    }
  } catch { offTabs.delete(tabId); /* tab gone */ }
}

// ------------------------------------------------------------------- stats

if (DNR.onRuleMatchedDebug) {
  // Available for unpacked installs: exact per-rule attribution.
  DNR.onRuleMatchedDebug.addListener((info) => { stats.onRuleMatched(info); });
} else if (chrome.webRequest && chrome.webRequest.onErrorOccurred) {
  // Packed installs: observe requests the browser refused on our behalf.
  chrome.webRequest.onErrorOccurred.addListener(stats.onBlockedError, { urls: ['<all_urls>'] });
}

if (chrome.cookies && chrome.cookies.onChanged) {
  chrome.cookies.onChanged.addListener((info) => { onCookieChanged(info).catch(e => report('cookies', e)); });
}

// ----------------------------------------------------------- context menu

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab || tab.id < 0) return;
    const host = hostOf(tab.url || '');
    switch (info.menuItemId) {
      case MENU.pick: return openPicker(tab.id, info.frameId || 0, 'target');
      case MENU.blockUrl: {
        if (!info.srcUrl || !/^https?:/.test(info.srcUrl)) return;
        await addCustomFilter('|' + info.srcUrl.replace(/\*/g, '%2A').replace(/\^/g, '%5E').replace(/\|/g, '%7C') + '|');
        return chrome.tabs.reload(tab.id);
      }
      case MENU.toggle: {
        if (!host) return;
        const s = await getSettings();
        await setSiteEnabled(host, isWhitelisted(host, s));
        return chrome.tabs.reload(tab.id);
      }
      case MENU.ckBlock: case MENU.ckNecessary: case MENU.ckAllow: {
        if (!host) return;
        const policy = info.menuItemId === MENU.ckBlock ? 'block' : info.menuItemId === MENU.ckAllow ? 'allow' : 'necessary';
        await setCookiePolicy(host, policy);
        return chrome.tabs.reload(tab.id);
      }
      case MENU.options: return chrome.runtime.openOptionsPage();
    }
  });
}

// ---------------------------------------------------------------- actions

async function setSiteEnabled(host, enabled) {
  const s = structuredClone(await getSettings());
  if (enabled) {
    const chain = new Set(hostChain(host));
    s.whitelist = s.whitelist.filter(h => !chain.has(h));
  } else if (!s.whitelist.includes(host) && isValidHostname(host)) {
    s.whitelist.push(host);
  }
  await saveSettings(s);
  await serial(async () => { await syncSystemRules(); await syncRegistrations(); });
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (t) { refreshTabUi(t.id, t.url); refreshMenus(t.url); }
}

async function setCookiePolicy(host, policy) {
  if (!['block', 'necessary', 'allow'].includes(policy) || !isValidHostname(host)) return;
  const s = structuredClone(await getSettings());
  const sites = { ...s.cookies.sites };
  for (const h of hostChain(host)) if (h !== host) delete sites[h];
  if (policy === s.cookies.default) delete sites[host]; else sites[host] = policy;
  s.cookies.sites = sites;
  await saveSettings(s);
  await serial(async () => { await syncSystemRules(); await syncRegistrations(); });
  if (policy !== 'allow') await sweepSite(host);
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (t) refreshMenus(t.url);
}

async function openPicker(tabId, frameId, mode) {
  const target = { tabId, frameIds: [frameId] };
  await chrome.scripting.executeScript({ target, func: (m) => { (window.__bw || (window.__bw = {})).pick = m; }, args: [mode] });
  await chrome.scripting.executeScript({ target, files: ['content/picker.js'] });
}

async function addCustomFilter(filter) {
  const text = await getCustomFilters();
  const lines = text.split('\n');
  if (!lines.includes(filter)) {
    const next = (text.trimEnd() + '\n' + filter).trimStart() + '\n';
    await chrome.storage.local.set({ customFilters: next });
  }
  await serial(async () => {
    await syncCustomRules();
    invalidateCustomCosmetic();
    await rebuildOverlay();
  });
}

async function saveCustomFilters(text) {
  await chrome.storage.local.set({ customFilters: String(text || '') });
  return serial(async () => {
    const res = await syncCustomRules();
    invalidateCustomCosmetic();
    await rebuildOverlay();
    return res;
  });
}

// Applies a settings patch and runs only the side effects it needs.
async function applySettings(patch) {
  const before = await getSettings();
  const next = deepMerge(before, patch);
  if (patch.cookies && patch.cookies.sites) next.cookies.sites = patch.cookies.sites;
  if (patch.whitelist) next.whitelist = [...new Set(patch.whitelist.map(h => String(h).trim().toLowerCase().replace(/^www\./, '')).filter(isValidHostname))];
  await saveSettings(next);
  const changed = (k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]);
  await serial(async () => {
    if (changed('lists') || changed('customLists') || changed('youtube')) await step('rulesets', syncStaticRulesets);
    if (changed('whitelist') || changed('cookies') || changed('enabled') || changed('youtube')) await step('system-rules', syncSystemRules);
    if (changed('lists') || changed('customLists')) { await step('list-deltas', syncListDeltas); await step('overlay', rebuildOverlay); }
    if (changed('whitelist') || changed('cookies') || changed('youtube') || changed('lists') || changed('enabled')) await step('scripts', syncRegistrations);
    if (changed('ui')) await step('badge', applyBadge);
    if (changed('update') || changed('privacy')) await step('alarms', ensureAlarm);
  });
  if (changed('lists') || changed('customLists')) {
    // Newly enabled runtime-only lists need a download.
    const s = await getSettings();
    const states = await listStates();
    const missing = [
      ...LISTS.filter(l => !l.bundled && s.lists[l.id] && !states[l.id]?.updatedAt).map(l => l.id),
      ...s.customLists.filter(c => c.enabled && !states[c.id]?.updatedAt).map(c => c.id)
    ];
    if (missing.length) updateLists({ ids: missing, force: true }).catch(e => report('update', e));
    else rebuildCosmeticIndex().catch(e => report('cosmetic', e));
  }
  return getSettings();
}

// --------------------------------------------------------- SponsorBlock

const sbCache = new Map();
async function sponsorSegments(id, categories) {
  if (!/^[\w-]{11}$/.test(id)) return { segments: [] };
  const settings = await getSettings();
  if (!effective(settings).sponsorblock) return { segments: [] };
  const cats = (Array.isArray(categories) && categories.length ? categories : ['sponsor']).filter(c => /^[a-z_]+$/.test(c));
  const key = id + '|' + cats.join(',');
  if (sbCache.has(key)) return { segments: sbCache.get(key) };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  const prefix = [...new Uint8Array(digest)].slice(0, 2).map(b => b.toString(16).padStart(2, '0')).join('');
  const url = `https://${SB_HOST}/api/skipSegments/${prefix}?categories=${encodeURIComponent(JSON.stringify(cats))}&actionTypes=${encodeURIComponent('["skip"]')}`;
  let segments = [];
  try {
    {
      const data = JSON.parse(await netFetch(url, netPolicy(settings)));
      const entry = Array.isArray(data) ? data.find(d => d.videoID === id) : null;
      if (entry) {
        segments = entry.segments
          .filter(s => (!s.actionType || s.actionType === 'skip') && cats.includes(s.category))
          .map(s => ({ start: +s.segment[0], end: +s.segment[1], category: s.category }))
          .filter(s => s.end - s.start >= 1);
      }
    }
  } catch (e) { report('sponsorblock', e); }
  sbCache.set(key, segments);
  if (sbCache.size > 200) sbCache.delete(sbCache.keys().next().value);
  return { segments };
}

// ------------------------------------------------------------ data views

let summaryCache = null;
async function listsSummary(s) {
  if (summaryCache && Date.now() - summaryCache.at < 10000 && summaryCache.key === JSON.stringify([s.lists, s.customLists])) return summaryCache.value;
  const meta = await getMeta();
  let filters = 0, enabled = 0;
  for (const l of LISTS) {
    if (!s.lists[l.id]) continue;
    enabled++;
    filters += (meta.lists[l.id] && meta.lists[l.id].filters) || 0;
  }
  enabled += s.customLists.filter(c => c.enabled).length;
  const { lastUpdate } = await chrome.storage.local.get('lastUpdate');
  const states = await listStates();
  const errors = Object.values(states).filter(x => x.error).length;
  for (const c of s.customLists) if (c.enabled && states[c.id] && states[c.id].stats) filters += states[c.id].stats.network + states[c.id].stats.cosmetic;
  const value = { enabled, total: LISTS.length + s.customLists.length, filters, lastUpdate: lastUpdate ? lastUpdate.at : meta.builtAt, errors };
  summaryCache = { at: Date.now(), key: JSON.stringify([s.lists, s.customLists]), value };
  return value;
}

async function popupState(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const s = await getSettings();
  const url = tab.url || '';
  const host = hostOf(url);
  const web = /^https?:/.test(url);
  const st = await stats.tabStats(tabId, rawHostOf(url));
  if (IS_SAFARI && !DNR.onRuleMatchedDebug) {
    const n = await stats.matchedCount(tabId);
    if (n !== null) st.blocked = Math.max(st.blocked, n);
  }
  let hidden = 0;
  if (web) {
    try {
      const res = await Promise.race([
        chrome.tabs.sendMessage(tabId, { t: 'count', sels: appliedSelectors(tabId) }, { frameId: 0 }),
        new Promise(r => setTimeout(() => r(null), 400))
      ]);
      hidden = (res && res.count) || 0;
    } catch { /* no content script (e.g. store pages) */ }
  }
  return {
    host, web,
    enabled: s.enabled,
    siteEnabled: !isWhitelisted(host, s),
    blocked: st.blocked, cookies: st.cookies + st.siteCookies, yt: st.yt, hidden,
    cookiePolicy: host ? cookiePolicyFor(host, s) : s.cookies.default,
    cookieDefault: s.cookies.default,
    strict: effective(s).strict,
    lists: await listsSummary(s),
    detailedStats: !!DNR.onRuleMatchedDebug,
    version: VERSION
  };
}

async function optionsData() {
  const s = await getSettings();
  const meta = await getMeta();
  const [states, rs, lastSync, cosmeticInfo, dash] = await Promise.all([
    listStates(), ruleStats(), idb.kv.get('lastSync'), indexInfo(), stats.dashboard()
  ]);
  const { lastUpdate } = await chrome.storage.local.get('lastUpdate');
  return {
    settings: s,
    customFilters: await getCustomFilters(),
    catalog: LISTS,
    meta, states, rules: rs, lastSync, cosmetic: cosmeticInfo, lastUpdate,
    stats: dash, diagnostics: diagnostics(),
    env: { version: VERSION, mainWorldFallback: fallbackActive(), debugCounting: !!DNR.onRuleMatchedDebug, ua: navigator.userAgent }
  };
}

function validateImport(data) {
  if (!data || typeof data !== 'object') throw new Error('Not a Bulwark backup');
  if (data.app !== 'bulwark') throw new Error('Not a Bulwark backup');
  const settings = deepMerge(DEFAULT_SETTINGS, data.settings || {});
  settings.whitelist = (settings.whitelist || []).filter(isValidHostname);
  for (const [h, p] of Object.entries(settings.cookies.sites || {})) {
    if (!isValidHostname(h) || !['block', 'necessary', 'allow'].includes(p)) delete settings.cookies.sites[h];
  }
  if (!['block', 'necessary', 'allow'].includes(settings.cookies.default)) settings.cookies.default = 'necessary';
  settings.customLists = (settings.customLists || []).filter(c => c && /^https:\/\//.test(c.url)).map((c, i) => ({
    id: /^custom-[\w-]+$/.test(c.id) ? c.id : `custom-${Date.now()}-${i}`, name: String(c.name || c.url).slice(0, 80), url: c.url, enabled: c.enabled !== false
  }));
  return { settings, customFilters: typeof data.customFilters === 'string' ? data.customFilters : '' };
}

// --------------------------------------------------------------- messages

const CONTENT_MESSAGES = new Set(['frame-init', 'tokens', 'yt-stats', 'ck-stats', 'sb-segments', 'picker-add', 'picker-open-options']);

async function handle(msg, sender) {
  // Only this extension's own pages and content scripts may talk to it.
  if (sender.id !== chrome.runtime.id) throw new Error('Not allowed');
  const fromExtensionPage = sender.url && sender.url.startsWith(EXT_ORIGIN) && !sender.tab?.url?.startsWith('http');
  if (!fromExtensionPage && !CONTENT_MESSAGES.has(msg.t)) throw new Error('Not allowed');
  const tabId = sender.tab ? sender.tab.id : -1;

  switch (msg.t) {
    // ---- content scripts
    case 'frame-init': return frameInit(sender, msg);
    case 'tokens': return genericTokens(sender, msg);
    case 'yt-stats': stats.countYouTube(tabId, msg); return null;
    case 'ck-stats': stats.countShimCookies(tabId, msg.n | 0); return null;
    case 'sb-segments': return sponsorSegments(msg.id, msg.categories);
    case 'picker-add': {
      const host = rawHostOf(sender.url || '').replace(/^www\./, '');
      const sel = String(msg.selector || '').trim();
      if (!host || !sel || /[{}\n]/.test(sel) || sel.length > 500) return { ok: false };
      await addCustomFilter(`${host}##${sel}`);
      await applyNow(tabId, sender.frameId || 0, sel);
      return { ok: true };
    }
    case 'picker-open-options': return chrome.runtime.openOptionsPage();

    // ---- popup
    case 'popup': return popupState(msg.tabId);
    case 'set-site-enabled': await setSiteEnabled(msg.host, !!msg.enabled); return { ok: true };
    case 'set-cookie-policy': await setCookiePolicy(msg.host, msg.policy); return { ok: true };
    case 'set-global': await applySettings({ enabled: !!msg.enabled }); refreshAllTabs(); return { ok: true };
    case 'open-picker': await openPicker(msg.tabId, 0, 'hover'); return { ok: true };
    case 'sweep-site': return { removed: await sweepSite(msg.host) };
    case 'cookie-summary': return cookieSummary(msg.host);

    // ---- options
    case 'options': return optionsData();
    case 'save-settings': return applySettings(msg.patch || {});
    case 'update-now': return updateLists({ force: !!msg.force, ids: msg.ids || null });
    case 'save-custom-filters': return saveCustomFilters(msg.text);
    case 'add-custom-list': {
      const url = String(msg.url || '').trim();
      let parsed = null;
      try { parsed = new URL(url); } catch { /* invalid */ }
      if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || url.length > 500) throw new Error('Use a plain https:// URL');
      const s = await getSettings();
      if (s.customLists.some(c => c.url === url)) throw new Error('That list is already added');
      const id = `custom-${Date.now().toString(36)}`;
      await applySettings({ customLists: [...s.customLists, { id, name: String(msg.name || url).slice(0, 80), url, enabled: true }] });
      return updateLists({ ids: [id], force: true });
    }
    case 'remove-custom-list': {
      const s = await getSettings();
      await forgetList(msg.id);
      await applySettings({ customLists: s.customLists.filter(c => c.id !== msg.id) });
      return { ok: true };
    }
    case 'export': {
      return { app: 'bulwark', version: VERSION, exportedAt: new Date().toISOString(), settings: await getSettings(), customFilters: await getCustomFilters() };
    }
    case 'import': {
      const { settings, customFilters } = validateImport(msg.data);
      await chrome.storage.local.set({ customFilters });
      await saveSettings(settings);
      await serial(() => fullSync('import'));
      return { ok: true };
    }
    case 'reset-stats': await stats.resetStats(); return { ok: true };
    case 'test-url': return testUrl(String(msg.url || ''), msg.initiator || undefined, msg.type || undefined);
    case 'sweep-all': {
      const all = await chrome.cookies.getAll({});
      const sites = new Set(all.map(c => c.domain.replace(/^\./, '')));
      let removed = 0;
      for (const h of sites) removed += await sweepSite(h);
      return { removed };
    }
    case 'resync': await serial(() => fullSync('manual')); return { ok: true };
    default: throw new Error('Unknown message ' + msg.t);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.t !== 'string') return false;
  handle(msg, sender).then(
    (res) => sendResponse(res === undefined ? null : res),
    (err) => sendResponse({ error: String(err && err.message ? err.message : err) })
  );
  return true;
});

async function refreshAllTabs() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) refreshTabUi(t.id, t.url);
}
