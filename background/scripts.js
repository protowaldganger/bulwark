// Dynamic content script registrations.
//
// MAIN-world scripts cannot read extension storage, so their behaviour is
// chosen by *which* scripts are registered and for *which* sites:
//   bw-yt-main      YouTube payload pruner (unless whitelisted or disabled)
//   bw-yt-iso       YouTube skipper, SponsorBlock, YouTube CSS
//   bw-sl-<list>    list scriptlets, matched to the hosts that use them
//   bw-ck-<mode>    document.cookie guards per cookie policy
// When the engine cannot run MAIN-world registered scripts (some WebKit
// hosts), the same files are injected on navigation commit instead.

import { LISTS } from '../engine/lists.js';
import { bulwarkScriptlets } from '../engine/scriptlets.js';
import { hostKeys } from '../engine/compiler.js';
import { getSettings, matchPatternsFor, isValidHostname, report, isWhitelisted, hostOf, rawHostOf, cookiePolicyFor } from './state.js';
import * as idb from './idb.js';

export const YT_MATCHES = [
  '*://*.youtube.com/*', '*://youtube.com/*', '*://*.youtube-nocookie.com/*', '*://*.youtubekids.com/*'
];

let meta = null;
let mainWorldFallback = null;
let overlay = null; // host -> entries for scriptlets that arrived with updates

export async function getMeta() {
  if (meta) return meta;
  try {
    const res = await fetch(chrome.runtime.getURL('generated/meta.json'));
    meta = await res.json();
  } catch { meta = { lists: {} }; }
  return meta;
}

// Bundled scriptlet files start with their data table on the first line:
//   (()=>{const T={...}
//   ,E={...}
// so hosts and entries can be read without shipping the data twice.
const SCRIPTLET_PREFIX = '(()=>{const T=';
const tables = new Map();
export async function bundledScriptletTable(id) {
  if (tables.has(id)) return tables.get(id);
  let table = {};
  try {
    const res = await fetch(chrome.runtime.getURL(`generated/scriptlets/${id}.js`));
    if (res.ok) {
      const text = await res.text();
      const nl = text.indexOf('\n');
      if (text.startsWith(SCRIPTLET_PREFIX) && nl > 0) table = JSON.parse(text.slice(SCRIPTLET_PREFIX.length, nl));
    }
  } catch { /* no file: list has no scriptlets */ }
  tables.set(id, table);
  return table;
}

async function scriptletHosts(id) {
  return Object.keys(await bundledScriptletTable(id)).filter(h => !h.endsWith('.*'));
}

function whitelistPatterns(s) {
  return matchPatternsFor(s.whitelist.filter(isValidHostname)).flatMap(p => [p, p.replace('*://*.', '*://')]);
}

async function desiredScripts() {
  const s = await getSettings();
  const exclude = whitelistPatterns(s);
  const out = [];
  const common = { runAt: 'document_start', allFrames: true, persistAcrossSessions: true };
  const withExclude = (o) => (exclude.length ? { ...o, excludeMatches: exclude } : o);

  if (s.enabled) {
    if (s.youtube.prune) out.push(withExclude({ id: 'bw-yt-main', matches: YT_MATCHES, js: ['content/youtube-main.js'], world: 'MAIN', ...common }));
    out.push(withExclude({ id: 'bw-yt-iso', matches: YT_MATCHES, js: ['content/youtube-iso.js'], css: ['content/youtube.css'], ...common }));
    for (const l of LISTS) {
      if (!l.bundled || !s.lists[l.id]) continue;
      const matches = matchPatternsFor(await scriptletHosts(l.id));
      if (!matches.length) continue;
      out.push(withExclude({ id: 'bw-sl-' + l.id, matches, js: [`generated/scriptlets/${l.id}.js`], world: 'MAIN', ...common }));
    }
  }

  // Cookie guards are independent of the ad-blocking whitelist.
  const sites = Object.entries(s.cookies.sites).filter(([h]) => isValidHostname(h));
  for (const mode of ['necessary', 'block']) {
    const file = `generated/cookie-${mode}.js`;
    if (s.cookies.default === mode) {
      const others = matchPatternsFor(sites.filter(([, p]) => p !== mode).map(([h]) => h)).flatMap(p => [p, p.replace('*://*.', '*://')]);
      const o = { id: 'bw-ck-' + mode, matches: ['<all_urls>'], js: [file], world: 'MAIN', ...common };
      if (others.length) o.excludeMatches = others;
      out.push(o);
    } else {
      const matches = matchPatternsFor(sites.filter(([, p]) => p === mode).map(([h]) => h));
      if (matches.length) out.push({ id: 'bw-ck-' + mode, matches, js: [file], world: 'MAIN', ...common });
    }
  }
  return out;
}

