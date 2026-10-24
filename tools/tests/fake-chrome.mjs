// In-memory Chrome extension APIs with the same validation Chrome applies,
// so the real service worker can be booted and exercised in Node.
import fs from 'node:fs';
import path from 'node:path';
import { validateRule } from '../../engine/compiler.js';
import { evaluate } from './dnr-matcher.mjs';

function event() {
  const fns = [];
  return {
    addListener: (f) => fns.push(f),
    removeListener: (f) => { const i = fns.indexOf(f); if (i >= 0) fns.splice(i, 1); },
    hasListener: (f) => fns.includes(f),
    fire: (...a) => fns.map(f => f(...a)),
    get count() { return fns.length; }
  };
}

const PATTERN = /^(\*|https?|wss?|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]+)\/.*$/;
function validPattern(p) { return p === '<all_urls>' || PATTERN.test(p); }

export function createChrome(root, { fetchFixtures = {} } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const BASE = 'chrome-extension://bulwarktest/';
  const log = { insertCSS: [], executeScript: [], removedCookies: [], reloads: [], icons: [], sentToTabs: [] };

  // ---------------------------------------------------------------- storage
  const onChanged = event();
  const area = (name) => {
    const data = {};
    return {
      _data: data,
      async get(keys) {
        if (keys == null) return structuredClone(data);
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: data[k], newValue: structuredClone(v) }; data[k] = structuredClone(v); }
        onChanged.fire(changes, name);
      },
      async remove(keys) { for (const k of [].concat(keys)) delete data[k]; }
    };
  };

  // -------------------------------------------------------------------- DNR
  const staticSets = new Map();
  const enabled = new Set();
  for (const r of manifest.declarative_net_request.rule_resources) {
    staticSets.set(r.id, JSON.parse(fs.readFileSync(path.join(root, r.path), 'utf8')));
    if (r.enabled) enabled.add(r.id);
  }
  const disabledStatic = new Map();
  let dynamic = [];
  const STATIC_POOL = 330000;
  const staticCount = () => [...enabled].reduce((a, id) => a + staticSets.get(id).length, 0);

  const DNR = {
    MAX_NUMBER_OF_DYNAMIC_RULES: 30000, MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000, MAX_NUMBER_OF_REGEX_RULES: 1000,
    onRuleMatchedDebug: event(),
    async getEnabledRulesets() { return [...enabled]; },
    async updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] }) {
      for (const id of [...enableRulesetIds, ...disableRulesetIds]) if (!staticSets.has(id)) throw new Error(`Invalid ruleset id: ${id}.`);
      const next = new Set(enabled);
      disableRulesetIds.forEach(id => next.delete(id));
      enableRulesetIds.forEach(id => next.add(id));
      const n = [...next].reduce((a, id) => a + staticSets.get(id).length, 0);
      if (n > STATIC_POOL) throw new Error('The number of enabled static rules exceeds the rule count limit.');
      enabled.clear(); next.forEach(id => enabled.add(id));
    },
    async getAvailableStaticRuleCount() { return STATIC_POOL - staticCount(); },
    async getDynamicRules() { return structuredClone(dynamic); },
    async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
      const rm = new Set(removeRuleIds);
      const next = dynamic.filter(r => !rm.has(r.id));
      const ids = new Set(next.map(r => r.id));
      for (const r of addRules) {
        const err = validateRule(r);
        if (err) throw new Error(`Rule with id ${r.id}: ${err}`);
        if (ids.has(r.id)) throw new Error(`Rule with id ${r.id} does not have a unique ID.`);
        ids.add(r.id);
        next.push(structuredClone(r));
      }
      if (next.length > 30000) throw new Error('Dynamic rule count exceeded.');
      if (next.filter(r => r.condition.regexFilter).length > 1000) throw new Error('Regex rule count exceeded.');
      if (next.filter(r => r.action.type === 'redirect' || r.action.type === 'modifyHeaders').length > 5000) throw new Error('Unsafe rule count exceeded.');
      dynamic = next;
    },
    async getDisabledRuleIds({ rulesetId }) { return [...(disabledStatic.get(rulesetId) || [])]; },
    async updateStaticRules({ rulesetId, enableRuleIds = [], disableRuleIds = [] }) {
      if (!staticSets.has(rulesetId)) throw new Error('bad ruleset');
      const s = disabledStatic.get(rulesetId) || new Set();
      enableRuleIds.forEach(id => s.delete(id));
      disableRuleIds.forEach(id => s.add(id));
      if (s.size > 5000) throw new Error('too many disabled');
      disabledStatic.set(rulesetId, s);
    },
    async setExtensionActionOptions() {},
    async testMatchOutcome(req) {
      const sets = [...enabled].map(id => ({ id, rules: staticSets.get(id).filter(r => !(disabledStatic.get(id) || new Set()).has(r.id)) }));
      sets.push({ id: '_dynamic', rules: dynamic });
      const out = evaluate(sets, { ...req, documentUrl: req.initiator });
      return { matchedRules: out.rule ? [{ ruleId: out.rule.id, rulesetId: out.ruleset }] : [] };
    },
    _evaluate(req) {
      const sets = [...enabled].map(id => ({ id, rules: staticSets.get(id).filter(r => !(disabledStatic.get(id) || new Set()).has(r.id)) }));
      sets.push({ id: '_dynamic', rules: dynamic });
      return evaluate(sets, req);
    }
  };

  // -------------------------------------------------------------- scripting
  const registered = new Map();
  const checkScript = (s) => {
    if (!s.id || s.id.startsWith('_')) throw new Error('bad id');
    if (!Array.isArray(s.matches) || !s.matches.length) throw new Error(`Script with ID '${s.id}' must specify 'matches'.`);
    for (const p of [...s.matches, ...(s.excludeMatches || [])]) if (!validPattern(p)) throw new Error(`Script with ID '${s.id}' has invalid value for 'matches[0]': ${p}`);
    for (const f of [...(s.js || []), ...(s.css || [])]) if (!fs.existsSync(path.join(root, f))) throw new Error(`Could not load file: '${f}'.`);
  };
  const scripting = {
    async registerContentScripts(list) {
      for (const s of list) { if (registered.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`); checkScript(s); }
      for (const s of list) registered.set(s.id, structuredClone(s));
    },
    async updateContentScripts(list) {
      for (const s of list) {
        if (!registered.has(s.id)) throw new Error(`Script with ID '${s.id}' does not exist`);
        const merged = { ...registered.get(s.id), ...s };
        checkScript(merged);
        registered.set(s.id, structuredClone(merged));
      }
    },
    async unregisterContentScripts({ ids } = {}) {
      if (!ids) registered.clear(); else for (const id of ids) { if (!registered.has(id)) throw new Error(`Nonexistent script ID '${id}'`); registered.delete(id); }
    },
    async getRegisteredContentScripts() { return [...registered.values()].map(s => structuredClone(s)); },
    async insertCSS(o) { log.insertCSS.push(o); },
    async executeScript(o) { log.executeScript.push(o); return [{ result: undefined }]; }
  };

  // ----------------------------------------------------------------- tabs
  const tabs = new Map();
  const tabListeners = new Map(); // tabId -> fn(msg) returning response
  const chrome = {
    runtime: {
      id: 'bulwarktest',
      getManifest: () => manifest,
      getURL: (p) => BASE + p.replace(/^\//, ''),
      onInstalled: event(), onStartup: event(), onMessage: event(),
      openOptionsPage: async () => {},
      lastError: undefined
    },
    storage: { local: area('local'), session: area('session'), onChanged },
    declarativeNetRequest: DNR,
    scripting,
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error('No tab'); return { ...tabs.get(id) }; },
      async query() { return [...tabs.values()].map(t => ({ ...t })); },
      async reload(id) { log.reloads.push(id); },
      async create(o) { return o; },
      async sendMessage(id, msg) { log.sentToTabs.push(msg); const fn = tabListeners.get(id); return fn ? fn(msg) : undefined; },
      onRemoved: event(), onActivated: event(), onUpdated: event()
    },
    webNavigation: { onBeforeNavigate: event(), onCommitted: event() },
    webRequest: { onErrorOccurred: event() },
    cookies: {
      onChanged: event(),
      _jar: [],
      async getAll({ domain } = {}) { return chrome.cookies._jar.filter(c => !domain || c.domain.replace(/^\./, '').endsWith(domain)); },
      async remove(d) { log.removedCookies.push(d); chrome.cookies._jar = chrome.cookies._jar.filter(c => c.name !== d.name); return d; }
    },
    contextMenus: {
      _items: new Map(),
      create(o, cb) { chrome.contextMenus._items.set(o.id, o); cb && cb(); },
      update(id, o, cb) { Object.assign(chrome.contextMenus._items.get(id) || {}, o); cb && cb(); },
      async removeAll() { chrome.contextMenus._items.clear(); },
      onClicked: event()
    },
    action: {
      async setIcon(o) { log.icons.push(o); }, setBadgeBackgroundColor() {}, setBadgeTextColor() {}
    },
    alarms: {
      _a: new Map(),
      create(name, o) { chrome.alarms._a.set(name, { name, ...o }); },
      async get(name) { return chrome.alarms._a.get(name); },
      async clear(name) { return chrome.alarms._a.delete(name); },
      onAlarm: event()
    }
  };

  const realFetch = globalThis.fetch;
  const fetchImpl = async (url, opts) => {
    url = String(url);
    if (url.startsWith(BASE)) {
      const f = path.join(root, decodeURIComponent(url.slice(BASE.length).split('?')[0]));
      if (!fs.existsSync(f)) return new Response('', { status: 404 });
      return new Response(fs.readFileSync(f));
    }
    for (const [prefix, body] of Object.entries(fetchFixtures)) {
      if (url.startsWith(prefix)) {
        const b = typeof body === 'function' ? body(url) : body;
        if (b === null) return new Response('not found', { status: 404 });
        return new Response(b, { status: 200 });
      }
    }
    void realFetch; void opts;
    throw new TypeError('fetch blocked in test: ' + url);
  };

  return { chrome, log, tabs, tabListeners, registered, fetchImpl, dynamicRules: () => dynamic, disabledStatic, enabled, BASE };
}
