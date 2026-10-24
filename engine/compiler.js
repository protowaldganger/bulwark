// Filter compiler: Adblock Plus / uBlock Origin / Brave filter syntax to
// declarativeNetRequest rules, cosmetic data and scriptlet data.
//
// Pure JavaScript with no platform APIs so it runs both in the Node build
// tool and in the extension service worker (for list updates and custom
// rules). Everything expensive happens here, once, so the per-request and
// per-page paths only do table lookups.

export const PRIORITY = {
  block: 1,
  removeparam: 1,
  allow: 2,
  allowAll: 2,
  redirect: 2,
  important: 3,
  importantAllow: 4,
  ytBlock: 5,
  customBlock: 5,
  customAllow: 6,
  whitelist: 1000,
  cookies: 2000
};

const ALL_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'
];

const TYPE_MAP = {
  script: 'script', image: 'image', stylesheet: 'stylesheet', css: 'stylesheet',
  object: 'object', 'object-subrequest': 'object', xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest', subdocument: 'sub_frame', frame: 'sub_frame', ping: 'ping',
  beacon: 'ping', media: 'media', font: 'font', websocket: 'websocket', other: 'other',
  webtransport: 'webtransport', webbundle: 'webbundle', document: 'main_frame', doc: 'main_frame'
};

// Options we cannot express in DNR. A filter that uses one is skipped
// entirely, which is safer than applying it with different semantics.
const UNSUPPORTED_OPTIONS = new Set([
  'csp', 'header', 'permissions', 'replace', 'urlskip', 'uritransform', 'urltransform',
  'removeheader', 'cname', 'ipaddress', 'rewrite', 'sitekey', 'genericblock', 'stealth',
  'content', 'jsonprune', 'network', 'app', 'extension', 'tag', 'webrtc', 'inline-script',
  'inline-font', 'popunder', 'empty', 'mp4', 'cookie', 'hls', 'xmlprune', 'responseheader'
]);

const IGNORED_OPTIONS = new Set(['_', 'reason', 'noop', 'strict-blocking']);

// Redirect resources shipped in /resources. Aliases map to file names.
export const REDIRECT_RESOURCES = {
  'noopjs': 'noop.js', 'noop.js': 'noop.js', 'abp-resource:blank-js': 'noop.js',
  'nooptext': 'noop.txt', 'noop.txt': 'noop.txt', 'empty': 'noop.txt',
  'noopframe': 'noop.html', 'noop.html': 'noop.html',
  'noopcss': 'noop.css', 'noop.css': 'noop.css',
  'noopjson': 'noop.json', 'noop.json': 'noop.json',
  '1x1.gif': '1x1.gif', '1x1-transparent.gif': '1x1.gif',
  '2x2.png': '2x2.png', '2x2-transparent.png': '2x2.png', '3x2.png': '2x2.png', '3x2-transparent.png': '2x2.png',
  '32x32.png': '32x32.png', '32x32-transparent.png': '32x32.png',
  'noopmp3-0.1s': 'noop-0.1s.mp3', 'noop-0.1s.mp3': 'noop-0.1s.mp3',
  'google-ima.js': 'google-ima.js', 'google-ima3': 'google-ima.js',
  'googletagmanager_gtm.js': 'googletagmanager_gtm.js', 'googletagmanager.com/gtm.js': 'googletagmanager_gtm.js', 'googletagmanager.com': 'googletagmanager_gtm.js',
  'google-analytics_analytics.js': 'google-analytics_analytics.js', 'google-analytics.com/analytics.js': 'google-analytics_analytics.js', 'google-analytics.com': 'google-analytics_analytics.js',
  'google-analytics_ga.js': 'google-analytics_analytics.js', 'google-analytics.com/ga.js': 'google-analytics_analytics.js',
  'googletagservices_gpt.js': 'googletagservices_gpt.js', 'googletagservices.com/gpt.js': 'googletagservices_gpt.js',
  'googlesyndication_adsbygoogle.js': 'googlesyndication_adsbygoogle.js', 'googlesyndication.com/adsbygoogle.js': 'googlesyndication_adsbygoogle.js',
  'amazon_apstag.js': 'amazon_apstag.js',
  'fingerprint2.js': 'fingerprint2.js',
  'chartbeat.js': 'chartbeat.js',
  'scorecardresearch_beacon.js': 'scorecardresearch_beacon.js', 'scorecardresearch.com': 'scorecardresearch_beacon.js',
  'fuckadblock.js-3.2.0': 'fuckadblock.js', 'nofab.js': 'fuckadblock.js',
  'prebid-ads.js': 'prebid-ads.js'
};

// Scriptlets implemented in engine/scriptlets.js, keyed by every alias.
export const SCRIPTLET_ALIASES = {
  'set-constant': 'set-constant', 'set': 'set-constant',
  'abort-on-property-read': 'abort-on-property-read', 'aopr': 'abort-on-property-read',
  'abort-on-property-write': 'abort-on-property-write', 'aopw': 'abort-on-property-write',
  'abort-current-script': 'abort-current-script', 'acs': 'abort-current-script',
  'abort-current-inline-script': 'abort-current-script', 'acis': 'abort-current-script',
  'no-setTimeout-if': 'no-setTimeout-if', 'nostif': 'no-setTimeout-if', 'setTimeout-defuser': 'no-setTimeout-if', 'prevent-setTimeout': 'no-setTimeout-if',
  'no-setInterval-if': 'no-setInterval-if', 'nosiif': 'no-setInterval-if', 'setInterval-defuser': 'no-setInterval-if', 'prevent-setInterval': 'no-setInterval-if',
  'prevent-addEventListener': 'prevent-addEventListener', 'aeld': 'prevent-addEventListener', 'addEventListener-defuser': 'prevent-addEventListener',
  'no-window-open-if': 'no-window-open-if', 'nowoif': 'no-window-open-if', 'window.open-defuser': 'no-window-open-if', 'prevent-window-open': 'no-window-open-if',
  'no-xhr-if': 'no-xhr-if', 'prevent-xhr': 'no-xhr-if',
  'no-fetch-if': 'no-fetch-if', 'prevent-fetch': 'no-fetch-if',
  'json-prune': 'json-prune',
  'remove-attr': 'remove-attr', 'ra': 'remove-attr',
  'remove-class': 'remove-class', 'rc': 'remove-class',
  'noeval': 'noeval', 'silent-noeval': 'noeval',
  'noeval-if': 'noeval-if', 'prevent-eval-if': 'noeval-if',
  'nowebrtc': 'nowebrtc',
  'nano-setInterval-booster': 'nano-setInterval-booster', 'nano-sib': 'nano-setInterval-booster',
  'nano-setTimeout-booster': 'nano-setTimeout-booster', 'nano-stb': 'nano-setTimeout-booster',
  'set-local-storage-item': 'set-local-storage-item',
  'remove-cookie': 'remove-cookie', 'cookie-remover': 'remove-cookie'
};

