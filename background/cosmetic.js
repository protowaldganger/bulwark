// Cosmetic filtering, service-worker side.
//
// Index layout (IndexedDB):
//   spec/<host>   { h: hide[], x: except[], s: style rules[], p: procedural[], px: [], j: [], f: flags }
//   gen/<token>   [selectors]   lowly generic, keyed by a class or id
//   kv/hg         [selectors]   highly generic (always applied)
//   kv/tokens     [tokens]      keys present in gen/
//
// CSS for a frame is injected at navigation commit (before the content
// script runs); the content script then sends class/id tokens as they
// appear. Injection uses scripting.insertCSS at user origin, so the page
// cannot see or override it and no DOM nodes are added.

import { LISTS } from '../engine/lists.js';
import { mergeCosmetic, unpackCosmetic, hostKeys, isYouTubeHost } from '../engine/compiler.js';
import { getSettings, isWhitelisted, hostOf, rawHostOf, report, serial } from './state.js';
import * as idb from './idb.js';

const HIDE = '{display:none!important}';
let tokenSet = null;           // Set of generic tokens
let hgCss = null;              // highly generic selectors (array)
let custom = null;             // custom-filter cosmetic object (small, in memory)

async function bundledCosmetic(id) {
  try {
    const res = await fetch(chrome.runtime.getURL(`generated/cosmetic/${id}.json`));
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Raw rebuild; call it from inside a serial() task.
export async function buildCosmeticIndex() {
  {
    const t0 = performance.now();
    const s = await getSettings();
    const parts = [];
    const lists = [...LISTS, ...s.customLists.map(c => ({ ...c, bundled: false, custom: true }))];
    for (const l of lists) {
      const on = l.custom ? l.enabled : s.lists[l.id];
      if (!on) continue;
      const rec = await idb.get('lists', l.id);
      if (rec && rec.cosmetic) parts.push(rec.cosmetic);
      else if (l.bundled) parts.push(await bundledCosmetic(l.id));
    }
    const merged = mergeCosmetic(parts);
    await idb.replaceAll('spec', merged.spec);
    await idb.replaceAll('gen', merged.gen);
    await idb.kv.set('hg', merged.hg);
    await idb.kv.set('tokens', Object.keys(merged.gen));
    tokenSet = new Set(Object.keys(merged.gen));
    hgCss = merged.hg;
    custom = null;
    plans.clear();
    const ms = Math.round(performance.now() - t0);
    await idb.kv.set('cosmeticBuild', { at: Date.now(), ms, hosts: Object.keys(merged.spec).length, tokens: tokenSet.size, hg: hgCss.length });
    return { ms };
  }
}

// Queued rebuild; never call this from inside a serial() task.
export function rebuildCosmeticIndex() {
  return serial(buildCosmeticIndex);
}

async function ensureLoaded() {
  if (!tokenSet) {
    const [tokens, hg] = await idb.getMany('kv', ['tokens', 'hg']);
    tokenSet = new Set(tokens || []);
    hgCss = hg || [];
  }
  if (!custom) {
    const rec = await idb.get('lists', '__custom__');
    custom = unpackCosmetic(rec && rec.cosmetic) || { spec: {}, gen: {}, hg: [] };
  }
}

export function invalidateCustomCosmetic() { custom = null; plans.clear(); }

// Merged host record for a hostname (all parent domains and entities).
async function hostRecord(host) {
  await ensureLoaded();
  const keys = hostKeys(host);
  const recs = await idb.getMany('spec', keys);
  const out = { h: new Set(), x: new Set(), s: new Set(), p: [], px: new Set(), f: 0 };
  const add = (e) => {
    if (!e) return;
    if (e.h) for (const v of e.h) out.h.add(v);
    if (e.x) for (const v of e.x) out.x.add(v);
    if (e.s) for (const v of e.s) out.s.add(v);
    if (e.p) out.p.push(...e.p);
    if (e.px) for (const v of e.px) out.px.add(v);
    if (e.f) out.f |= e.f;
  };
  recs.forEach(add);
  for (const k of keys) add(custom.spec[k]);
  return out;
}

function youtubeExtras(yt) {
  const sels = [];
  if (yt.hideShorts) sels.push('ytd-reel-shelf-renderer', 'ytd-rich-shelf-renderer[is-shorts]', 'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])',
    'ytd-guide-entry-renderer:has(a[title="Shorts"])', 'ytd-mini-guide-entry-renderer[aria-label="Shorts"]', 'grid-shelf-view-model:has(ytm-shorts-lockup-view-model)',
    'ytd-video-renderer:has(a[href^="/shorts/"])', 'ytm-reel-shelf-renderer');
  if (yt.hideMerch) sels.push('ytd-merch-shelf-renderer', 'ytd-ticket-shelf-renderer', 'ytd-product-details-renderer');
  if (yt.hidePromos) sels.push('ytd-mealbar-promo-renderer', 'ytd-primetime-promo-renderer', 'ytd-brand-video-singleton-renderer',
    'ytd-brand-video-shelf-renderer', 'tp-yt-paper-dialog:has(> ytd-mealbar-promo-renderer)', 'ytd-popup-container yt-mealbar-promo-renderer');
  if (yt.hideEndCards) sels.push('.ytp-ce-element', '.ytp-endscreen-content', '.ytp-cards-teaser');
  return sels;
}

// ------------------------------------------------------------ planning
//
// A "plan" is everything a host needs: the CSS string, whether generic
// filters apply, procedural filters and exceptions. Plans are cached per
// host (LRU) and dropped whenever filters or settings change.

const PLAN_CACHE_MAX = 400;
const plans = new Map();
export function clearPlans() { plans.clear(); }
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.settings) plans.clear(); });

