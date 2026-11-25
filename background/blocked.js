// Warning page for blocked pages. A filter that blocks a whole page
// ($document, or any listed host in the security lists) sends the tab to
// blocked/blocked.html instead of the browser's bare error. The page asks
// here what was blocked, and can go on to it once (this tab) or always.

import { ID } from './ids.js';
import { PRIORITY } from '../engine/compiler.js';
import { lastNavigation } from './skip.js';
import { report } from './state.js';

// Above any list rule (important is 3), below the whitelist.
export const PROCEED_PRIORITY = PRIORITY.whitelist - 10;

export function blockedInfo(tabId) {
  const url = lastNavigation(tabId);
  if (!url) return { url: null };
  let host = '';
  try { host = new URL(url).hostname; } catch { /* ignore */ }
  return { url, host };
}

// Lets this tab open the host (until the tab closes).
export async function proceedOnce(tabId, url) {
  let host;
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw new Error('scheme'); host = u.hostname; }
  catch { return { ok: false }; }
  if (tabId < 0 || !host) return { ok: false };
  const id = ID.proceedBase + (tabId % 1000);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{ id, priority: PROCEED_PRIORITY, action: { type: 'allow' }, condition: { tabIds: [tabId], requestDomains: [host], resourceTypes: ['main_frame'] } }]
    });
  } catch (e) { report('blocked', e); return { ok: false }; }
  return { ok: true, host };
}

export function forgetProceed(tabId) {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ID.proceedBase + (tabId % 1000)] }).catch(() => {});
}

// Sites the user chose to always open: one allow rule (see rules.js).
export function strictAllowRule(hosts) {
  if (!hosts.length) return null;
  return { id: ID.strictAllow, priority: PROCEED_PRIORITY, action: { type: 'allow' }, condition: { requestDomains: hosts, resourceTypes: ['main_frame'] } };
}