// Hosts owned by the hand-written YouTube engine. List scriptlets are not
// applied there so two engines never fight over JSON.parse.
const YT_HOSTS = ['youtube.com', 'youtube-nocookie.com', 'youtubekids.com', 'youtu.be'];
export function isYouTubeHost(host) {
  for (const h of YT_HOSTS) if (host === h || host.endsWith('.' + h)) return true;
  return false;
}

// ---------------------------------------------------------------- utilities

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Stable identity of a rule, independent of its numeric id. Used to diff a
// freshly downloaded list against the bundled snapshot.
export function ruleKey(rule) {
  return fnv1a(JSON.stringify([rule.priority, rule.action, rule.condition]));
}

const ASCII_RE = /^[\x20-\x7e]*$/;

export function normalizeDomain(raw) {
  let d = raw.trim().toLowerCase();
  if (!d) return null;
  if (!ASCII_RE.test(d)) {
    try { d = new URL('http://' + d).hostname; } catch { return null; }
  }
  d = d.replace(/\.$/, '');
  if (!/^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/.test(d)) return null;
  if (d.includes('..')) return null;
  return d;
}

// Split an option value list like "a.com|~b.com|c.*".
function parseDomainList(value, sep) {
  const include = [], exclude = [];
  let droppedInclude = 0;
  for (let part of value.split(sep)) {
    part = part.trim();
    if (!part) continue;
    const neg = part.startsWith('~');
    if (neg) part = part.slice(1);
    // Entities (example.*) and regex domains cannot be expressed in DNR.
    if (part.endsWith('.*') || part.startsWith('/')) { if (!neg) droppedInclude++; continue; }
    const d = normalizeDomain(part);
    if (!d) { if (!neg) droppedInclude++; continue; }
    (neg ? exclude : include).push(d);
  }
  return { include, exclude, droppedInclude };
}

// Re2 (used by Chrome) does not support lookaround or backreferences.
export function isRe2Compatible(source) {
  if (source.length > 256) return false;
  if (/\(\?[=!<>]/.test(source)) return false;
  if (/\\[1-9]/.test(source)) return false;
  if (/[*+?}]\+/.test(source)) return false;
  if (/\\Z/.test(source)) return false;
  const reps = source.match(/\{(\d+)(,(\d*))?\}/g) || [];
  for (const r of reps) {
    const nums = r.match(/\d+/g).map(Number);
    if (nums.some(n => n > 1000)) return false;
  }
  try { new RegExp(source); } catch { return false; }
  return true;
}

// ------------------------------------------------------------ preprocessor

const PREPROCESSOR_ENV = {
  env_chromium: true, env_mv3: true, ext_ubol: true, cap_user_stylesheet: true,
  env_firefox: false, env_safari: false, env_mobile: false, env_edge: false,
  cap_html_filtering: false, cap_ipaddress: false, ext_ublock: true, ext_abp: false,
  adguard: false, false: false, true: true
};

function evalCondition(expr) {
  const tokens = expr.match(/!|&&|\|\||\(|\)|[\w.-]+/g) || [];
  let i = 0;
  const parseOr = () => {
    let v = parseAnd();
    while (tokens[i] === '||') { i++; const r = parseAnd(); v = v || r; }
    return v;
  };
  const parseAnd = () => {
    let v = parseUnary();
    while (tokens[i] === '&&') { i++; const r = parseUnary(); v = v && r; }
    return v;
  };
  const parseUnary = () => {
    if (tokens[i] === '!') { i++; return !parseUnary(); }
    if (tokens[i] === '(') { i++; const v = parseOr(); if (tokens[i] === ')') i++; return v; }
    const t = tokens[i++];
    return PREPROCESSOR_ENV[t] === true;
  };
  try { return parseOr(); } catch { return false; }
}

export function preprocess(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const stack = []; // each entry: { active, taken }
  const active = () => stack.every(s => s.active);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('!#if ')) {
      const cond = evalCondition(line.slice(5));
      stack.push({ active: cond });
      continue;
    }
    if (line === '!#else') { if (stack.length) stack[stack.length - 1].active = !stack[stack.length - 1].active; continue; }
    if (line === '!#endif') { stack.pop(); continue; }
    if (!active()) continue;
    if (line.length === 0 || line.startsWith('!') || line.startsWith('[')) continue;
    out.push(line);
  }
  return out;
}

// --------------------------------------------------------- rule validation

const ACTIONS = new Set(['block', 'allow', 'allowAllRequests', 'upgradeScheme', 'redirect', 'modifyHeaders']);
const METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other']);

