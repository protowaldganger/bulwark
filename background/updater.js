// Filter list updates.
//
// Bundled lists ship as static rulesets compiled at build time. An update
// downloads the current list, compiles it with the same compiler, and diffs
// it against the bundled snapshot by rule identity hash:
//   removed upstream -> declarativeNetRequest.updateStaticRules(disable)
//   added upstream   -> dynamic rules
// Cosmetic and scriptlet data are replaced wholesale. Runtime-only lists
// (annoyances, user-added URLs) are applied entirely as dynamic rules.

import { LISTS } from '../engine/lists.js';
import { compileList, ruleKey, fnv1a, adaptRuleForSafari } from '../engine/compiler.js';
import { getSettings, report, serial, effective, netPolicy, IS_SAFARI } from './state.js';
import { netFetch } from './net.js';
import { syncListDeltas } from './rules.js';
import { rebuildCosmeticIndex } from './cosmetic.js';
import { setOverlay, getMeta, bundledScriptletTable } from './scripts.js';
import * as idb from './idb.js';

async function fetchText(urls, policy) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const text = await netFetch(url, policy);
      if (text.length < 50 || /^\s*</.test(text)) throw new Error(`Unexpected content from ${url}`);
      return { text, url };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('No URL');
}

// Lightweight per-list status, kept apart from the (large) list records so
// the popup and options page never deserialize compiled list data.
async function setListState(id, st) {
  const all = (await idb.kv.get('listStates')) || {};
  if (st === null) delete all[id]; else all[id] = { ...(all[id] || {}), ...st };
  await idb.kv.set('listStates', all);
}

// Identity hashes of the bundled rules, computed from the ruleset itself
// (rule id N is at index N-1), so no separate hash file has to ship.
async function bundledHashes(id) {
  try {
    const res = await fetch(chrome.runtime.getURL(`rulesets/${id}.json`));
    // Rule id N must map to index N-1; adapted rulesets can have gaps.
    const out = [];
    for (const r of await res.json()) out[r.id - 1] = ruleKey(r);
    return out;
  } catch { return []; }
}

async function allBadfilters(exceptId) {
  const meta = await getMeta();
  const set = new Set();
  for (const [id, m] of Object.entries(meta.lists || {})) if (id !== exceptId) for (const b of m.badfilters || []) set.add(b);
  const recs = await idb.getAll('lists');
  for (const [id, r] of Object.entries(recs)) if (id !== exceptId && r && r.badfilters) for (const b of r.badfilters) set.add(b);
  return set;
}

export async function updateOne(def, force) {
  const prev = await idb.get('lists', def.id);
  const { text, url } = await fetchText(def.urls || [def.url], netPolicy(await getSettings()));
  const hash = fnv1a(text);
  if (!force && prev && prev.hash === hash) {
    await idb.put('lists', def.id, { ...prev, checkedAt: Date.now(), error: null });
    await setListState(def.id, { checkedAt: Date.now(), error: null });
    return { id: def.id, unchanged: true };
  }
  const t0 = performance.now();
  const compiled = compileList(text, { badfilters: await allBadfilters(def.id) });
  const compileMs = Math.round(performance.now() - t0);
  // Tamper and truncation guard: refuse an update that suddenly loses most
  // of a bundled list, instead of silently weakening protection.
  const meta = await getMeta();
  const base = meta.lists[def.id] && meta.lists[def.id].filters;
  if (def.bundled && base && compiled.stats.network + compiled.stats.cosmetic < base * 0.5) {
    throw new Error('Downloaded list is less than half its usual size; update rejected');
  }
  const record = {
    id: def.id, hash, url, updatedAt: Date.now(), checkedAt: Date.now(), error: null,
    cosmetic: compiled.cosmetic, scriptlets: compiled.scriptlets, badfilters: compiled.badfilters,
    stats: { ...compiled.stats, compileMs }
  };
  if (def.bundled) {
    const old = await bundledHashes(def.id);
    // The Safari build ships adapted rules, so compare like with like.
    const freshRules = IS_SAFARI ? compiled.rules.map(adaptRuleForSafari).filter(Boolean) : compiled.rules;
    const fresh = new Map();
    for (const r of freshRules) fresh.set(ruleKey(r), r);
    const oldSet = new Set(old);
    record.disableIds = [];
    old.forEach((h, i) => { if (!fresh.has(h)) record.disableIds.push(i + 1); });
    record.addRules = [];
    for (const [h, r] of fresh) if (!oldSet.has(h)) { const { id, ...rest } = r; void id; record.addRules.push(rest); }
    record.stats.delta = { added: record.addRules.length, removed: record.disableIds.length };
  } else {
    record.addRules = compiled.rules.map(({ id, ...rest }) => { void id; return rest; });
  }
  await idb.put('lists', def.id, record);
  await setListState(def.id, { updatedAt: record.updatedAt, checkedAt: record.checkedAt, error: null, stats: record.stats, delta: record.stats.delta || null });
  return { id: def.id, updated: true, stats: record.stats };
}