function sameRegistration(a, b) {
  const pick = (o) => JSON.stringify([o.matches || [], o.excludeMatches || [], o.js || [], o.css || [], o.world || 'ISOLATED', !!o.allFrames, o.runAt]);
  return pick(a) === pick(b);
}

export async function syncRegistrations() {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) { await setFallback(true); return; }
  const want = await desiredScripts();
  let existing = [];
  try { existing = await chrome.scripting.getRegisteredContentScripts(); } catch (e) { report('scripts', e); }
  const ours = new Map(existing.filter(r => r.id.startsWith('bw-')).map(r => [r.id, r]));
  const wantIds = new Set(want.map(w => w.id));
  const stale = [...ours.keys()].filter(id => !wantIds.has(id));
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale }).catch(e => report('scripts-unregister', e));

  let fallback = false;
  for (const w of want) {
    const cur = ours.get(w.id);
    if (cur && sameRegistration(cur, w)) continue;
    try {
      if (cur && (cur.excludeMatches || []).length && !w.excludeMatches) {
        // updateContentScripts cannot clear a list; re-register instead.
        await chrome.scripting.unregisterContentScripts({ ids: [w.id] });
        await chrome.scripting.registerContentScripts([w]);
      } else if (cur) {
        await chrome.scripting.updateContentScripts([w]);
      } else {
        await chrome.scripting.registerContentScripts([w]);
      }
    } catch (e) {
      if (w.world === 'MAIN') {
        fallback = true;
        report('scripts:' + w.id, 'MAIN-world registration failed (' + e.message + '); using injection fallback');
      } else {
        report('scripts:' + w.id, e);
      }
    }
  }
  await setFallback(fallback);
}

async function setFallback(v) {
  mainWorldFallback = v;
  await chrome.storage.local.set({ mainWorldFallback: v }).catch(() => {});
}
async function getFallback() {
  if (mainWorldFallback === null) {
    const r = await chrome.storage.local.get('mainWorldFallback').catch(() => ({}));
    mainWorldFallback = !!r.mainWorldFallback;
  }
  return mainWorldFallback;
}

// ------------------------------------------- update overlay + fallbacks

export async function loadOverlay() {
  if (!overlay) overlay = (await idb.kv.get('scriptletOverlay')) || {};
  return overlay;
}
export function setOverlay(o) { overlay = o; return idb.kv.set('scriptletOverlay', o); }

function overlayEntries(host, ov) {
  const out = [];
  for (const k of hostKeys(host)) {
    const e = ov[k];
    if (e) out.push(...e);
  }
  return out;
}

// webNavigation.onCommitted: inject scriptlets that are not part of the
// bundled files (list updates, custom filters), and MAIN-world scripts on
// engines without registered MAIN-world support.
export async function onCommitted(details) {
  const { tabId, frameId, url } = details;
  if (tabId < 0 || !/^https?:/.test(url)) return;
  const host = rawHostOf(url);
  const ov = await loadOverlay();
  const entries = overlayEntries(host, ov);
  const fallback = await getFallback();
  if (!entries.length && !fallback) return;
  const s = await getSettings();
  if (!s.enabled) return;
  let topHost = hostOf(url);
  if (frameId !== 0) {
    try { topHost = hostOf((await chrome.tabs.get(tabId)).url || url); } catch { /* ignore */ }
  }
  if (isWhitelisted(topHost, s)) return;
  const target = { tabId, frameIds: [frameId] };

  if (entries.length) {
    chrome.scripting.executeScript({ target, world: 'MAIN', injectImmediately: true, func: bulwarkScriptlets, args: [entries] })
      .catch(e => report('overlay', e));
  }

  if (fallback) {
    const files = [];
    if (s.youtube.prune && /(^|\.)(youtube\.com|youtube-nocookie\.com|youtubekids\.com)$/.test(host)) files.push('content/youtube-main.js');
    for (const l of LISTS) {
      if (!l.bundled || !s.lists[l.id]) continue;
      const hosts = await scriptletHosts(l.id);
      if (hosts.some(h => host === h || host.endsWith('.' + h))) files.push(`generated/scriptlets/${l.id}.js`);
    }
    const policy = cookiePolicyFor(host, s);
    if (policy !== 'allow') files.push(`generated/cookie-${policy}.js`);
    if (files.length) {
      chrome.scripting.executeScript({ target, world: 'MAIN', injectImmediately: true, files })
        .catch(e => report('main-fallback', e));
    }
  }
}

export function fallbackActive() { return !!mainWorldFallback; }
