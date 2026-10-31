// Boots the real service worker against in-memory Chrome APIs and walks
// through install, cosmetics, popup actions, cookies, custom filters,
// list updates, statistics and backup.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';
import { createChrome } from './fake-chrome.mjs';

// BW_DIST=1 runs the same suite against the minified dist/ build.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = process.env.BW_DIST ? path.join(REPO, 'dist') : REPO;
const CACHE = path.join(REPO, 'tools/.cache');
const easylist = fs.readFileSync(path.join(CACHE, 'easylist.txt'), 'utf8');

// Simulated upstream change: drop three network filters, add two new ones.
const lines = easylist.split('\n');
const dropped = [];
const updatedLines = lines.filter((l) => {
  if (dropped.length < 3 && /^\|\|[a-z0-9.-]+\^\$third-party$/.test(l)) { dropped.push(l); return false; }
  return true;
});
updatedLines.push('||brand-new-ad-network.example^', '||another-new-tracker.example^$script');
const UPDATED_EASYLIST = updatedLines.join('\n');

const fetched = [];
const fixtures = {
  'https://raw.githubusercontent.com/': (url) => {
    fetched.push(url);
    if (url.endsWith('/easylist.txt')) return UPDATED_EASYLIST;
    const id = { 'easyprivacy.txt': 'easyprivacy', 'filters.txt': 'ubo-filters', 'quick-fixes.txt': 'ubo-quick-fixes', 'unbreak.txt': 'ubo-unbreak', 'privacy.txt': 'ubo-privacy', 'brave-unbreak.txt': 'brave-unbreak', 'brave-specific.txt': 'brave-specific' }[url.split('/').pop()];
    return id ? fs.readFileSync(path.join(CACHE, id + '.txt'), 'utf8') : null;
  },
  'https://sponsor.ajay.app/api/skipSegments/': JSON.stringify([{ videoID: 'dQw4w9WgXcQ', segments: [{ segment: [30, 60], category: 'sponsor', actionType: 'skip' }, { segment: [100, 110], category: 'intro', actionType: 'skip' }] }])
};

const env = createChrome(ROOT, { fetchFixtures: fixtures });
const { chrome, log, tabs } = env;
globalThis.chrome = chrome;
globalThis.self = globalThis;
globalThis.fetch = (url, o) => { if (String(url).startsWith('https://sponsor')) fetched.push(String(url)); return env.fetchImpl(url, o); };
// Minimal canvas so the faded "off" icon can be drawn.
globalThis.createImageBitmap = async () => ({});
globalThis.OffscreenCanvas = class { constructor(w, h) { this.w = w; this.h = h; } getContext() { const w = this.w, h = this.h; return { drawImage() {}, getImageData: () => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) }; } };

const tabEx = { id: 1, url: 'https://www.example.com/article', active: true };
const tabYt = { id: 2, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', active: false };
tabs.set(1, tabEx);
tabs.set(2, tabYt);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(25); }
  throw new Error('timeout waiting for condition');
}

// Sends a message through the real onMessage listener.
function msg(m, sender = { id: chrome.runtime.id, url: env.BASE + 'options/options.html' }) {
  return new Promise((resolve, reject) => {
    const results = chrome.runtime.onMessage.fire(m, sender, (res) => {
      if (res && res.error) reject(new Error(res.error)); else resolve(res);
    });
    if (!results.includes(true)) resolve(undefined);
  });
}
const contentSender = (tab, url, frameId = 0) => ({ id: chrome.runtime.id, tab, url, frameId, documentId: 'doc-' + tab.id + '-' + frameId });
const popupSender = { id: 'bulwarktest', url: 'chrome-extension://bulwarktest/popup/popup.html' };

before(async () => {
  await import(process.env.BW_DIST ? path.join(ROOT, 'background.js') : '../../background/sw.js');
  chrome.runtime.onInstalled.fire({ reason: 'install' });
  await waitFor(() => env.registered.size > 0 && chrome.contextMenus._items.size > 0);
  await sleep(300);
});

test('strict privacy is on by default: no alarms, no network', async () => {
  assert.equal(chrome.alarms._a.has('bw-update'), false);
  assert.deepEqual(fetched, []);
  const o = await msg({ t: 'options' });
  assert.equal(o.settings.privacy.strict, true);
  assert.equal(o.settings.youtube.sponsorblock, false);
});