// Recomputes scriptlets that the bundled files do not already cover.
export async function rebuildOverlay() {
  const s = await getSettings();
  const overlay = {};
  const addAll = (table, skip) => {
    for (const [host, entries] of Object.entries(table || {})) {
      for (const e of entries) {
        const key = JSON.stringify(e);
        if (skip && skip.has(host + key)) continue;
        (overlay[host] || (overlay[host] = [])).push(e);
      }
    }
  };
  for (const l of LISTS) {
    if (!s.lists[l.id]) continue;
    const rec = await idb.get('lists', l.id);
    if (l.bundled) {
      // Registered files cover the bundled non-entity hosts; everything
      // else (entity hosts, new entries from updates) goes in the overlay.
      const bundled = await bundledScriptletTable(l.id);
      const skip = new Set();
      for (const [host, entries] of Object.entries(bundled)) {
        if (host.endsWith('.*')) continue;
        for (const e of entries) skip.add(host + JSON.stringify(e));
      }
      addAll(rec && rec.scriptlets ? rec.scriptlets : bundled, skip);
    } else if (rec && rec.scriptlets) addAll(rec.scriptlets);
  }
  for (const c of s.customLists) {
    if (!c.enabled) continue;
    const rec = await idb.get('lists', c.id);
    if (rec) addAll(rec.scriptlets);
  }
  const custom = await idb.get('lists', '__custom__');
  if (custom) addAll(custom.scriptlets);
  await setOverlay(overlay);
}

export function updateLists({ force = false, ids = null } = {}) {
  return serial(async () => {
    const s = await getSettings();
    const defs = [
      ...LISTS.filter(l => s.lists[l.id]),
      ...s.customLists.filter(c => c.enabled).map(c => ({ ...c, urls: [c.url], bundled: false }))
    ].filter(d => !ids || ids.includes(d.id));
    const results = [];
    for (const d of defs) {
      try { results.push(await updateOne(d, force)); }
      catch (e) {
        report('update:' + d.id, e);
        const prev = (await idb.get('lists', d.id)) || { id: d.id };
        await idb.put('lists', d.id, { ...prev, checkedAt: Date.now(), error: String(e.message || e) });
        await setListState(d.id, { checkedAt: Date.now(), error: String(e.message || e) });
        results.push({ id: d.id, error: String(e.message || e) });
      }
    }
    const changed = results.some(r => r.updated);
    let applied = null;
    if (changed || force) {
      applied = await syncListDeltas();
      await rebuildOverlay();
    }
    await chrome.storage.local.set({ lastUpdate: { at: Date.now(), results } });
    // rebuildCosmeticIndex uses serial() itself; run it after this task.
    if (changed || force) queueMicrotask(() => rebuildCosmeticIndex().catch(e => report('cosmetic', e)));
    return { results, applied };
  });
}

export async function listStates() {
  return (await idb.kv.get('listStates')) || {};
}

export async function forgetList(id) {
  await idb.del('lists', id);
  await setListState(id, null);
}

export function scheduleUpdates(settings) {
  chrome.alarms.clear('bw-update');
  if (!effective(settings).autoUpdate) return;
  const period = Math.max(1, settings.update.intervalHours) * 60;
  chrome.alarms.create('bw-update', { delayInMinutes: Math.min(period, 30), periodInMinutes: period });
}
