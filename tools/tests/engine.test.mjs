// Compiler, scriptlets, cosmetic content script and cookie guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { parseNetworkFilter, compileList, mergeCosmetic, hostKeys, parseProcedural } from '../../engine/compiler.js';
import { bulwarkScriptlets, buildScriptletFile } from '../../engine/scriptlets.js';
import { keepCookie } from '../../engine/cookies.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = process.env.BW_DIST ? path.join(REPO, 'dist') : REPO; // BW_DIST=1 tests the minified build

test('network filter conversion', () => {
  const r = (l) => parseNetworkFilter(l).rule;
  assert.deepEqual(r('||ads.example.com^').condition, { urlFilter: '||ads.example.com^' });
  const x = r('||example.com/ads/*$script,third-party,domain=a.com|~b.a.com');
  assert.deepEqual(x.condition.resourceTypes, ['script']);
  assert.equal(x.condition.domainType, 'thirdParty');
  assert.deepEqual(x.condition.initiatorDomains, ['a.com']);
  assert.deepEqual(x.condition.excludedInitiatorDomains, ['b.a.com']);
  assert.equal(r('@@||example.com/ok.js$script').action.type, 'allow');
  assert.equal(r('@@||site.com^$document').action.type, 'allowAllRequests');
  assert.equal(r('||a.com^$important').priority, 3);
  assert.deepEqual(r('||a.com^$~script').condition.excludedResourceTypes, ['main_frame', 'script']);
  assert.equal(r('||gtm.example^$script,redirect=noopjs').action.redirect.extensionPath, '/resources/noop.js');
  assert.deepEqual(r('$removeparam=utm_source').action.redirect.transform.queryTransform.removeParams, ['utm_source']);
  assert.equal(r('/ad/img/*$image,domain=~x.com|~y.com').condition.urlFilter, '/ad/img/*');
  assert.equal(r('/banner\\d+/$image').condition.regexFilter, 'banner\\d+');
  for (const bad of ['$script', '/(?!x)y/', '||x.com^$popup', '||x.com^$csp=a', '||a.com^$domain=b.*', '$removeparam', '|a|b|']) {
    assert.ok(parseNetworkFilter(bad).skip, `should skip ${bad}`);
  }
});

test('cosmetic compilation, exceptions and lookups', () => {
  const c = compileList([
    '##.ad-banner', 'example.com##.promo', 'example.com,~shop.example.com##.wide', 'example.com#@#.ad-banner',
    'news.com##div:has-text(Sponsored):upward(2)', 'news.com##.x:style(opacity:0 !important)', 'news.com##.y {height:0 !important}',
    'site.org##+js(aopr, adBlockDetected)', 'ex.*##.entity', '@@||example.com^$generichide'
  ].join('\n'));
  const m = mergeCosmetic([c.cosmetic]);
  assert.deepEqual(m.gen['.ad-banner'], ['.ad-banner']);
  assert.ok(m.spec['example.com'].h.includes('.promo'));
  assert.ok(m.spec['example.com'].x.includes('.ad-banner'));
  assert.ok(m.spec['shop.example.com'].x.includes('.wide'));
  assert.equal(m.spec['example.com'].f & 2, 2);
  assert.equal(m.spec['news.com'].p[0].t[0][0], 'has-text');
  assert.ok(m.spec['news.com'].s.some(s => s.startsWith('.x{')));
  assert.ok(m.spec['news.com'].s.some(s => s.startsWith('.y{')));
  assert.deepEqual(c.scriptlets['site.org'], [['abort-on-property-read', 'adBlockDetected']]);
  assert.ok(hostKeys('www.ex.co.uk').includes('ex.*'));
  assert.equal(parseProcedural('div:not(:has-text(x))'), null);
});

test('YouTube scriptlets from lists are left to the built-in engine', () => {
  const c = compileList('youtube.com##+js(json-prune, playerResponse.adPlacements)\nm.youtube.com##+js(set, x, true)');
  assert.equal(Object.keys(c.scriptlets).length, 0);
});