// Mirrors the checks Chrome performs when loading a ruleset, so a bad rule
// is caught here instead of making Chrome reject a whole batch.
export function validateRule(rule) {
  if (!Number.isInteger(rule.id) || rule.id < 1) return 'bad id';
  if (rule.priority !== undefined && (!Number.isInteger(rule.priority) || rule.priority < 1)) return 'bad priority';
  const a = rule.action, c = rule.condition;
  if (!a || !ACTIONS.has(a.type)) return 'bad action';
  if (!c || typeof c !== 'object') return 'no condition';
  if (c.urlFilter !== undefined && c.regexFilter !== undefined) return 'url and regex';
  if (c.urlFilter !== undefined) {
    const u = c.urlFilter;
    if (typeof u !== 'string' || !u.length || !ASCII_RE.test(u)) return 'bad urlFilter';
    if (u.startsWith('||*')) return 'urlFilter ||*';
    const body = u.startsWith('||') ? u.slice(2) : u.startsWith('|') ? u.slice(1) : u;
    const inner = body.endsWith('|') ? body.slice(0, -1) : body;
    if (inner.includes('|')) return 'urlFilter pipe';
  }
  if (c.regexFilter !== undefined && (!ASCII_RE.test(c.regexFilter) || !isRe2Compatible(c.regexFilter))) return 'bad regex';
  for (const k of ['initiatorDomains', 'excludedInitiatorDomains', 'requestDomains', 'excludedRequestDomains']) {
    if (c[k] === undefined) continue;
    if (!Array.isArray(c[k]) || c[k].length === 0) return 'empty ' + k;
    for (const d of c[k]) if (typeof d !== 'string' || d !== d.toLowerCase() || !ASCII_RE.test(d) || !d) return 'bad domain ' + d;
  }
  if (c.resourceTypes !== undefined && c.excludedResourceTypes !== undefined) return 'both type lists';
  if (c.resourceTypes !== undefined && (!Array.isArray(c.resourceTypes) || c.resourceTypes.length === 0)) return 'empty resourceTypes';
  for (const t of [...(c.resourceTypes || []), ...(c.excludedResourceTypes || [])]) if (!ALL_TYPES.includes(t)) return 'bad type ' + t;
  if (c.excludedResourceTypes && ALL_TYPES.every(t => c.excludedResourceTypes.includes(t))) return 'all types excluded';
  if (c.requestMethods) for (const m of c.requestMethods) if (!METHODS.has(m)) return 'bad method';
  if (a.type === 'allowAllRequests') {
    if (!c.resourceTypes || c.resourceTypes.some(t => t !== 'main_frame' && t !== 'sub_frame')) return 'allowAllRequests types';
  }
  if (a.type === 'redirect') {
    const r = a.redirect;
    if (!r || !(r.extensionPath || r.url || r.transform || r.regexSubstitution)) return 'bad redirect';
    if (r.extensionPath && !r.extensionPath.startsWith('/')) return 'bad extensionPath';
  }
  if (a.type === 'modifyHeaders' && !(a.requestHeaders?.length || a.responseHeaders?.length)) return 'no headers';
  if (c.domainType && c.domainType !== 'firstParty' && c.domainType !== 'thirdParty') return 'bad domainType';
  return null;
}

// --------------------------------------------------------- network filters

function splitOptions(line) {
  // Regex filters can contain '$'. The option separator is the last '$'
  // that is followed by something that looks like an option list.
  const idx = line.lastIndexOf('$');
  if (idx < 0 || idx === line.length - 1) return [line, ''];
  const tail = line.slice(idx + 1);
  // The whole filter is a regex: any '$' belongs to it, e.g. /ads?$/
  if (line.length > 2 && line.startsWith('/') && line.endsWith('/')) return [line, ''];
  if (!/^[\w~-]/.test(tail)) return [line, ''];
  return [line.slice(0, idx), tail];
}