test('messages from other extensions are refused', async () => {
  await assert.rejects(msg({ t: 'options' }, { id: 'someone-else', url: 'chrome-extension://someone-else/x.html' }), /Not allowed/);
});

test('web accessible resources use dynamic URLs and the CSP limits connections', () => {
  const m = chrome.runtime.getManifest();
  assert.equal(m.web_accessible_resources[0].use_dynamic_url, true);
  assert.match(m.content_security_policy.extension_pages, /connect-src 'self' https:/);
  assert.ok(!m.permissions.includes('unlimitedStorage'));
});

test('install enables every bundled ruleset and the YouTube ruleset', async () => {
  const want = chrome.runtime.getManifest().declarative_net_request.rule_resources.map(r => r.id);
  assert.deepEqual((await chrome.declarativeNetRequest.getEnabledRulesets()).sort(), want.sort());
});

test('install registers YouTube, scriptlet and cookie scripts', async () => {
  const reg = await chrome.scripting.getRegisteredContentScripts();
  const ids = reg.map(r => r.id);
  for (const id of ['bw-yt-main', 'bw-yt-iso', 'bw-sl-ubo-filters', 'bw-ck-necessary']) assert.ok(ids.includes(id), id);
  assert.equal(reg.find(r => r.id === 'bw-yt-main').world, 'MAIN');
  assert.deepEqual(reg.find(r => r.id === 'bw-ck-necessary').matches, ['<all_urls>']);
  assert.ok(!ids.includes('bw-ck-block'));
});

test('install adds third-party cookie rules', async () => {
  const ids = env.dynamicRules().map(r => r.id);
  assert.ok(ids.includes(10) && ids.includes(11) && ids.includes(20));
  const out = chrome.declarativeNetRequest._evaluate({ url: 'https://ib.adnxs.com/getuid', type: 'image', initiator: 'https://news.example.com' });
  assert.equal(out.action, 'block');
});

test('CSS is injected at navigation commit, before the content script asks', async () => {
  log.insertCSS.length = 0;
  await Promise.all(chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, url: tabEx.url, documentId: 'doc-1-0' }));
  await sleep(20);
  assert.equal(log.insertCSS.length, 1);
  assert.equal(log.insertCSS[0].origin, 'USER');
  assert.deepEqual(log.insertCSS[0].target.documentIds, ['doc-1-0']);
  assert.ok(log.insertCSS[0].css.split('\n').length > 100, 'highly generic selectors applied');
  const t0 = performance.now();
  const res = await msg({ t: 'frame-init', url: tabEx.url }, contentSender(tabEx, tabEx.url));
  const ms = performance.now() - t0;
  assert.equal(res.on, true);
  assert.equal(res.generic, true);
  assert.equal(log.insertCSS.length, 1, 'no second injection for the same document');
  assert.ok(ms < 50, `frame-init answered in ${ms.toFixed(1)} ms`);

  log.insertCSS.length = 0;
  const yt = await msg({ t: 'frame-init', url: tabYt.url }, contentSender(tabYt, tabYt.url));
  assert.equal(yt.on, true);
  assert.equal(yt.generic, false);
  assert.ok(log.insertCSS[0].css.includes('ytd-merch-shelf-renderer'));
});

test('generic tokens resolve to selectors only once per frame', async () => {
  const gen = JSON.parse(fs.readFileSync(path.join(ROOT, 'generated/cosmetic/easylist.json'), 'utf8')).g;
  const sel = gen.find(x => /^\.[a-z][\w-]+$/i.test(x));
  log.insertCSS.length = 0;
  await msg({ t: 'tokens', url: tabEx.url, tokens: [sel, '.definitely-not-an-ad-class'] }, contentSender(tabEx, tabEx.url));
  assert.ok(log.insertCSS.some(c => c.css.includes(sel + '{')));
  log.insertCSS.length = 0;
  await msg({ t: 'tokens', url: tabEx.url, tokens: [sel] }, contentSender(tabEx, tabEx.url));
  assert.equal(log.insertCSS.length, 0);
});

test('content scripts cannot call privileged messages', async () => {
  await assert.rejects(msg({ t: 'save-settings', patch: { enabled: false } }, contentSender(tabEx, tabEx.url)), /Not allowed/);
});

