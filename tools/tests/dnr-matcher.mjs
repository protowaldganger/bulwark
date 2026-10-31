// A small reference implementation of declarativeNetRequest matching,
// used to check that the compiled rulesets block what they should and,
// more importantly, never block YouTube playback.

const reCache = new WeakMap();

function urlFilterToRegex(f, caseSensitive) {
  let src = '';
  let i = 0;
  if (f.startsWith('||')) { src += '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^\\/?#@]*\\.)?'; i = 2; }
  else if (f.startsWith('|')) { src += '^'; i = 1; }
  let end = f.length;
  let anchorEnd = false;
  if (f.endsWith('|') && end > i) { anchorEnd = true; end--; }
  for (; i < end; i++) {
    const c = f[i];
    if (c === '*') src += '.*';
    else if (c === '^') src += '(?:[^A-Za-z0-9_\\-.%]|$)';
    else src += c.replace(/[.+?${}()[\]\\/]/g, '\\$&');
  }
  if (anchorEnd) src += '$';
  return new RegExp(src, caseSensitive ? '' : 'i');
}

function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }
function site(h) {
  const p = h.split('.');
  if (p.length <= 2) return h;
  const two = p[p.length - 1].length === 2 && /^(co|com|net|org|gov|ac|edu)$/.test(p[p.length - 2]);
  return p.slice(two ? -3 : -2).join('.');
}
const domMatch = (host, list) => list.some(d => host === d || host.endsWith('.' + d));

export function ruleMatches(rule, req) {
  const c = rule.condition;
  const type = req.type;
  if (c.resourceTypes) { if (!c.resourceTypes.includes(type)) return false; }
  else if (c.excludedResourceTypes) { if (c.excludedResourceTypes.includes(type)) return false; }
  else if (type === 'main_frame') return false;
  const url = req.url;
  if (c.urlFilter) {
    let re = reCache.get(rule);
    if (!re) { re = urlFilterToRegex(c.urlFilter, c.isUrlFilterCaseSensitive); reCache.set(rule, re); }
    if (!re.test(url)) return false;
  }
  if (c.regexFilter) {
    let re = reCache.get(rule);
    if (!re) { re = new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive ? '' : 'i'); reCache.set(rule, re); }
    if (!re.test(url)) return false;
  }
  const rh = hostOf(url);
  const ih = req.initiator ? hostOf(req.initiator) : '';
  if (c.requestDomains && !domMatch(rh, c.requestDomains)) return false;
  if (c.excludedRequestDomains && domMatch(rh, c.excludedRequestDomains)) return false;
  // `domains` / `excludedDomains` are the older names (used by the Safari build).
  const inc = c.initiatorDomains || c.domains, exc = c.excludedInitiatorDomains || c.excludedDomains;
  if (inc && !(ih && domMatch(ih, inc))) return false;
  if (exc && ih && domMatch(ih, exc)) return false;
  if (c.domainType) {
    const third = ih ? site(ih) !== site(rh) : false;
    if (c.domainType === 'thirdParty' && !third) return false;
    if (c.domainType === 'firstParty' && third) return false;
  }
  if (c.requestMethods && !c.requestMethods.includes(req.method || 'get')) return false;
  if (c.excludedRequestMethods && c.excludedRequestMethods.includes(req.method || 'get')) return false;
  return true;
}

const RANK = { allow: 5, allowAllRequests: 4, block: 3, upgradeScheme: 2, redirect: 1 };

// Returns { action, rule } for the winning rule or { action: 'none' }.
export function evaluate(rulesets, req) {
  let frameAllow = 0;
  if (req.type !== 'main_frame' && req.documentUrl) {
    const top = { url: req.documentUrl, type: 'main_frame' };
    for (const rs of rulesets) for (const r of rs.rules) {
      if (r.action.type === 'allowAllRequests' && ruleMatches(r, top)) frameAllow = Math.max(frameAllow, r.priority || 1);
    }
  }
  let best = null;
  for (const rs of rulesets) {
    for (const r of rs.rules) {
      if (r.action.type === 'modifyHeaders') continue;
      if (!ruleMatches(r, req)) continue;
      const p = r.priority || 1;
      if (!best || p > best.p || (p === best.p && RANK[r.action.type] > RANK[best.rule.action.type])) best = { p, rule: r, ruleset: rs.id };
    }
  }
  if (frameAllow && (!best || frameAllow >= best.p)) return { action: 'allow', via: 'allowAllRequests' };
  if (!best) return { action: 'none' };
  const t = best.rule.action.type;
  return { action: t === 'allowAllRequests' ? 'allow' : t, rule: best.rule, ruleset: best.ruleset };
}
