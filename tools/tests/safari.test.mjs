// Boots the Safari build (dist-safari/) against fake APIs that behave like
// Safari: no per-rule debug events, no static rule toggles, no match
// testing, no CSS origin option, and every rule checked against what
// Safari's declarativeNetRequest accepts.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';
import { createChrome, safariRuleError } from './fake-chrome.mjs';
import { adaptRuleForSafari, webkitRegexOk } from '../../engine/compiler.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = path.join(REPO, 'dist-safari');
const CACHE = path.join(REPO, 'tools/.cache');

const easylist = fs.readFileSync(path.join(CACHE, 'easylist.txt'), 'utf8');
const UPDATED = easylist + '\n||brand-new-safari-ad.example^\n||another-safari-tracker.example^$script,domain=news.test\n';
const fixtures = {
  'https://raw.githubusercontent.com/': (url) => (url.endsWith('/easylist.txt') ? UPDATED : null)
};

const env = createChrome(ROOT, { fetchFixtures: fixtures, safari: true });
const { chrome, log, tabs } = env;
globalThis.chrome = chrome;
globalThis.self = globalThis;
globalThis.fetch = env.fetchImpl;

const tab = { id: 1, url: 'https://www.example.com/article', active: true };
tabs.set(1, tab);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout');
}
const ext = { id: chrome.runtime.id, url: env.BASE + 'options/options.html' };
function msg(m, sender = ext) {
  return new Promise((resolve, reject) => {
    chrome.runtime.onMessage.fire(m, sender, (res) => (res && res.error ? reject(new Error(res.error)) : resolve(res)));
  });
}

test('adapter maps every Chrome-only feature to Safari equivalents or drops the rule', () => {
  const r = adaptRuleForSafari({ id: 1, action: { type: 'block' }, condition: { urlFilter: '||a.com^', initiatorDomains: ['b.com'], excludedInitiatorDomains: ['c.b.com'], resourceTypes: ['script', 'object'] } });
  assert.deepEqual(r.condition, { urlFilter: '||a.com^', domains: ['b.com'], excludedDomains: ['c.b.com'], resourceTypes: ['script'] });
  assert.equal(adaptRuleForSafari({ id: 1, action: { type: 'block' }, condition: { urlFilter: 'x', resourceTypes: ['object'] } }), null);
  assert.equal(adaptRuleForSafari({ id: 1, action: { type: 'block' }, condition: { urlFilter: 'x', requestMethods: ['post'] } }), null);
  assert.equal(adaptRuleForSafari({ id: 1, action: { type: 'block' }, condition: { regexFilter: 'a|b' } }), null);
  assert.ok(adaptRuleForSafari({ id: 1, action: { type: 'block' }, condition: { regexFilter: '^https?://ad[0-9]+\\.' } }));
  const h = adaptRuleForSafari({ id: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'cookie', operation: 'remove' }], responseHeaders: [{ header: 'set-cookie', operation: 'remove' }] }, condition: { domainType: 'thirdParty' } });
  assert.deepEqual(Object.keys(h.action), ['type', 'requestHeaders']);
  assert.equal(webkitRegexOk('ads\\d+'), false);
});

test('every shipped Safari rule is accepted by Safari', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  let n = 0;
  for (const r of m.declarative_net_request.rule_resources) {
    for (const rule of JSON.parse(fs.readFileSync(path.join(ROOT, r.path), 'utf8'))) {
      assert.equal(safariRuleError(rule), null, `${r.id}#${rule.id}`);
      n++;
    }
  }
  assert.ok(n > 17000, `${n} rules`);
  assert.equal(m.minimum_chrome_version, undefined);
  assert.equal(m.browser_specific_settings.safari.strict_min_version, '16.4');
});

before(async () => {
  await import(path.join(ROOT, 'background.js'));
  chrome.runtime.onInstalled.fire({ reason: 'install' });
  await waitFor(() => env.registered.size > 0 && chrome.contextMenus._items.size > 0);
  await sleep(300);
});

test('installs cleanly: rulesets, Safari-valid dynamic rules, scripts', async () => {
  const want = chrome.runtime.getManifest().declarative_net_request.rule_resources.map(r => r.id);
  assert.deepEqual((await chrome.declarativeNetRequest.getEnabledRulesets()).sort(), want.sort());
  const dyn = env.dynamicRules();
  assert.ok(dyn.some(r => r.id === 11), 'third-party cookie rule present');
  for (const r of dyn) assert.equal(safariRuleError(r), null, 'dynamic #' + r.id);
  const reg = await chrome.scripting.getRegisteredContentScripts();
  assert.equal(reg.find(r => r.id === 'bw-yt-main').world, 'MAIN');
  const o = await msg({ t: 'options' });
  assert.equal(o.rules.canTest, false);
  assert.equal(o.env.debugCounting, false);
});

test('cosmetic CSS still applies when Safari rejects the origin option', async () => {
  log.insertCSS.length = 0;
  const res = await msg({ t: 'frame-init', url: tab.url }, { id: chrome.runtime.id, tab, url: tab.url, frameId: 0 });
  assert.equal(res.on, true);
  assert.ok(log.insertCSS.length >= 1 && !('origin' in log.insertCSS[0]));
});

test('popup counts blocked requests from Safari matched rules', async () => {
  const yt = JSON.parse(fs.readFileSync(path.join(ROOT, 'rulesets/easylist.json'), 'utf8'));
  const blockRule = yt.find(r => r.action.type === 'block');
  chrome.declarativeNetRequest._matched.push(
    { tabId: 1, rule: { rulesetId: 'easylist', ruleId: blockRule.id } },
    { tabId: 1, rule: { rulesetId: 'easylist', ruleId: blockRule.id } },
    { tabId: 1, rule: { rulesetId: 'easylist', ruleId: 1 } } // an exception (quiet)
  );
  env.tabListeners.set(1, () => ({ count: 3 }));
  const st = await msg({ t: 'popup', tabId: 1 }, { id: chrome.runtime.id, url: env.BASE + 'popup/popup.html' });
  assert.equal(st.blocked, 2);
  assert.equal(st.hidden, 3);
});

test('custom filters and list updates produce only Safari-valid rules', async () => {
  await msg({ t: 'save-custom-filters', text: '||mine.example^$domain=a.com|~b.a.com\n||x.example^$object,script\n||post.example^$method=post' });
  await msg({ t: 'update-now', ids: ['easylist'], force: true });
  const dyn = env.dynamicRules();
  for (const r of dyn) assert.equal(safariRuleError(r), null, 'dynamic #' + r.id);
  assert.ok(dyn.some(r => r.condition.domains && r.condition.domains.includes('a.com')));
  const added = dyn.filter(r => r.id >= 100000);
  assert.ok(added.length >= 1 && added.length <= 4, `${added.length} delta rules (only the changed buckets, not a duplicate of the list)`);
});

test('whitelisting and cookie policies work with Safari rules', async () => {
  await msg({ t: 'set-site-enabled', host: 'example.com', enabled: false });
  assert.ok(env.dynamicRules().some(r => r.id === 1));
  await msg({ t: 'set-cookie-policy', host: 'shop.test', policy: 'block' });
  const rule = env.dynamicRules().find(r => r.id === 50);
  assert.ok(rule && !rule.action.responseHeaders && rule.action.requestHeaders.length === 1);
});
