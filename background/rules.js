// declarativeNetRequest management: static rulesets, system rules
// (whitelist, pause, cookies), user rules and list update deltas.

import { LISTS, YT_RULESET } from '../engine/lists.js';
import { PRIORITY, compileCustom, validateRule, adaptRuleForSafari } from '../engine/compiler.js';
import { TRACKER_COOKIE_DOMAINS, ENTITY_GROUPS } from '../engine/cookies.js';
import { getSettings, getCustomFilters, report, isValidHostname, isWhitelisted, IS_SAFARI } from './state.js';
import * as idb from './idb.js';
import { ID, dynamicState } from './ids.js';

const DNR = chrome.declarativeNetRequest;

export { ID };

export const LIMITS = {
  dynamic: DNR.MAX_NUMBER_OF_DYNAMIC_RULES || DNR.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES || 5000,
  unsafe: DNR.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES || 5000,
  regex: DNR.MAX_NUMBER_OF_REGEX_RULES || 1000,
  disabledStatic: 5000
};
const CUSTOM_CAP = 5000;

const COOKIE_HEADERS = {
  type: 'modifyHeaders',
  requestHeaders: [{ header: 'cookie', operation: 'remove' }],
  responseHeaders: [{ header: 'set-cookie', operation: 'remove' }]
};
const SUB_TYPES = ['sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'];

// ------------------------------------------------------------- helpers

async function dynamicRules() {
  try { return await DNR.getDynamicRules(); } catch (e) { report('dnr', e); return []; }
}

// Adds rules in batches. If Chrome rejects a batch (one invalid rule fails
// the whole call), the batch is split until the bad rule is isolated.
export async function safeUpdateDynamic(removeRuleIds, addRules) {
  dynamicState.version++;
  if (IS_SAFARI) addRules = addRules.map(adaptRuleForSafari).filter(Boolean);
  if (removeRuleIds.length) {
    try { await DNR.updateDynamicRules({ removeRuleIds }); }
    catch (e) { report('dnr-remove', e); }
  }
  let added = 0, rejected = 0;
  const attempt = async (batch) => {
    if (!batch.length) return;
    try {
      await DNR.updateDynamicRules({ addRules: batch });
      added += batch.length;
    } catch (e) {
      if (batch.length === 1) { rejected++; report('dnr-rule', `${e.message} (rule ${JSON.stringify(batch[0]).slice(0, 200)})`); return; }
      const mid = batch.length >> 1;
      await attempt(batch.slice(0, mid));
      await attempt(batch.slice(mid));
    }
  };
  for (let i = 0; i < addRules.length; i += 2000) await attempt(addRules.slice(i, i + 2000));
  return { added, rejected };
}

function idsInRange(rules, lo, hi) {
  return rules.filter(r => r.id >= lo && r.id < hi).map(r => r.id);
}

// ------------------------------------------------------ static rulesets

export async function syncStaticRulesets() {
  const s = await getSettings();
  const want = new Set();
  for (const l of LISTS) if (l.bundled && s.lists[l.id]) want.add(l.id);
  if (s.youtube.blockPings) want.add(YT_RULESET);
  const current = new Set(await DNR.getEnabledRulesets());
  const manifestIds = new Set((chrome.runtime.getManifest().declarative_net_request?.rule_resources || []).map(r => r.id));
  const enableRulesetIds = [...want].filter(id => !current.has(id) && manifestIds.has(id));
  const disableRulesetIds = [...current].filter(id => !want.has(id));
  if (!enableRulesetIds.length && !disableRulesetIds.length) return { ok: true };
  try {
    await DNR.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
    return { ok: true };
  } catch (e) {
    // Most likely the global static rule pool is exhausted by other
    // extensions. Enable what fits, in catalog order (most valuable first).
    report('rulesets', e);
    if (disableRulesetIds.length) await DNR.updateEnabledRulesets({ disableRulesetIds }).catch(() => {});
    const failed = [];
    for (const id of [YT_RULESET, ...enableRulesetIds.filter(i => i !== YT_RULESET)]) {
      if (!enableRulesetIds.includes(id)) continue;
      try { await DNR.updateEnabledRulesets({ enableRulesetIds: [id] }); }
      catch { failed.push(id); }
    }
    return { ok: failed.length === 0, failed };
  }
}

// ---------------------------------------------------------- system rules

