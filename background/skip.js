// Tracking-redirect skipping ($urlskip filters, "debouncing").
// A matching page load is redirected by a network rule to skip/skip.html
// before any request reaches the tracker. That page asks here for the real
// destination, which is worked out from the original address the tab was
// navigating to. If it cannot be worked out, the tab may load the original
// address once.

import { ID } from './ids.js';
import { PRIORITY } from '../engine/compiler.js';

const pending = new Map(); // tabId -> { url, t }
const bypass = new Map();  // tabId -> time the one-off allow rule was added

function dropBypass(tabId) {
  if (!bypass.has(tabId)) return;
  bypass.delete(tabId);
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ID.skipBypassBase + (tabId % 1000)] }).catch(() => {});
}

export function noteNavigation(d) {
  if (d.frameId !== 0 || !/^https?:/i.test(d.url)) return;
  // The service worker may have slept through the timer below.
  const b = bypass.get(d.tabId);
  if (b && Date.now() - b > 10000) dropBypass(d.tabId);
  pending.set(d.tabId, { url: d.url, t: Date.now() });
  if (pending.size > 200) pending.delete(pending.keys().next().value);
}

// The address the tab last tried to open (for the warning page).
export function lastNavigation(tabId) {
  const p = pending.get(tabId);
  return p && Date.now() - p.t < 5 * 60000 ? p.url : null;
}

export function forgetTab(tabId) { pending.delete(tabId); dropBypass(tabId); }

// The same transformation steps as uBlock Origin's urlskip=.
export function urlSkip(url, steps) {
  try {
    let out = url;
    for (const step of steps) {
      const inp = out;
      if (step === '#') { const p = inp.indexOf('#'); out = p !== -1 ? inp.slice(p + 1) : ''; continue; }
      if (step[0] === '&') {
        const i = (parseInt(step.slice(1), 10) || 0) - 1;
        const keys = [...new URL(inp).searchParams.keys()];
        if (i < 0 || i >= keys.length) return null;
        out = decodeURIComponent(keys[i]);
        continue;
      }
      if (step === '+https') { const x = inp.replace(/^https?:\/\//, ''); if (/^[\w-]:\/\//.test(x)) return null; out = 'https://' + x; continue; }
      if (step === '-base64') { out = atob(inp); continue; }
      if (step === '-safebase64') { out = atob(inp.replace(/[-_]/g, c => (c === '-' ? '+' : '/'))); continue; }
      if (step === '-uricomponent') { out = decodeURIComponent(inp); continue; }
      if (step === '-blocked') continue;
      if (step[0] === '/') { const m = new RegExp(step.slice(1, -1)).exec(inp); if (!m || m.length <= 1) return null; out = m[1]; continue; }
      if (step[0] === '?') { out = new URL(inp).searchParams.get(step.slice(1)); if (out === null) return null; out = out.replace(/ /g, '%20'); continue; }
      return null;
    }
    const u = new URL(out);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch { return null; }
}

// Answer for skip.html in tab `tabId`: { url } to go to.
export async function skipTarget(tabId, stepsRaw) {
  const p = pending.get(tabId);
  if (!p || Date.now() - p.t > 60000) return { url: null };
  const steps = String(stepsRaw || '').trim().split(/\s+/).filter(Boolean);
  const target = steps.length ? urlSkip(p.url, steps) : null;
  pending.delete(tabId);
  if (target && target !== p.url) return { url: target };
  // Could not work it out: let this tab load the original address once.
  const id = ID.skipBypassBase + (tabId % 1000);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{ id, priority: PRIORITY.whitelist - 3, action: { type: 'allow' }, condition: { tabIds: [tabId], resourceTypes: ['main_frame'] } }]
    });
    bypass.set(tabId, Date.now());
    const t = setTimeout(() => dropBypass(tabId), 10000);
    if (t.unref) t.unref(); // Node (tests) only
  } catch { /* ignore */ }
  return { url: p.url, original: true };
}