test('scriptlets run in a page', () => {
  const d = new JSDOM('<!doctype html><body><div class="ad" data-track="1">x</div></body>', { url: 'https://site.org/', runScripts: 'outside-only' });
  const w = d.window;
  w.Response = Response;
  w.eval(`(${bulwarkScriptlets.toString()})(${JSON.stringify([
    ['set-constant', 'config.ads.enabled', 'false'],
    ['abort-on-property-read', 'detectAdblock'],
    ['json-prune', 'ads'],
    ['no-setTimeout-if', 'adblock'],
    ['remove-attr', 'data-track']
  ])})`);
  w.eval('window.config = { ads: { enabled: true } };');
  assert.equal(w.config.ads.enabled, false);
  assert.throws(() => w.eval('detectAdblock'));
  assert.equal(w.eval('JSON.stringify(JSON.parse(\'{"ads":[1],"keep":2}\'))'), '{"keep":2}');
  let fired = false;
  w.fired = () => { fired = true; };
  w.eval('setTimeout(function adblockCheck(){ fired(); }, 0)');
  return new Promise((resolve) => setTimeout(() => {
    assert.equal(fired, false);
    assert.equal(w.document.querySelector('.ad').hasAttribute('data-track'), false);
    w.close();
    resolve();
  }, 30));
});

test('generated scriptlet files only apply to their hosts and honour exceptions', () => {
  const src = buildScriptletFile({ 'site.org': [['set-constant', 'flag', 'true']] }, { 'sub.site.org': ['*'] });
  const run = (url) => { const d = new JSDOM('', { url, runScripts: 'outside-only' }); d.window.eval(src); return d.window.flag; };
  assert.equal(run('https://www.site.org/'), true);
  assert.equal(run('https://other.org/'), undefined);
  assert.equal(run('https://sub.site.org/'), undefined);
});

test('cookie classification', () => {
  assert.equal(keepCookie({ name: '_ga', session: false }, 'necessary'), false);
  assert.equal(keepCookie({ name: '_fbp', session: true }, 'necessary'), false);
  assert.equal(keepCookie({ name: 'PHPSESSID', session: true }, 'necessary'), true);
  assert.equal(keepCookie({ name: '__Host-csrf', session: false }, 'necessary'), true);
  assert.equal(keepCookie({ name: 'SAPISID', session: false }, 'necessary'), true);
  assert.equal(keepCookie({ name: 'OptanonConsent', session: false }, 'necessary'), true);
  assert.equal(keepCookie({ name: 'random_pref', session: false }, 'necessary'), false);
  assert.equal(keepCookie({ name: 'random_pref', session: true }, 'necessary'), true);
  assert.equal(keepCookie({ name: 'random_pref', session: false }, 'necessary', n => n === 'random_pref'), true);
  assert.equal(keepCookie({ name: 'PHPSESSID', session: true }, 'block'), false);
  assert.equal(keepCookie({ name: 'theme', session: false }, 'allow'), true);
  assert.equal(keepCookie({ name: '_ga', session: false }, 'allow'), false);
});

test('cookie guard drops tracker writes in necessary mode and everything in block mode', () => {
  for (const mode of ['necessary', 'block']) {
    const src = fs.readFileSync(path.join(ROOT, `generated/cookie-${mode}.js`), 'utf8');
    const d = new JSDOM('', { url: 'https://shop.example.com/', runScripts: 'outside-only' });
    d.window.eval(src);
    d.window.eval('document.cookie = "_ga=GA1.2.3; path=/"; document.cookie = "cart=42; path=/";');
    const c = d.window.eval('document.cookie');
    if (mode === 'necessary') { assert.ok(!c.includes('_ga')); assert.ok(c.includes('cart=42')); }
    else assert.equal(c, '');
    d.window.close();
  }
});