export function buildSystemRules(s) {
  const rules = [];
  const wl = s.whitelist.filter(isValidHostname);
  if (wl.length) {
    rules.push({
      id: ID.whitelist, priority: PRIORITY.whitelist,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: wl, resourceTypes: ['main_frame', 'sub_frame'] }
    });
  }
  if (!s.enabled) {
    rules.push({
      id: ID.pause, priority: PRIORITY.whitelist,
      action: { type: 'allowAllRequests' },
      condition: { resourceTypes: ['main_frame', 'sub_frame'] }
    });
  }

  // YouTube page loads ask for the ad-free variant of the video (pp=eAE=,
  // see content/youtube-main.js). A pp parameter that a link already
  // carries (search and recommendation tracking) is replaced; the allow
  // rule stops the redirect once the URL has ours.
  if (s.enabled && s.youtube.prune && s.youtube.adFree && !isWhitelisted('www.youtube.com', s)) {
    rules.push({
      id: ID.ytAdFreeAllow, priority: PRIORITY.whitelist - 1,
      action: { type: 'allow' },
      condition: { regexFilter: '^https://(www\\.)?youtube\\.com/watch\\?([^#]*&)?pp=eAE[%=]', resourceTypes: ['main_frame'] }
    });
    rules.push({
      id: ID.ytAdFree, priority: PRIORITY.whitelist - 2,
      action: { type: 'redirect', redirect: { transform: { queryTransform: { addOrReplaceParams: [{ key: 'pp', value: 'eAE=' }] } } } },
      condition: { regexFilter: '^https://(www\\.)?youtube\\.com/watch\\?', resourceTypes: ['main_frame'] }
    });
  }

  // Third-party tracker cookies: always stripped.
  rules.push({
    id: ID.cookieTrackers, priority: PRIORITY.cookies, action: COOKIE_HEADERS,
    condition: { requestDomains: TRACKER_COOKIE_DOMAINS, domainType: 'thirdParty', resourceTypes: SUB_TYPES }
  });

  const sitePolicies = Object.entries(s.cookies.sites).filter(([h]) => isValidHostname(h));
  const allowSites = sitePolicies.filter(([, p]) => p === 'allow').map(([h]) => h);
  const blockSites = sitePolicies.filter(([, p]) => p === 'block').map(([h]) => h);
  const entityDomains = ENTITY_GROUPS.flat();

  if (s.cookies.blockThirdParty) {
    // All other third-party cookies, except on "Allow all" sites and inside
    // an entity group (handled by the per-group rules below).
    const excluded = [...new Set([...allowSites, ...entityDomains])];
    rules.push({
      id: ID.cookieThirdParty, priority: PRIORITY.cookies, action: COOKIE_HEADERS,
      condition: { domainType: 'thirdParty', resourceTypes: SUB_TYPES, excludedInitiatorDomains: excluded }
    });
    ENTITY_GROUPS.forEach((group, i) => {
      const initiators = group.filter(d => !allowSites.includes(d));
      if (!initiators.length) return;
      rules.push({
        id: ID.cookieEntityBase + i, priority: PRIORITY.cookies, action: COOKIE_HEADERS,
        condition: { domainType: 'thirdParty', resourceTypes: SUB_TYPES, initiatorDomains: initiators, excludedRequestDomains: group }
      });
    });
  }

  if (s.cookies.default === 'block' || blockSites.length) {
    // "Block all": no cookie leaves or enters the browser for these sites.
    const cond = { resourceTypes: ['main_frame', ...SUB_TYPES] };
    if (s.cookies.default === 'block') {
      const exempt = sitePolicies.filter(([, p]) => p !== 'block').map(([h]) => h);
      if (exempt.length) cond.excludedRequestDomains = exempt;
    } else {
      cond.requestDomains = blockSites;
    }
    rules.push({ id: ID.cookieBlockSites, priority: PRIORITY.cookies, action: COOKIE_HEADERS, condition: cond });
  }
  return rules;
}

export async function syncSystemRules() {
  const s = await getSettings();
  const rules = buildSystemRules(s);
  const existing = await dynamicRules();
  const remove = idsInRange(existing, 1, ID.customBase);
  // Cookie rules may be unsupported on some engines (e.g. WebKit hosts);
  // add them separately so the whitelist always lands.
  const core = rules.filter(r => r.id < ID.cookieTrackers);
  const cookie = rules.filter(r => r.id >= ID.cookieTrackers);
  await safeUpdateDynamic(remove, core);
  await safeUpdateDynamic([], cookie);
}

// ----------------------------------------------------------- user rules

function remapCustomPriority(rule) {
  const t = rule.action.type;
  if (t === 'allow' || t === 'allowAllRequests') rule.priority = PRIORITY.customAllow;
  else if (t === 'block' || (t === 'redirect' && rule.action.redirect.extensionPath)) rule.priority = PRIORITY.customBlock;
  return rule;
}