test('popup state, site toggle and whitelist rule', async () => {
  let countSels = null;
  env.tabListeners.set(1, (m) => { countSels = m.sels; return { count: 7 }; });
  let st = await msg({ t: 'popup', tabId: 1 }, popupSender);
  assert.equal(st.host, 'example.com');
  assert.equal(st.siteEnabled, true);
  assert.equal(st.hidden, 7);
  assert.ok(Array.isArray(countSels) && countSels.length > 100, 'popup sends the applied selectors for counting: ' + (countSels && countSels.length));
  assert.equal(st.strict, true);
  assert.ok(st.lists.filters > 100000);

  await msg({ t: 'set-site-enabled', host: 'example.com', enabled: false }, popupSender);
  const wl = env.dynamicRules().find(r => r.id === 1);
  assert.deepEqual(wl.condition.requestDomains, ['example.com']);
  assert.equal(chrome.declarativeNetRequest._evaluate({ url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js', type: 'script', initiator: 'https://www.example.com', documentUrl: 'https://www.example.com/' }).action, 'allow');
  const reg = await chrome.scripting.getRegisteredContentScripts();
  assert.ok(reg.find(r => r.id === 'bw-yt-iso').excludeMatches.includes('*://*.example.com/*'));
  const off = await msg({ t: 'frame-init', url: tabEx.url }, contentSender(tabEx, tabEx.url));
  assert.equal(off.on, false);
  st = await msg({ t: 'popup', tabId: 1 }, popupSender);
  assert.equal(st.siteEnabled, false);

  await msg({ t: 'set-site-enabled', host: 'example.com', enabled: true }, popupSender);
  assert.equal(env.dynamicRules().find(r => r.id === 1), undefined);
  assert.equal(chrome.declarativeNetRequest._evaluate({ url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js', type: 'script', initiator: 'https://www.example.com', documentUrl: 'https://www.example.com/' }).action !== 'allow', true);
});

test('cookie policies: classification, block-all rule, guard registration and sweep', async () => {
  const fire = (cookie) => Promise.all(chrome.cookies.onChanged.fire({ removed: false, cookie, cause: 'explicit' }));
  log.removedCookies.length = 0;
  await fire({ name: '_ga', domain: '.example.com', path: '/', secure: true, session: false, storeId: '0' });
  await fire({ name: 'PHPSESSID', domain: 'www.example.com', path: '/', secure: true, session: true, storeId: '0' });
  await fire({ name: 'theme', domain: 'www.example.com', path: '/', secure: true, session: false, storeId: '0' });
  const removed = log.removedCookies.map(c => c.name);
  assert.deepEqual(removed.sort(), ['_ga', 'theme']);

  chrome.cookies._jar = [{ name: 'PHPSESSID', domain: 'shop.test', path: '/', session: true, storeId: '0' }];
  log.removedCookies.length = 0;
  await msg({ t: 'set-cookie-policy', host: 'shop.test', policy: 'block' }, popupSender);
  const rule = env.dynamicRules().find(r => r.id === 50);
  assert.deepEqual(rule.condition.requestDomains, ['shop.test']);
  assert.ok(rule.condition.resourceTypes.includes('main_frame'));
  const reg = await chrome.scripting.getRegisteredContentScripts();
  assert.deepEqual(reg.find(r => r.id === 'bw-ck-block').matches, ['*://*.shop.test/*']);
  assert.ok(reg.find(r => r.id === 'bw-ck-necessary').excludeMatches.includes('*://*.shop.test/*'));
  assert.deepEqual(log.removedCookies.map(c => c.name), ['PHPSESSID']);

  await msg({ t: 'set-cookie-policy', host: 'shop.test', policy: 'allow' }, popupSender);
  assert.ok(env.dynamicRules().find(r => r.id === 11).condition.excludedInitiatorDomains.includes('shop.test'));
  assert.equal(env.dynamicRules().find(r => r.id === 50), undefined);
});

test('custom filters become top-priority rules, CSS and scriptlets', async () => {
  const res = await msg({ t: 'save-custom-filters', text: [
    '! mine', '||my-ads.example^', '@@||doubleclick.net/allowed.js$script', 'blog.test##.promo-box', 'blog.test##+js(set-constant, adsEnabled, false)', 'not a valid $$$ filter$bogus'
  ].join('\n') });
  assert.equal(res.network, 2);
  assert.ok(res.skipped >= 1);
  const custom = env.dynamicRules().filter(r => r.id >= 1000 && r.id < 100000);
  assert.equal(custom.find(r => r.action.type === 'block').priority, 5);
  assert.equal(custom.find(r => r.action.type === 'allow').priority, 6);

  const tab = { id: 3, url: 'https://blog.test/post' };
  tabs.set(3, tab);
  log.insertCSS.length = 0;
  const fi = await msg({ t: 'frame-init', url: tab.url }, contentSender(tab, tab.url));
  assert.equal(fi.on, true);
  assert.ok(log.insertCSS.some(c => c.css.includes('.promo-box{')));

  log.executeScript.length = 0;
  await Promise.all(chrome.webNavigation.onCommitted.fire({ tabId: 3, frameId: 0, url: tab.url }));
  await sleep(20);
  const inj = log.executeScript.find(e => e.func);
  assert.ok(inj, 'scriptlet overlay injected');
  assert.equal(inj.world, 'MAIN');
  assert.equal(inj.injectImmediately, true);
  assert.deepEqual(inj.args[0], [['set-constant', 'adsEnabled', 'false']]);
});

test('picker adds a cosmetic filter for the frame host and applies it immediately', async () => {
  log.insertCSS.length = 0;
  const r = await msg({ t: 'picker-add', selector: 'div.sticky-ad' }, contentSender(tabEx, 'https://www.example.com/article'));
  assert.equal(r.ok, true);
  const { customFilters } = await chrome.storage.local.get('customFilters');
  assert.ok(customFilters.includes('example.com##div.sticky-ad'));
  assert.ok(log.insertCSS.some(c => c.css.includes('div.sticky-ad')));
  await assert.rejects(msg({ t: 'picker-add', selector: 'x{}' }, contentSender(tabEx, tabEx.url)).then(r2 => { if (!r2.ok) throw new Error('rejected'); }), /rejected/);
});

test('list update diffs against the bundled snapshot', async () => {
  const res = await msg({ t: 'update-now', ids: ['easylist'], force: true });
  assert.equal(res.results[0].updated, true);
  // Host filters live in hash buckets: only the buckets touched by the
  // change are swapped (static bucket disabled, updated bucket added).
  const disabled = await chrome.declarativeNetRequest.getDisabledRuleIds({ rulesetId: 'easylist' });
  assert.ok(disabled.length >= 1 && disabled.length <= 5, `${disabled.length} buckets replaced`);
  const added = env.dynamicRules().filter(r => r.id >= 100000);
  assert.ok(added.length >= disabled.length && added.length <= disabled.length + 2);
  assert.equal(chrome.declarativeNetRequest._evaluate({ url: 'https://brand-new-ad-network.example/x.js', type: 'script', initiator: 'https://news.test' }).action, 'block');
  const removedHost = /^\|\|([a-z0-9.-]+)\^/.exec(dropped[0])[1];
  const out = chrome.declarativeNetRequest._evaluate({ url: `https://${removedHost}/a.js`, type: 'script', initiator: 'https://news.test' });
  assert.notEqual(out.ruleset, 'easylist', 'removed upstream rule no longer matches from easylist');
  // unchanged content is detected on the next regular check
  const again = await msg({ t: 'update-now', ids: ['easylist'] });
  assert.equal(again.results[0].unchanged, true);
});

test('disabling a list turns off its ruleset, deltas and cosmetics', async () => {
  await msg({ t: 'save-settings', patch: { lists: { easylist: false } } });
  assert.ok(!(await chrome.declarativeNetRequest.getEnabledRulesets()).includes('easylist'));
  assert.equal(env.dynamicRules().filter(r => r.id >= 100000).length, 0);
  assert.equal((await chrome.declarativeNetRequest.getDisabledRuleIds({ rulesetId: 'easylist' })).length, 0);
  await msg({ t: 'save-settings', patch: { lists: { easylist: true } } });
  assert.ok((await chrome.declarativeNetRequest.getEnabledRulesets()).includes('easylist'));
  assert.ok(env.dynamicRules().filter(r => r.id >= 100000).length >= 1);
});

test('YouTube settings drive registrations and the ping ruleset', async () => {
  await msg({ t: 'save-settings', patch: { youtube: { prune: false, blockPings: false } } });
  let reg = await chrome.scripting.getRegisteredContentScripts();
  assert.ok(!reg.some(r => r.id === 'bw-yt-main'));
  assert.ok(!(await chrome.declarativeNetRequest.getEnabledRulesets()).includes('bulwark-youtube'));
  await msg({ t: 'save-settings', patch: { youtube: { prune: true, blockPings: true } } });
  reg = await chrome.scripting.getRegisteredContentScripts();
  assert.ok(reg.some(r => r.id === 'bw-yt-main'));
});

test('YouTube page loads are redirected to the ad-free variant, once', async () => {
  const rules = env.dynamicRules();
  const allow = rules.find(r => r.id === 3), redirect = rules.find(r => r.id === 4);
  assert.ok(allow && redirect, 'ad-free rules installed by default');
  assert.ok(allow.priority > redirect.priority);
  const reg = (await chrome.scripting.getRegisteredContentScripts()).find(r => r.id === 'bw-yt-main');
  assert.deepEqual(reg.js, ['content/youtube-flag.js', 'content/youtube-main.js']);
  // Same semantics as Chrome's matcher for these simple patterns. Chrome
  // may or may not escape the '=' in the value; both forms must stop the loop.
  const kv = redirect.action.redirect.transform.queryTransform.addOrReplaceParams;
  assert.deepEqual(kv, [{ key: 'pp', value: 'eAE=' }]);
  const go = (url, escape = true) => {
    if (new RegExp(allow.condition.regexFilter, 'i').test(url)) return url;
    if (!new RegExp(redirect.condition.regexFilter, 'i').test(url)) return url;
    const u = new URL(url);
    const q = u.search.slice(1).split('&').filter(x => x && !x.startsWith('pp='));
    q.push('pp=' + (escape ? 'eAE%3D' : 'eAE='));
    u.search = '?' + q.join('&');
    return u.href;
  };
  for (const escape of [true, false]) {
    const v = escape ? 'eAE%3D' : 'eAE=';
    const once = go('https://www.youtube.com/watch?v=dQw4w9WgXcQ', escape);
    assert.equal(once, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&pp=' + v);
    assert.equal(go(once, escape), once, 'no redirect loop');
    assert.equal(go('https://www.youtube.com/watch?v=x&pp=ygUFbXVzaWM%3D&t=4', escape), 'https://www.youtube.com/watch?v=x&t=4&pp=' + v, 'a tracking pp is replaced');
    assert.equal(go('https://www.youtube.com/watch?v=x&app=desktop', escape), 'https://www.youtube.com/watch?v=x&app=desktop&pp=' + v, 'app= is not pp=');
  }
  assert.equal(go('https://www.youtube.com/shorts/abc'), 'https://www.youtube.com/shorts/abc');
  assert.equal(go('https://www.youtube.com/embed/abc'), 'https://www.youtube.com/embed/abc');
  assert.deepEqual(redirect.condition.resourceTypes, ['main_frame']);
  // Off with the setting, on a whitelisted YouTube and while paused.
  await msg({ t: 'save-settings', patch: { youtube: { adFree: false } } });
  assert.ok(!env.dynamicRules().some(r => r.id === 3 || r.id === 4));
  assert.deepEqual((await chrome.scripting.getRegisteredContentScripts()).find(r => r.id === 'bw-yt-main').js, ['content/youtube-main.js']);
  await msg({ t: 'save-settings', patch: { youtube: { adFree: true } } });
  await msg({ t: 'set-site-enabled', host: 'youtube.com', enabled: false }, popupSender);
  assert.ok(!env.dynamicRules().some(r => r.id === 4));
  await msg({ t: 'set-site-enabled', host: 'youtube.com', enabled: true }, popupSender);
  assert.ok(env.dynamicRules().some(r => r.id === 4));
});

test('SponsorBlock: off under strict privacy, hash-prefix lookups when allowed', async () => {
  fetched.length = 0;
  let r = await msg({ t: 'sb-segments', id: 'dQw4w9WgXcQ', categories: ['sponsor'] }, contentSender(tabYt, tabYt.url));
  assert.deepEqual(r.segments, []);
  await msg({ t: 'save-settings', patch: { youtube: { sponsorblock: true } } });
  r = await msg({ t: 'sb-segments', id: 'dQw4w9WgXcQ', categories: ['sponsor'] }, contentSender(tabYt, tabYt.url));
  assert.deepEqual(r.segments, [], 'still off while strict privacy is on');
  assert.deepEqual(fetched, []);
  await msg({ t: 'save-settings', patch: { privacy: { strict: false } } });
  assert.ok(chrome.alarms._a.has('bw-update'), 'automatic updates resume');
  r = await msg({ t: 'sb-segments', id: 'dQw4w9WgXcQ', categories: ['sponsor'] }, contentSender(tabYt, tabYt.url));
  assert.deepEqual(r.segments, [{ start: 30, end: 60, category: 'sponsor' }]);
  assert.equal(fetched.length, 1);
  assert.match(fetched[0], /\/api\/skipSegments\/[0-9a-f]{4}\?/);
  assert.ok(!fetched[0].includes('dQw4w9WgXcQ'), 'video id never leaves the browser');
  const bad = await msg({ t: 'sb-segments', id: '../../etc' }, contentSender(tabYt, tabYt.url));
  assert.deepEqual(bad.segments, []);
  await msg({ t: 'save-settings', patch: { privacy: { strict: true }, youtube: { sponsorblock: false } } });
  assert.equal(chrome.alarms._a.has('bw-update'), false);
});

test('custom lists must be plain https URLs', async () => {
  await assert.rejects(msg({ t: 'add-custom-list', url: 'http://example.com/list.txt' }), /https/);
  await assert.rejects(msg({ t: 'add-custom-list', url: 'https://user:pw@example.com/list.txt' }), /https/);
});

test('statistics: rule matches, YouTube counters, dashboard', async () => {
  await Promise.all(chrome.webNavigation.onBeforeNavigate.fire({ tabId: 2, frameId: 0, url: tabYt.url }));
  const ytRule = JSON.parse(fs.readFileSync(path.join(ROOT, 'rulesets/bulwark-youtube.json'), 'utf8'))[0];
  for (let i = 0; i < 4; i++) {
    await Promise.all(chrome.declarativeNetRequest.onRuleMatchedDebug.fire({ request: { tabId: 2, url: 'https://www.youtube.com/api/stats/ads?x=' + i, type: 'xmlhttprequest' }, rule: { ruleId: ytRule.id, rulesetId: 'bulwark-youtube' } }));
  }
  await Promise.all(chrome.declarativeNetRequest.onRuleMatchedDebug.fire({ request: { tabId: 2, url: 'https://x.test/', type: 'image' }, rule: { ruleId: 11, rulesetId: '_dynamic' } }));
  await msg({ t: 'yt-stats', pruned: 2, skipped: 1, sb: 1, cost: 40, samples: 4 }, contentSender(tabYt, tabYt.url));
  await sleep(10);
  const st = await msg({ t: 'popup', tabId: 2 }, popupSender);
  assert.equal(st.blocked, 4);
  assert.equal(st.yt, 3);
  assert.ok(st.cookies >= 1);
  const o = await msg({ t: 'options' });
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(o.stats.days[today].blocked >= 4);
  assert.ok(o.stats.top.some(([d]) => d === 'youtube.com'));
  assert.ok(o.rules.canTest);
});

test('test-url tool reports the matching rule', async () => {
  const r = await msg({ t: 'test-url', url: 'https://www.youtube.com/api/stats/ads?ver=2', initiator: 'https://www.youtube.com', type: 'xmlhttprequest' });
  assert.ok(r.matched.length >= 1);
});

test('export and import round-trip, invalid backups rejected', async () => {
  const backup = await msg({ t: 'export' });
  assert.equal(backup.app, 'bulwark');
  backup.settings.whitelist = ['kept.test', 'not a host'];
  backup.settings.cookies.sites = { 'a.test': 'allow', 'bad host': 'allow', 'b.test': 'bogus' };
  await msg({ t: 'import', data: backup });
  const o = await msg({ t: 'options' });
  assert.deepEqual(o.settings.whitelist, ['kept.test']);
  assert.deepEqual(o.settings.cookies.sites, { 'a.test': 'allow' });
  await assert.rejects(msg({ t: 'import', data: { hello: 1 } }), /Not a Bulwark backup/);
});

test('pausing everywhere adds a global allow rule and grey icons', async () => {
  log.icons.length = 0;
  await msg({ t: 'set-global', enabled: false }, popupSender);
  assert.ok(env.dynamicRules().some(r => r.id === 2));
  await sleep(20);
  assert.ok(log.icons.some(i => i.imageData && i.imageData[16].width === 16), 'faded icon drawn at runtime');
  await msg({ t: 'set-global', enabled: true }, popupSender);
  assert.ok(!env.dynamicRules().some(r => r.id === 2));
});