async function planFor(host, s) {
  const hit = plans.get(host);
  if (hit) { plans.delete(host); plans.set(host, hit); return hit; }
  const rec = await hostRecord(host);
  let plan;
  if (rec.f & 1) plan = { off: true };
  else {
    const selectors = [];
    if (!(rec.f & 4)) for (const sel of rec.h) if (!rec.x.has(sel)) selectors.push(sel);
    const yt = isYouTubeHost(host);
    if (yt) selectors.push(...youtubeExtras(s.youtube));
    const generic = !(rec.f & 2) && s.cosmetic.generic && !yt;
    if (generic) {
      for (const sel of hgCss) if (!rec.x.has(sel)) selectors.push(sel);
      for (const sel of custom.hg || []) if (!rec.x.has(sel)) selectors.push(sel);
    }
    // One rule per selector: a single selector Chrome cannot parse then
    // only drops itself, never a whole group.
    let css = toCss(selectors);
    if (!(rec.f & 4)) for (const st of rec.s) css += st + '\n';
    plan = {
      css, selectors, generic, except: rec.x,
      proc: (rec.f & 4) ? [] : rec.p.filter(p => !rec.px.has(JSON.stringify(p)))
    };
  }
  plans.set(host, plan);
  if (plans.size > PLAN_CACHE_MAX) plans.delete(plans.keys().next().value);
  return plan;
}

function toCss(selectors) {
  let css = '';
  for (const sel of selectors) css += sel + HIDE + '\n';
  return css;
}

// Older Safari versions reject the `origin` option; remember and drop it.
let cssOrigin = true;
async function insert(target, css) {
  if (!css) return true;
  try {
    await chrome.scripting.insertCSS(cssOrigin ? { target, css, origin: 'USER' } : { target, css });
    return true;
  } catch (e) {
    if (cssOrigin && /origin/i.test(String(e && e.message))) { cssOrigin = false; return insert(target, css); }
    if (target.documentIds) return false; // document gone, not ready, or unsupported
    report('insertCSS', e);
    return false;
  }
}

// ------------------------------------------------------------- frames

const frames = new Map(); // `${tabId}:${frameId}` -> { doc, host, plan, applied:Set, injected:Promise }

export function forgetTab(tabId) {
  const prefix = tabId + ':';
  for (const k of frames.keys()) if (k.startsWith(prefix)) frames.delete(k);
}

function frameState(tabId, frameId, doc, host, plan) {
  const st = { doc, host, plan, applied: new Set(plan.selectors || []), injected: null };
  frames.set(`${tabId}:${frameId}`, st);
  return st;
}

async function activeFor(url, topUrl, s) {
  const host = rawHostOf(url);
  if (!s.enabled || !host) return null;
  if (isWhitelisted(hostOf(topUrl || url) || hostOf(url), s)) return null;
  return host;
}

