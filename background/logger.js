// Request log: what Bulwark's rules did in each tab. Fed by
// declarativeNetRequest.onRuleMatchedDebug, which Chrome only provides to
// unpacked installs. Kept in memory per tab, never stored, and dropped
// when the tab closes.

import { ID } from './ids.js';

const MAX = 1000;
const logs = new Map(); // tabId -> { seq, entries: [] }
let seq = 0;

function forTab(tabId) {
  let l = logs.get(tabId);
  if (!l) { l = { entries: [] }; logs.set(tabId, l); }
  return l;
}

export function logMatch(info) {
  const { request, rule } = info;
  if (request.tabId < 0) return;
  // Global Privacy Control touches every request; listing it adds nothing.
  if (rule.rulesetId === '_dynamic' && rule.ruleId === ID.gpc) return;
  const l = forTab(request.tabId);
  l.entries.push({
    n: ++seq, t: Date.now(), url: request.url, type: request.type, method: request.method,
    frame: request.frameId || 0, initiator: request.initiator || '',
    ruleset: rule.rulesetId, rule: rule.ruleId
  });
  if (l.entries.length > MAX) l.entries.splice(0, l.entries.length - MAX);
}

// Events that are not network rules (pop-ups closed, pages stopped).
export function logEvent(tabId, kind, url) {
  if (tabId < 0) return;
  const l = forTab(tabId);
  l.entries.push({ n: ++seq, t: Date.now(), url, type: kind, event: kind, ruleset: '', rule: 0 });
  if (l.entries.length > MAX) l.entries.splice(0, l.entries.length - MAX);
}

export function logGet(tabId, since = 0) {
  const l = logs.get(tabId);
  const entries = l ? l.entries.filter(e => e.n > since) : [];
  return { entries, last: seq };
}

export function logClear(tabId) { logs.delete(tabId); }
export function logForget(tabId) { logs.delete(tabId); }

// A new page in the tab starts a new section; older entries stay readable.
export function logNavigation(tabId, url) {
  if (tabId < 0 || !/^https?:/i.test(url)) return;
  const l = forTab(tabId);
  l.entries.push({ n: ++seq, t: Date.now(), url, type: 'navigation', event: 'navigation', ruleset: '', rule: 0 });
}