function splitOptionList(opts) {
  // Commas inside regex values (removeparam=/a,b/) are rare; handle the
  // common escape "\," used by uBO.
  const out = [];
  let cur = '';
  for (let i = 0; i < opts.length; i++) {
    const ch = opts[i];
    if (ch === '\\' && opts[i + 1] === ',') { cur += ','; i++; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

const HOSTS_LINE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+([^\s#]+)/;
const PLAIN_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function badfilterKey(line) {
  const [pattern, opts] = splitOptions(line);
  const list = splitOptionList(opts).filter(o => o !== 'badfilter').sort();
  return pattern + (list.length ? '$' + list.join(',') : '');
}

// Parses one network filter. Returns { rule } (without id) or { flags }
// for cosmetic-exception filters, or { skip: reason }.
export function parseNetworkFilter(raw, ctx = {}) {
  let line = raw;
  const hm = HOSTS_LINE.exec(line);
  if (hm) {
    const host = normalizeDomain(hm[1]);
    if (!host || host === 'localhost' || host === '0.0.0.0') return { skip: 'hosts-local' };
    line = '||' + host + '^';
  } else if (PLAIN_HOST.test(line) && ctx.plainHosts !== false) {
    line = '||' + line + '^';
  }

  let exception = false;
  if (line.startsWith('@@')) { exception = true; line = line.slice(2); }
  const [patternRaw, optsRaw] = splitOptions(line);
  let pattern = patternRaw;
  const opts = splitOptionList(optsRaw);

  const cond = {};
  const types = new Set();
  const notTypes = new Set();
  let important = false, matchCase = false, party = null;
  let redirect = null, redirectRule = false, removeparam = null;
  let domainInclude = [], domainExclude = [], droppedInclude = 0;
  let toInclude = [], toExclude = [], toDropped = 0;
  let denyallow = [];
  let methods = [], notMethods = [];
  let cosmeticFlags = 0;
  let popupOnly = false, sawPopup = false;

  for (const o of opts) {
    let name = o, value = null;
    const eq = o.indexOf('=');
    if (eq !== -1) { name = o.slice(0, eq); value = o.slice(eq + 1); }
    let neg = false;
    if (name.startsWith('~')) { neg = true; name = name.slice(1); }
    name = name.toLowerCase();
    if (IGNORED_OPTIONS.has(name)) continue;
    if (UNSUPPORTED_OPTIONS.has(name)) return { skip: 'option:' + name };
    switch (name) {
      case 'domain': case 'from': {
        if (value === null) return { skip: 'domain-empty' };
        const r = parseDomainList(value, '|');
        domainInclude = r.include; domainExclude = r.exclude; droppedInclude = r.droppedInclude;
        break;
      }
      case 'to': {
        if (value === null) return { skip: 'to-empty' };
        const r = parseDomainList(value, '|');
        toInclude = r.include; toExclude = r.exclude; toDropped = r.droppedInclude;
        break;
      }
      case 'denyallow': {
        if (value === null) return { skip: 'denyallow-empty' };
        denyallow = parseDomainList(value, '|').include;
        break;
      }
      case 'method': {
        if (value === null) return { skip: 'method-empty' };
        for (let m of value.toLowerCase().split('|')) {
          const n = m.startsWith('~'); if (n) m = m.slice(1);
          if (!METHODS.has(m)) return { skip: 'method' };
          (n ? notMethods : methods).push(m);
        }
        break;
      }
      case 'third-party': case '3p': case 'strict3p': case 'strict-third-party':
        party = neg ? 'firstParty' : 'thirdParty'; break;
      case 'first-party': case '1p': case 'strict1p': case 'strict-first-party':
        party = neg ? 'thirdParty' : 'firstParty'; break;
      case 'match-case': matchCase = !neg; break;
      case 'important': important = true; break;
      case 'badfilter': return { skip: 'badfilter' };
      case 'redirect': case 'redirect-rule': {
        if (value === null) return { skip: 'redirect-empty' };
        const res = value.replace(/:-?\d+$/, '');
        redirect = REDIRECT_RESOURCES[res] || null;
        redirectRule = name === 'redirect-rule';
        if (!redirect && redirectRule) return { skip: 'redirect-unknown' };
        if (value === 'none') return { skip: 'redirect-none' };
        break;
      }
      case 'removeparam': case 'queryprune': {
        if (value === null || value === '') { removeparam = ''; break; }
        if (value.startsWith('/') || value.startsWith('~') || value.includes('|')) return { skip: 'removeparam-regex' };
        removeparam = value;
        break;
      }
      case 'elemhide': case 'ehide': cosmeticFlags |= 1; break;
      case 'generichide': case 'ghide': cosmeticFlags |= 2; break;
      case 'specifichide': case 'shide': cosmeticFlags |= 4; break;
      case 'popup': sawPopup = true; if (!neg) popupOnly = true; break;
      case 'all':
        for (const t of ALL_TYPES) if (t !== 'csp_report') types.add(t);
        break;
      default: {
        const t = TYPE_MAP[name];
        if (!t) return { skip: 'option:' + name };
        (neg ? notTypes : types).add(t);
      }
    }
  }

  if (droppedInclude && domainInclude.length === 0) return { skip: 'entity-only' };
  if (toDropped && toInclude.length === 0) return { skip: 'to-entity-only' };
  if (popupOnly && types.size === 0) return { skip: 'popup' };
  void sawPopup;

  // Cosmetic exception flags: @@||example.com^$generichide
  if (cosmeticFlags) {
    if (!exception) return { skip: 'cosmetic-flag-on-block' };
    const hosts = [];
    const m = /^\|\|([a-z0-9.-]+)\^?$/.exec(pattern.toLowerCase());
    if (m) hosts.push(m[1]);
    if (domainInclude.length) hosts.push(...domainInclude);
    if (!hosts.length) return { skip: 'cosmetic-flag-generic' };
    // A filter like $document,generichide also yields a network rule; the
    // flag part is reported separately.
    if (!types.has('main_frame')) return { flags: { hosts, bits: cosmeticFlags } };
    ctx.onFlags?.({ hosts, bits: cosmeticFlags });
  }

  // ---- pattern
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    const src = pattern.slice(1, -1);
    if (!isRe2Compatible(src) || !ASCII_RE.test(src)) return { skip: 'regex' };
    cond.regexFilter = src;
  } else {
    if (!ASCII_RE.test(pattern)) {
      const m = /^(\|\|)([^/^:?*]+)(.*)$/.exec(pattern);
      if (!m) return { skip: 'non-ascii' };
      const host = normalizeDomain(m[2]);
      if (!host || !ASCII_RE.test(m[3])) return { skip: 'non-ascii' };
      pattern = m[1] + host + m[3];
    }
    if (pattern.startsWith('||*')) pattern = pattern.slice(2);
    while (pattern.startsWith('**')) pattern = pattern.slice(1);
    if (pattern === '*' || pattern === '' || pattern === '|' || pattern === '||') pattern = '';
    if (pattern) {
      const body = pattern.startsWith('||') ? pattern.slice(2) : pattern.startsWith('|') ? pattern.slice(1) : pattern;
      const inner = body.endsWith('|') ? body.slice(0, -1) : body;
      if (inner.includes('|')) return { skip: 'pipe' };
      cond.urlFilter = matchCase ? pattern : pattern.toLowerCase();
    }
  }

  // A filter with no pattern and no restriction would match everything.
  if (!cond.urlFilter && !cond.regexFilter && !domainInclude.length && !toInclude.length && (removeparam === null || removeparam === '')) {
    return { skip: 'too-broad' };
  }

  if (matchCase) cond.isUrlFilterCaseSensitive = true;
  if (party) cond.domainType = party;
  if (domainInclude.length) cond.initiatorDomains = [...new Set(domainInclude)];
  if (domainExclude.length) cond.excludedInitiatorDomains = [...new Set(domainExclude)];
  if (toInclude.length) cond.requestDomains = [...new Set(toInclude)];
  const exReq = [...toExclude, ...denyallow];
  if (exReq.length) cond.excludedRequestDomains = [...new Set(exReq)];
  if (methods.length) cond.requestMethods = methods;
  else if (notMethods.length) cond.excludedRequestMethods = notMethods;

  // ---- action
  let action, priority;
  const isDocument = types.has('main_frame');

  if (exception) {
    if (redirect || removeparam !== null) return { skip: 'exception-modifier' };
    if (isDocument) {
      // @@...$document: disable everything inside matching documents.
      action = { type: 'allowAllRequests' };
      cond.resourceTypes = ['main_frame', 'sub_frame'];
      priority = important ? PRIORITY.importantAllow : PRIORITY.allowAll;
      return finish();
    }
    action = { type: 'allow' };
    priority = important ? PRIORITY.importantAllow : PRIORITY.allow;
  } else if (removeparam !== null) {
    action = removeparam === ''
      ? { type: 'redirect', redirect: { transform: { query: '' } } }
      : { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: [removeparam] } } } };
    priority = PRIORITY.removeparam;
    if (!types.size) ['main_frame', 'sub_frame', 'xmlhttprequest'].forEach(t => types.add(t));
  } else if (redirect) {
    action = { type: 'redirect', redirect: { extensionPath: '/resources/' + redirect } };
    priority = important ? PRIORITY.important : PRIORITY.redirect;
  } else {
    action = { type: 'block' };
    priority = important ? PRIORITY.important : PRIORITY.block;
  }

  if (types.size) {
    for (const t of notTypes) types.delete(t);
    if (!types.size) return { skip: 'no-types' };
    cond.resourceTypes = ALL_TYPES.filter(t => types.has(t));
  } else if (notTypes.size) {
    // DNR includes main_frame once excludedResourceTypes is present; filter
    // semantics never touch top documents unless asked to.
    notTypes.add('main_frame');
    cond.excludedResourceTypes = ALL_TYPES.filter(t => notTypes.has(t));
  }

  return finish();

  function finish() {
    const rule = { id: 1, priority, action, condition: cond };
    const err = validateRule(rule);
    if (err) return { skip: 'invalid:' + err };
    return { rule };
  }
}

// -------------------------------------------------------- cosmetic filters

const COSMETIC_SEP = /^(.*?)(#@?(?:\?|\$|%)?#)(.*)$/;

const PROCEDURAL_OPS = [
  'has-text', '-abp-contains', 'contains', 'upward', 'xpath', 'matches-path',
  'min-text-length', 'matches-css', 'matches-css-before', 'matches-css-after',
  'matches-attr', 'matches-prop', 'watch-attr', 'others', 'if', 'if-not',
  'remove', 'style', 'remove-attr', 'remove-class', 'shadow', 'matches-media', 'nth-ancestor'
];
const SUPPORTED_PROC = new Set(['has-text', 'upward', 'xpath', 'matches-path', 'min-text-length', 'matches-css', 'matches-attr', 'watch-attr']);
const PROC_RE = new RegExp(':(' + PROCEDURAL_OPS.map(s => s.replace(/[-]/g, '\\-')).join('|') + ')\\(', 'g');

function isSafeCss(s) {
  return !/[{}]|\/\*|<\/?style|@import|\\[0-9a-f]{0,6}[{}]/i.test(s) && !s.includes('\n');
}

function parenDepth(s) {
  let depth = 0, quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === '(') depth++; else if (ch === ')') depth--;
  }
  return depth;
}