test('cosmetic content script applies procedural filters and counts hidden elements', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'content/cosmetic.js'), 'utf8');
  const d = new JSDOM(`<!doctype html><body>
    <div class="card"><span>Sponsored</span></div><div class="card"><span>News</span></div>
    <div class="ad-banner">ad</div><div class="ok">ok</div></body>`, { url: 'https://news.com/', runScripts: 'outside-only' });
  const w = d.window;
  const messages = [];
  let listener = null;
  w.chrome = { runtime: {
    sendMessage: (m) => {
      messages.push(m);
      if (m.t === 'frame-init') return Promise.resolve({ on: true, generic: true, proc: [{ s: '.card span', t: [['has-text', 'Sponsored'], ['upward', '1']], a: 'hide' }] });
      if (m.t === 'tokens') return Promise.resolve(null);
      return Promise.resolve(null);
    },
    onMessage: { addListener: (fn) => { listener = fn; } }
  } };
  w.eval(src);
  await new Promise(r => setTimeout(r, 200));
  const cards = w.document.querySelectorAll('.card');
  assert.equal(cards[0].style.display, 'none');
  assert.equal(cards[1].style.display, '');
  const tokenMsg = messages.find(m => m.t === 'tokens');
  assert.ok(tokenMsg && tokenMsg.tokens.includes('.ad-banner') && tokenMsg.tokens.includes('.card'));
  let count = null;
  listener({ t: 'count', sels: ['.ad-banner'] }, {}, (r) => { count = r.count; });
  assert.equal(count, 2);
  w.close();
});

test('page scripts cannot see or spoof the private channels', async () => {
  const shim = fs.readFileSync(path.join(ROOT, 'generated/cookie-necessary.js'), 'utf8');
  const cosmetic = fs.readFileSync(path.join(ROOT, 'content/cosmetic.js'), 'utf8');
  for (const order of ['main-first', 'iso-first']) {
    const d = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.example.com/', runScripts: 'outside-only' });
    const w = d.window;
    const sent = [];
    w.chrome = { runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve(m.t === 'frame-init' ? { on: false } : null); }, onMessage: { addListener() {} } } };
    if (order === 'main-first') { w.eval(shim); w.eval(cosmetic); } else { w.eval(cosmetic); w.eval(shim); }
    await new Promise(r => setTimeout(r, 0));
    assert.equal(w.document.documentElement.getAttribute('data-bwc'), null, order + ': handoff attribute removed');
    assert.equal(w.document.documentElement.attributes.length, 0);
    w.eval('document.cookie = "_ga=1"');
    await new Promise(r => setTimeout(r, 2700));
    assert.ok(sent.some(m => m.t === 'ck-stats' && m.n === 1), order + ': blocked cookie counted');
    // (__bw is set by the isolated-world script; jsdom has only one world.)
    assert.equal(Object.keys(w).filter(k => /bulwark/i.test(k)).length, 0, 'no named globals');
    w.close();
  }
});

test('network guard only allows list hosts, opted-in SponsorBlock and user lists', async () => {
  globalThis.chrome = globalThis.chrome || { runtime: { getURL: (x) => x } };
  const { isAllowedUrl } = await import('../../background/net.js');
  const ok = 'https://raw.githubusercontent.com/easylist/easylist/gh-pages/easylist.txt';
  assert.equal(isAllowedUrl(ok), true);
  assert.equal(isAllowedUrl(ok.replace('https', 'http')), false);
  assert.equal(isAllowedUrl('https://raw.githubusercontent.com/evil/x.txt'), false);
  assert.equal(isAllowedUrl('https://sponsor.ajay.app/api/skipSegments/abcd'), false);
  assert.equal(isAllowedUrl('https://sponsor.ajay.app/api/skipSegments/abcd', { sponsorblock: true }), true);
  assert.equal(isAllowedUrl('https://lists.example/my.txt', { customUrls: ['https://lists.example/my.txt'] }), true);
  assert.equal(isAllowedUrl('https://tracker.example/collect'), false);
});
