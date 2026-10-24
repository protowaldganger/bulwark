// Cookie control, service-worker side.
//
// Network level (rules.js): third-party Cookie / Set-Cookie headers are
// stripped by declarativeNetRequest, tracker domains always.
// Script level (cookie shims): document.cookie writes of trackers and from
// cross-site frames are dropped synchronously.
// Storage level (this file): every cookie that lands in the jar is
// classified and non-essential ones are deleted immediately.

import { keepCookie } from '../engine/cookies.js';
import { getSettings, cookiePolicyFor, hostChain, report, siteOf, rawHostOf } from './state.js';
import { countCookie } from './stats.js';

function userRuleFor(domain, settings) {
  const rules = settings.cookies.rules || [];
  if (!rules.length) return null;
  const chain = hostChain(domain);
  const patterns = [];
  for (const r of rules) {
    if (!chain.includes(r.domain)) continue;
    for (const n of String(r.names || '').split(',').map(x => x.trim()).filter(Boolean)) {
      const re = new RegExp('^' + n.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
      patterns.push(re);
    }
  }
  if (!patterns.length) return null;
  return (name) => patterns.some(re => re.test(name));
}

function cookieUrl(c) {
  const host = c.domain.replace(/^\./, '');
  return `http${c.secure ? 's' : ''}://${host}${c.path || '/'}`;
}

async function removeCookie(c) {
  const details = { url: cookieUrl(c), name: c.name, storeId: c.storeId };
  if (c.partitionKey) details.partitionKey = c.partitionKey;
  try { await chrome.cookies.remove(details); } catch (e) { report('cookie-remove', e); }
}

export async function onCookieChanged(info) {
  if (info.removed) return;
  const c = info.cookie;
  const s = await getSettings();
  const domain = c.domain.replace(/^\./, '');
  const policy = cookiePolicyFor(domain, s);
  // Partitioned (CHIPS) cookies are third-party by construction.
  const top = c.partitionKey && c.partitionKey.topLevelSite ? rawHostOf(c.partitionKey.topLevelSite) : '';
  const thirdParty = !!top && siteOf(top) !== siteOf(domain);
  const keep = thirdParty && s.cookies.blockThirdParty && policy !== 'allow'
    ? false
    : keepCookie({ name: c.name, session: c.session }, policy, userRuleFor(domain, s), domain);
  if (keep) return;
  await removeCookie(c);
  countCookie(domain, 1);
}

// Applies the current policy to cookies already stored for a site.
export async function sweepSite(host) {
  const s = await getSettings();
  let all = [];
  try { all = await chrome.cookies.getAll({ domain: host }); } catch (e) { report('cookie-sweep', e); return 0; }
  let removed = 0;
  for (const c of all) {
    const domain = c.domain.replace(/^\./, '');
    const policy = cookiePolicyFor(domain, s);
    if (keepCookie({ name: c.name, session: c.session }, policy, userRuleFor(domain, s), domain)) continue;
    await removeCookie(c);
    removed++;
  }
  if (removed) countCookie(host, removed);
  return removed;
}

export async function cookieSummary(host) {
  const s = await getSettings();
  let all = [];
  try { all = await chrome.cookies.getAll({ domain: host }); } catch { return { kept: 0 }; }
  return { kept: all.length, policy: cookiePolicyFor(host, s) };
}
