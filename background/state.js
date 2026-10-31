// Settings, shared helpers and a serial task queue.

import { LISTS } from '../engine/lists.js';

export const VERSION = chrome.runtime.getManifest().version;

// The Safari build defines __BW_SAFARI__; the user agent check covers the
// unbundled source loaded in Safari.
/* global __BW_SAFARI__ */
export const IS_SAFARI = (typeof __BW_SAFARI__ !== 'undefined' && __BW_SAFARI__ === true) ||
  (typeof navigator !== 'undefined' && /^((?!chrome|chromium|crios|edg|android).)*safari/i.test(navigator.userAgent || ''));

export const DEFAULT_SETTINGS = {
  schema: 2,
  enabled: true,
  // Strict privacy: Bulwark makes no network request unless you click a
  // button for it, SponsorBlock stays off, and no per-site history is kept.
  privacy: { strict: true },
  lists: Object.fromEntries(LISTS.map(l => [l.id, l.enabledByDefault])),
  customLists: [],              // [{ id, name, url, enabled }]
  whitelist: [],                // hostnames where blocking is off
  youtube: {
    prune: true,                // MAIN-world ad payload pruning
    adFree: true,               // ask YouTube for the ad-free variant (no start-up wait)
    skipper: true,              // fallback ad skipper
    blockPings: true,           // bundled YouTube network ruleset
    sponsorblock: false,
    sbCategories: ['sponsor'],
    sbToast: true,
    hideShorts: false,
    hideMerch: true,
    hidePromos: true,
    hideEndCards: false
  },
  cookies: {
    default: 'necessary',       // 'block' | 'necessary' | 'allow'
    sites: {},                  // host -> policy
    blockThirdParty: true,
    rules: []                   // [{ domain, names }] extra necessary cookies
  },
  cosmetic: { generic: true },
  update: { auto: true, intervalHours: 24 },
  ui: { badge: true },
  stats: { detailed: true }
};

let cached = null;
let loading = null;

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

export function deepMerge(base, patch) {
  if (!isObj(patch)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && isObj(out[k]) && k !== 'sites') out[k] = deepMerge(out[k], v);
    else out[k] = structuredClone(v);
  }
  return out;
}

export async function getSettings() {
  if (cached) return cached;
  if (!loading) {
    loading = chrome.storage.local.get('settings').then(({ settings }) => {
      cached = deepMerge(DEFAULT_SETTINGS, settings || {});
      // New lists added in an update get their default state.
      for (const l of LISTS) if (!(l.id in cached.lists)) cached.lists[l.id] = l.enabledByDefault;
      loading = null;
      return cached;
    });
  }
  return loading;
}

export async function saveSettings(next) {
  cached = next;
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function patchSettings(patch) {
  const cur = await getSettings();
  return saveSettings(deepMerge(cur, patch));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    cached = changes.settings.newValue ? deepMerge(DEFAULT_SETTINGS, changes.settings.newValue) : null;
  }
});

// Effective behaviour after strict privacy is applied.
export function effective(s) {
  const strict = !!s.privacy.strict;
  return {
    strict,
    autoUpdate: !strict && s.update.auto,
    sponsorblock: !strict && s.youtube.sponsorblock,
    keepHistory: !strict
  };
}

export function netPolicy(s) {
  return { customUrls: s.customLists.map(c => c.url), sponsorblock: effective(s).sponsorblock };
}

export async function getCustomFilters() {
  const { customFilters } = await chrome.storage.local.get('customFilters');
  return customFilters || '';
}

// ----------------------------------------------------------- host helpers

export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.replace(/^www\./, '').replace(/\.$/, '');
  } catch { return ''; }
}

export function rawHostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

const TWO_LEVEL = /^(co|com|net|org|gov|ac|edu|ne|or|go|gob|mil|nic)$/;
// Approximate registrable domain without shipping the public suffix list.
export function siteOf(host) {
  const p = host.split('.');
  if (p.length <= 2) return host;
  if (/^\d+$/.test(p[p.length - 1])) return host; // IPv4
  const twoLevel = p[p.length - 1].length === 2 && TWO_LEVEL.test(p[p.length - 2]);
  return p.slice(twoLevel ? -3 : -2).join('.');
}

export function hostChain(host) {
  const out = [];
  const p = host.split('.');
  for (let i = 0; i < p.length - 1; i++) out.push(p.slice(i).join('.'));
  if (!out.length && host) out.push(host);
  return out;
}

export function isWhitelisted(host, settings) {
  if (!host) return false;
  const list = settings.whitelist;
  if (!list.length) return false;
  for (const h of hostChain(host)) if (list.includes(h)) return true;
  return false;
}

export function cookiePolicyFor(host, settings) {
  const sites = settings.cookies.sites;
  for (const h of hostChain(host)) if (sites[h]) return sites[h];
  return settings.cookies.default;
}

export function isValidHostname(h) {
  return typeof h === 'string' && h.length < 254 && /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)+$/.test(h);
}

export function matchPatternsFor(hosts) {
  const out = [];
  for (const h of hosts) if (isValidHostname(h)) out.push(`*://*.${h}/*`);
  return out;
}

// ------------------------------------------------------------ task queue

let tail = Promise.resolve();
export function serial(fn) {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}

// ------------------------------------------------------------- diagnostics

const diag = [];
export function report(area, err) {
  const msg = err && err.message ? err.message : String(err);
  diag.unshift({ at: Date.now(), area, msg });
  if (diag.length > 30) diag.length = 30;
  console.warn('[Bulwark]', area, msg);
}
export function diagnostics() { return diag.slice(); }