// webNavigation.onCommitted: inject the frame's CSS as soon as the document
// exists, before the content script has even started.
export async function prepareFrame(d) {
  if (d.tabId < 0 || !/^https?:/.test(d.url)) return;
  const s = await getSettings();
  let topUrl = d.url;
  if (d.frameId !== 0) {
    try { topUrl = (await chrome.tabs.get(d.tabId)).url || d.url; } catch { return; }
  }
  const host = await activeFor(d.url, topUrl, s);
  if (!host) { frames.delete(`${d.tabId}:${d.frameId}`); return; }
  const plan = await planFor(host, s);
  if (plan.off) return;
  const st = frameState(d.tabId, d.frameId, d.documentId || null, host, plan);
  const target = d.documentId ? { tabId: d.tabId, documentIds: [d.documentId] } : { tabId: d.tabId, frameIds: [d.frameId] };
  st.injected = insert(target, plan.css);
}

// First message from each frame's content script.
export async function frameInit(sender, msg) {
  const tab = sender.tab;
  if (!tab) return { on: false };
  const frameId = sender.frameId || 0;
  const s = await getSettings();
  const host = await activeFor(msg.url, frameId === 0 ? msg.url : tab.url, s);
  if (!host) return { on: false };
  let st = frames.get(`${tab.id}:${frameId}`);
  const sameDoc = st && st.host === host && (!st.doc || !sender.documentId || st.doc === sender.documentId);
  if (!sameDoc || !(await st.injected)) {
    // Not prepared at commit (worker was asleep, or the frame was
    // created without a navigation): inject now.
    const plan = await planFor(host, s);
    if (plan.off) return { on: false };
    st = frameState(tab.id, frameId, sender.documentId || null, host, plan);
    const target = sender.documentId ? { tabId: tab.id, documentIds: [sender.documentId] } : { tabId: tab.id, frameIds: [frameId] };
    st.injected = insert(target, plan.css);
    if (!(await st.injected) && target.documentIds) await insert({ tabId: tab.id, frameIds: [frameId] }, plan.css);
  }
  if (st.plan.off) return { on: false };
  return { on: true, generic: st.plan.generic, proc: st.plan.proc };
}

// Generic class/id tokens seen in a frame.
export async function genericTokens(sender, msg) {
  if (!sender.tab || !Array.isArray(msg.tokens)) return null;
  await ensureLoaded();
  const key = `${sender.tab.id}:${sender.frameId || 0}`;
  let st = frames.get(key);
  if (!st) {
    // Worker restarted since frame-init: rebuild from the host plan.
    const host = rawHostOf(msg.url);
    if (!host) return null;
    st = frameState(sender.tab.id, sender.frameId || 0, sender.documentId || null, host, await planFor(host, await getSettings()));
  }
  if (!st.plan.generic) return null;
  const lookup = [];
  const sels = [];
  for (const t of msg.tokens) {
    if (typeof t !== 'string') continue;
    if (tokenSet.has(t)) lookup.push(t);
    const c = custom.gen[t];
    if (c) sels.push(...c);
  }
  if (!lookup.length && !sels.length) return null;
  for (const list of await idb.getMany('gen', lookup)) if (list) sels.push(...list);
  const fresh = [];
  for (const sel of sels) {
    if (st.applied.has(sel) || st.plan.except.has(sel)) continue;
    st.applied.add(sel);
    fresh.push(sel);
  }
  if (fresh.length) {
    const target = sender.documentId ? { tabId: sender.tab.id, documentIds: [sender.documentId] } : { tabId: sender.tab.id, frameIds: [sender.frameId || 0] };
    await insert(target, toCss(fresh));
  }
  return null;
}

// Selectors applied in a tab's top frame, for the popup's element count.
export function appliedSelectors(tabId) {
  const st = frames.get(`${tabId}:0`);
  return st ? [...st.applied] : [];
}

// Immediate CSS for a filter the user just created with the picker.
export async function applyNow(tabId, frameId, selector) {
  plans.clear();
  await insert({ tabId, frameIds: [frameId || 0] }, selector + HIDE);
}

export async function indexInfo() {
  return idb.kv.get('cosmeticBuild');
}