function readBalanced(s, start) {
  // s[start] === '(' ; returns index of matching ')'
  let depth = 0, quote = null;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Splits a selector into a CSS prefix and procedural steps. Returns null
// when the selector uses an operator we do not support.
export function parseProcedural(sel) {
  const steps = [];
  let action = 'hide', style = null;
  // trailing action operators
  const tail = /:(remove|style)\((.*)\)$/.exec(sel);
  if (tail) {
    const openIdx = sel.lastIndexOf(':' + tail[1] + '(');
    if (readBalanced(sel, openIdx + tail[1].length + 1) === sel.length - 1) {
      if (tail[1] === 'remove') { if (tail[2] !== '') return null; action = 'remove'; }
      else { style = tail[2].trim(); if (!isSafeCss(style) || /url\(|expression|@/i.test(style)) return null; action = 'style'; }
      sel = sel.slice(0, openIdx);
    }
  }
  sel = sel.replace(/:-abp-has\(/g, ':has(').replace(/:-abp-contains\(/g, ':has-text(').replace(/:contains\(/g, ':has-text(').replace(/:nth-ancestor\(/g, ':upward(');

  let i = 0, cssPrefix = null, buf = '';
  const flushCss = () => {
    if (!buf) return;
    if (cssPrefix === null && steps.length === 0) cssPrefix = buf;
    else steps.push(['spath', buf]);
    buf = '';
  };
  while (i < sel.length) {
    PROC_RE.lastIndex = i;
    const m = PROC_RE.exec(sel);
    if (!m) { buf += sel.slice(i); break; }
    buf += sel.slice(i, m.index);
    // An operator nested inside a CSS pseudo-class (:not(:has-text(x)))
    // is not supported.
    if (parenDepth(buf) !== 0) return null;
    flushCss();
    const op = m[1];
    const open = m.index + m[0].length - 1;
    const close = readBalanced(sel, open);
    if (close === -1) return null;
    const arg = sel.slice(open + 1, close);
    if (!SUPPORTED_PROC.has(op)) return null;
    if (op !== 'xpath' && /:(has-text|upward|xpath|matches-)/.test(arg)) return null;
    if (op === 'matches-path' && (cssPrefix !== null || steps.length)) return null;
    if (cssPrefix === null && steps.length === 0 && op !== 'matches-path' && op !== 'xpath') return null;
    steps.push([op, arg]);
    i = close + 1;
  }
  flushCss();
  if (cssPrefix !== null && !isSafeCss(cssPrefix)) return null;
  for (const s of steps) if (s[0] === 'spath' && !isSafeCss(s[1])) return null;
  if (!steps.length) {
    // Plain CSS after operator normalization
    return { css: cssPrefix || '', action, style };
  }
  return { proc: { s: cssPrefix || '', t: steps, a: action === 'style' ? ['style', style] : action } };
}

function tokenForGeneric(sel) {
  // Highly generic if there is a top-level comma or escapes.
  if (sel.includes('\\')) return null;
  let s = sel.replace(/"[^"]*"|'[^']*'/g, '""').replace(/\[[^\]]*\]/g, '');
  let prev;
  do { prev = s; s = s.replace(/\([^()]*\)/g, ''); } while (s !== prev);
  if (s.includes(',')) return null;
  const parts = s.trim().split(/\s*[\s>+~]\s*/);
  const subject = parts[parts.length - 1];
  const m = /([.#])(-?[A-Za-z_][\w-]*)/.exec(subject);
  return m ? m[1] + m[2] : null;
}

function parseCosmeticDomains(str) {
  const include = [], exclude = [];
  let entityOnly = false;
  if (!str) return { include, exclude, generic: true };
  let sawInclude = false;
  for (let p of str.split(',')) {
    p = p.trim();
    if (!p) continue;
    const neg = p.startsWith('~');
    if (neg) p = p.slice(1);
    if (!neg) sawInclude = true;
    if (p.startsWith('/')) continue;
    let d;
    if (p.endsWith('.*')) { const base = normalizeDomain(p.slice(0, -2)); d = base ? base + '.*' : null; }
    else d = normalizeDomain(p);
    if (!d) continue;
    (neg ? exclude : include).push(d);
  }
  if (sawInclude && include.length === 0) entityOnly = true;
  return { include, exclude, generic: !sawInclude, entityOnly };
}

function parseScriptletArgs(body) {
  // body is the content of +js( ... )
  const args = [];
  let cur = '', quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === ',') { cur += ','; i++; continue; }
    if (quote) {
      if (ch === quote && body[i - 1] !== '\\') quote = null;
      else cur += ch;
      continue;
    }
    if ((ch === '"' || ch === "'" || ch === '`') && cur.trim() === '') { quote = ch; cur = ''; continue; }
    if (ch === ',') { args.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  args.push(cur.trim());
  return args;
}

// ------------------------------------------------------------- compileList

function ensureSpec(spec, host) {
  return spec[host] || (spec[host] = {});
}
function pushTo(obj, key, val) {
  (obj[key] || (obj[key] = [])).push(val);
}

/**
 * Compiles filter list text.
 * @param {string} text  raw list text
 * @param {object} opts  { badfilters?: Set<string>, idBase?: number, skipYouTubeScriptlets?: boolean }
 * @returns {{ rules, cosmetic, scriptlets, badfilters, stats }}
 */
export function compileList(text, opts = {}) {
  const lines = preprocess(text);
  const stats = { lines: lines.length, network: 0, cosmetic: 0, scriptlets: 0, skipped: 0, skipReasons: {} };
  const skip = (reason) => { stats.skipped++; stats.skipReasons[reason] = (stats.skipReasons[reason] || 0) + 1; };

  // Pass 1: collect badfilters
  const localBad = new Set();
  for (const l of lines) if (/\$(.*,)?badfilter(,|$)/.test(l) && !COSMETIC_SEP.test(l)) localBad.add(badfilterKey(l));
  const badfilters = opts.badfilters ? new Set([...opts.badfilters, ...localBad]) : localBad;

  const rules = [];
  const seen = new Set();
  // cosmetic: spec[host] = { h:[hide], x:[except], s:[style rules], p:[procedural], f:flags, j:[scriptlet excepts] }
  const spec = Object.create(null);
  const gen = Object.create(null);    // token -> [selectors]
  const hg = [];                      // highly generic selectors
  const genEx = [];                   // generic exceptions (#@#sel with no domain)
  const scriptlets = Object.create(null); // host -> [[name, ...args]]

  const onFlags = ({ hosts, bits }) => {
    for (const h of hosts) { const e = ensureSpec(spec, h); e.f = (e.f || 0) | bits; }
  };

  for (const line of lines) {
    const cm = COSMETIC_SEP.exec(line);
    if (cm && !/[\/|^$\s]/.test(cm[1])) {
      compileCosmetic(cm[1], cm[2], cm[3]);
      continue;
    }
    if (line.includes('##') || line.includes('#@#')) { skip('cosmetic-malformed'); continue; }
    if (/\$(.*,)?badfilter(,|$)/.test(line)) continue;
    if (badfilters.size && badfilters.has(badfilterKey(line))) { skip('badfiltered'); continue; }
    const r = parseNetworkFilter(line, { onFlags });
    if (r.skip) { skip(r.skip); continue; }
    if (r.flags) { onFlags(r.flags); stats.network++; continue; }
    const key = ruleKey(r.rule);
    if (seen.has(key)) { skip('duplicate'); continue; }
    seen.add(key);
    rules.push(r.rule);
    stats.network++;
  }

  const finalRules = finalizeRules(rules, opts.idBase || 1);

  // Drop generic selectors that are excepted globally
  const genExSet = new Set(genEx);
  const finalHg = hg.filter(s => !genExSet.has(s));
  for (const t of Object.keys(gen)) {
    gen[t] = [...new Set(gen[t].filter(s => !genExSet.has(s)))];
    if (!gen[t].length) delete gen[t];
  }
  for (const h of Object.keys(spec)) {
    const e = spec[h];
    for (const k of ['h', 'x', 's', 'j']) if (e[k]) e[k] = [...new Set(e[k])];
  }

  return {
    rules: finalRules,
    quiet: finalRules.quiet,
    cosmetic: { spec, gen, hg: [...new Set(finalHg)] },
    scriptlets,
    badfilters: [...localBad],
    stats
  };

  function compileCosmetic(domainStr, sep, body) {
    const exception = sep.includes('@');
    const kind = sep.replace('@', ''); // ##, #?#, #$#, #%#
    if (kind === '#%#') { skip('adguard-js'); return; }
    const doms = parseCosmeticDomains(domainStr);
    if (doms.entityOnly && !doms.include.length) { skip('cosmetic-entity'); return; }

    // Scriptlets
    if (body.startsWith('+js(') && body.endsWith(')')) {
      const args = parseScriptletArgs(body.slice(4, -1));
      let name = (args.shift() || '').replace(/\.js$/, '');
      if (exception) {
        if (doms.generic) { skip('scriptlet-generic-exception'); return; }
        const key = name ? (SCRIPTLET_ALIASES[name] || name) + '|' + args.join('|') : '*';
        for (const d of doms.include) pushTo(ensureSpec(spec, d), 'j', key);
        return;
      }
      const canonical = SCRIPTLET_ALIASES[name];
      if (!canonical) { skip('scriptlet:' + name); return; }
      if (doms.generic) { skip('scriptlet-generic'); return; }
      const entry = [canonical, ...args];
      let added = 0;
      for (const d of doms.include) {
        if (opts.skipYouTubeScriptlets !== false && isYouTubeHost(d.replace(/\.\*$/, '.com'))) continue;
        pushTo(scriptlets, d, entry);
        added++;
      }
      for (const d of doms.exclude) pushTo(ensureSpec(spec, d), 'j', canonical + '|' + args.join('|'));
      if (added) stats.scriptlets++; else skip('scriptlet-no-host');
      return;
    }
    if (body.startsWith('^')) { skip('html-filter'); return; }

    // AdGuard CSS injection: sel { decl }
    if (kind === '#$#') {
      const m = /^(.+?)\s*\{\s*(.+?)\s*\}$/.exec(body);
      if (!m || doms.generic) { skip('css-injection'); return; }
      const sel = m[1], decl = m[2];
      if (!isSafeCss(sel) || /url\(|expression|@/i.test(decl) || /[{}]/.test(decl)) { skip('css-unsafe'); return; }
      const isRemove = /^remove\s*:\s*true\s*;?$/.test(decl);
      for (const d of doms.include) {
        const e = ensureSpec(spec, d);
        if (exception) pushTo(e, 'x', sel);
        else if (isRemove) pushTo(e, 'h', sel);
        else pushTo(e, 's', `${sel}{${decl}}`);
      }
      stats.cosmetic++;
      return;
    }

    // uBO / AdGuard shorthand: example.com##.sel { height: 0 !important }
    const shorthand = /^([^{}]+?)\s*\{\s*([^{}]+?)\s*\}$/.exec(body);
    if (shorthand && kind === '##') {
      const sel = shorthand[1], decl = shorthand[2];
      if (doms.generic || !isSafeCss(sel) || /url\(|expression|@/i.test(decl)) { skip('css-unsafe'); return; }
      for (const d of doms.include) pushTo(ensureSpec(spec, d), exception ? 'x' : 's', exception ? sel : `${sel}{${decl}}`);
      stats.cosmetic++;
      return;
    }

    const parsed = parseProcedural(body);
    if (!parsed) { skip('procedural-unsupported'); return; }
    if (parsed.proc) {
      if (doms.generic) { skip('procedural-generic'); return; }
      const key = JSON.stringify(parsed.proc);
      for (const d of doms.include) {
        const e = ensureSpec(spec, d);
        if (exception) pushTo(e, 'px', key); else pushTo(e, 'p', parsed.proc);
      }
      stats.cosmetic++;
      return;
    }
    const sel = parsed.css;
    if (!sel || !isSafeCss(sel)) { skip('css-unsafe'); return; }
    if (parsed.action === 'style') {
      if (doms.generic) { skip('style-generic'); return; }
      for (const d of doms.include) pushTo(ensureSpec(spec, d), exception ? 'x' : 's', exception ? sel : `${sel}{${parsed.style}}`);
      stats.cosmetic++;
      return;
    }
    if (exception) {
      if (doms.generic) genEx.push(sel);
      else for (const d of doms.include) pushTo(ensureSpec(spec, d), 'x', sel);
      return;
    }
    if (doms.generic || doms.include.length === 0) {
      // generic, possibly with exclusions (~a.com##.ad)
      const tok = tokenForGeneric(sel);
      if (tok) pushTo(gen, tok, sel); else hg.push(sel);
      for (const d of doms.exclude) pushTo(ensureSpec(spec, d), 'x', sel);
    } else {
      for (const d of doms.include) pushTo(ensureSpec(spec, d), 'h', sel);
      // a.com,~b.a.com##sel -> exception on b.a.com
      for (const d of doms.exclude) pushTo(ensureSpec(spec, d), 'x', sel);
    }
    stats.cosmetic++;
  }
}

// ------------------------------------------------------- rule packing

const PLAIN_HOST_FILTER = /^\|\|([a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?)\^$/;
const BUCKET_TARGET = 300;

// Rules of the form ||host^ that share every other property are merged into
// one rule with a requestDomains list (the technique uBlock Origin Lite
// uses). Same matching semantics, a fraction of the size, and far fewer
// rules for Chrome to index. Large groups are split into hash buckets so a
// list update only replaces the buckets that changed.
function isQuietRule(r) {
  const t = r.action.type;
  return t === 'allow' || t === 'allowAllRequests' || (t === 'redirect' && !!r.action.redirect.transform);
}

export function finalizeRules(rules, idBase = 1) {
  const groups = new Map();
  const out = [];
  for (const r of rules) {
    const c = r.condition;
    const m = c.urlFilter && !c.requestDomains && !c.isUrlFilterCaseSensitive ? PLAIN_HOST_FILTER.exec(c.urlFilter) : null;
    if (!m) { out.push(r); continue; }
    const { urlFilter, ...rest } = c;
    void urlFilter;
    const key = JSON.stringify([r.priority, r.action, rest]);
    let g = groups.get(key);
    if (!g) { g = { r, rest, domains: [] }; groups.set(key, g); }
    g.domains.push(m[1]);
  }
  for (const g of groups.values()) {
    const domains = [...new Set(g.domains)];
    if (domains.length < 3) {
      for (const d of domains) out.push({ ...g.r, condition: { ...g.rest, urlFilter: '||' + d + '^' } });
      continue;
    }
    let buckets = 1;
    while (domains.length / buckets > BUCKET_TARGET) buckets *= 2;
    const parts = Array.from({ length: buckets }, () => []);
    for (const d of domains) parts[buckets === 1 ? 0 : parseInt(fnv1a(d), 16) % buckets].push(d);
    for (const part of parts) {
      if (!part.length) continue;
      part.sort();
      out.push({ ...g.r, condition: { ...g.rest, requestDomains: part } });
    }
  }
  // Exceptions and parameter strippers first, so statistics can tell
  // them apart by id alone; priority 1 is the default and is omitted.
  const quiet = out.filter(isQuietRule), loud = out.filter(r => !isQuietRule(r));
  const final = [...quiet, ...loud].map((r, i) => {
    const rule = { id: idBase + i };
    if (r.priority && r.priority !== 1) rule.priority = r.priority;
    rule.action = r.action;
    rule.condition = r.condition;
    return rule;
  });
  final.quiet = quiet.length;
  return final;
}

// --------------------------------------------- cosmetic (de)serialization

// Compact on-disk format: every selector is stored once with the list of
// hosts it applies to, instead of once per host.
//   r: [[kind, value, "host1,host2"]]   kind: h hide, x exception, s style, j scriptlet exception
//   p: [[procedural, "hosts"]]  q: [[procedural-exception-key, "hosts"]]
//   f: { host: flags }   g: [generic selectors]   hg: [highly generic]
export function packCosmetic(c) {
  const byKey = new Map();
  const add = (kind, value, host) => {
    const k = kind + '\u0000' + value;
    let e = byKey.get(k);
    if (!e) { e = [kind, value, []]; byKey.set(k, e); }
    e[2].push(host);
  };
  const procs = new Map(), procEx = new Map(), f = {};
  for (const [host, e] of Object.entries(c.spec)) {
    for (const kind of ['h', 'x', 's', 'j']) for (const v of e[kind] || []) add(kind, v, host);
    for (const p of e.p || []) { const k = JSON.stringify(p); (procs.get(k) || procs.set(k, []).get(k)).push(host); }
    for (const k of e.px || []) (procEx.get(k) || procEx.set(k, []).get(k)).push(host);
    if (e.f) f[host] = e.f;
  }
  const g = [];
  for (const sels of Object.values(c.gen)) for (const s of sels) g.push(s);
  return {
    r: [...byKey.values()].map(([k, v, h]) => [k, v, h.join(',')]),
    p: [...procs.entries()].map(([k, h]) => [JSON.parse(k), h.join(',')]),
    q: [...procEx.entries()].map(([k, h]) => [k, h.join(',')]),
    f, g: [...new Set(g)], hg: c.hg
  };
}

export function unpackCosmetic(p) {
  if (!p || p.spec) return p; // already unpacked
  const spec = Object.create(null), gen = Object.create(null);
  const at = (h) => spec[h] || (spec[h] = {});
  for (const [kind, value, hosts] of p.r || []) for (const h of hosts.split(',')) pushTo(at(h), kind, value);
  for (const [proc, hosts] of p.p || []) for (const h of hosts.split(',')) pushTo(at(h), 'p', proc);
  for (const [key, hosts] of p.q || []) for (const h of hosts.split(',')) pushTo(at(h), 'px', key);
  for (const [h, flags] of Object.entries(p.f || {})) at(h).f = flags;
  for (const sel of p.g || []) { const t = tokenForGeneric(sel); if (t) pushTo(gen, t, sel); }
  return { spec, gen, hg: p.hg || [] };
}

// Parse a block of user filters. Same as compileList but scriptlets on
// YouTube are allowed (the user asked for them explicitly).
export function compileCustom(text, idBase) {
  return compileList(text, { idBase, skipYouTubeScriptlets: false });
}

// ------------------------------------------------------ cosmetic merging

// Merges per-list cosmetic objects into one index.
export function mergeCosmetic(list) {
  const spec = Object.create(null), gen = Object.create(null);
  const hg = new Set();
  for (const packed of list) {
    const c = unpackCosmetic(packed);
    if (!c) continue;
    for (const [h, e] of Object.entries(c.spec || {})) {
      const t = spec[h] || (spec[h] = {});
      for (const k of ['h', 'x', 's', 'p', 'px', 'j']) if (e[k]) (t[k] || (t[k] = [])).push(...e[k]);
      if (e.f) t.f = (t.f || 0) | e.f;
    }
    for (const [tok, sels] of Object.entries(c.gen || {})) (gen[tok] || (gen[tok] = [])).push(...sels);
    for (const s of c.hg || []) hg.add(s);
  }
  for (const e of Object.values(spec)) {
    for (const k of ['h', 'x', 's', 'px', 'j']) if (e[k]) e[k] = [...new Set(e[k])];
    if (e.p) { const seen = new Set(); e.p = e.p.filter(p => { const k = JSON.stringify(p); if (seen.has(k)) return false; seen.add(k); return true; }); }
  }
  for (const k of Object.keys(gen)) gen[k] = [...new Set(gen[k])];
  return { spec, gen, hg: [...hg] };
}

// Host lookup keys for a hostname: the host, each parent domain, and
// entity forms (example.* for example.com / example.co.uk).
export function hostKeys(host) {
  const keys = [];
  const labels = host.split('.');
  for (let i = 0; i < labels.length; i++) {
    const k = labels.slice(i).join('.');
    if (k) keys.push(k);
  }
  // entity keys: strip 1 or 2 trailing labels
  if (labels.length >= 2) {
    for (let cut = 1; cut <= 2 && cut < labels.length; cut++) {
      const base = labels.slice(0, labels.length - cut);
      for (let i = 0; i < base.length; i++) keys.push(base.slice(i).join('.') + '.*');
    }
  }
  return keys;
}