export async function syncCustomRules() {
  const text = await getCustomFilters();
  const compiled = compileCustom(text, ID.customBase);
  const rules = compiled.rules.slice(0, CUSTOM_CAP).map(remapCustomPriority);
  const existing = await dynamicRules();
  const remove = idsInRange(existing, ID.customBase, ID.listBase);
  const res = await safeUpdateDynamic(remove, rules);
  await idb.put('lists', '__custom__', {
    id: '__custom__', cosmetic: compiled.cosmetic, scriptlets: compiled.scriptlets,
    stats: { ...compiled.stats, network: rules.length, rejected: res.rejected }
  });
  return { ...compiled.stats, rejected: res.rejected, truncated: compiled.rules.length > CUSTOM_CAP };
}

// ------------------------------------------------------ list deltas

// Applies list update records stored in IndexedDB:
//  - bundled lists: disable static rules that were removed upstream and
//    add new rules as dynamic rules
//  - runtime-only lists: all their rules are dynamic
export async function syncListDeltas() {
  const s = await getSettings();
  const existing = await dynamicRules();
  const nonList = existing.filter(r => r.id < ID.listBase);
  let budget = Math.max(0, LIMITS.dynamic - nonList.length - 50);
  let unsafeBudget = Math.max(0, LIMITS.unsafe - nonList.filter(isUnsafe).length - 20);
  let regexBudget = Math.max(0, LIMITS.regex - nonList.filter(r => r.condition.regexFilter).length - 10);
  const add = [];
  const summary = {};

  const allLists = [...LISTS, ...s.customLists.map(c => ({ ...c, bundled: false, custom: true }))];
  for (let i = 0; i < allLists.length; i++) {
    const l = allLists[i];
    const enabled = l.custom ? l.enabled : s.lists[l.id];
    const rec = await idb.get('lists', l.id);

    if (l.bundled) {
      // Static rule toggles persist even while the ruleset is disabled.
      const want = enabled && rec ? (rec.disableIds || []).slice(0, LIMITS.disabledStatic) : [];
      try {
        const cur = DNR.getDisabledRuleIds ? await DNR.getDisabledRuleIds({ rulesetId: l.id }) : [];
        const wantSet = new Set(want), curSet = new Set(cur);
        const enableRuleIds = cur.filter(id => !wantSet.has(id));
        const disableRuleIds = want.filter(id => !curSet.has(id));
        if ((enableRuleIds.length || disableRuleIds.length) && DNR.updateStaticRules) {
          await DNR.updateStaticRules({ rulesetId: l.id, enableRuleIds, disableRuleIds });
        }
      } catch (e) { report('static-delta:' + l.id, e); }
    }
    if (!enabled || !rec || !rec.addRules) continue;

    let n = 0, dropped = 0;
    const base = ID.listBase + i * 100000;
    for (const r of rec.addRules) {
      if (n >= 99999 || budget <= 0) { dropped++; continue; }
      const unsafe = isUnsafe(r);
      if (unsafe && unsafeBudget <= 0) { dropped++; continue; }
      if (r.condition.regexFilter && regexBudget <= 0) { dropped++; continue; }
      const rule = { ...r, id: base + n };
      if (validateRule(rule)) { dropped++; continue; }
      add.push(rule);
      n++; budget--;
      if (unsafe) unsafeBudget--;
      if (r.condition.regexFilter) regexBudget--;
    }
    summary[l.id] = { added: n, dropped };
  }

  const remove = existing.filter(r => r.id >= ID.listBase).map(r => r.id);
  const res = await safeUpdateDynamic(remove, add);
  return { summary, ...res };
}

function isUnsafe(r) {
  return r.action.type === 'redirect' || r.action.type === 'modifyHeaders';
}

// --------------------------------------------------------- diagnostics

export async function ruleStats() {
  const out = { enabledRulesets: [], dynamic: 0, availableStatic: null, limits: LIMITS };
  try { out.enabledRulesets = await DNR.getEnabledRulesets(); } catch { /* ignore */ }
  try { out.dynamic = (await DNR.getDynamicRules()).length; } catch { /* ignore */ }
  try { if (DNR.getAvailableStaticRuleCount) out.availableStatic = await DNR.getAvailableStaticRuleCount(); } catch { /* ignore */ }
  out.canTest = typeof DNR.testMatchOutcome === 'function';
  return out;
}

export async function testUrl(url, initiator, type) {
  if (typeof DNR.testMatchOutcome !== 'function') return { unsupported: true };
  const req = { url, type: type || 'script', tabId: -1 };
  if (initiator) req.initiator = initiator;
  const res = await DNR.testMatchOutcome(req);
  return { matched: res.matchedRules };
}
