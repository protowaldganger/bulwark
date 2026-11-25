// Pop-up blocking, tracking-link skipping, header filters, procedural
// filters, trusted scriptlets and the scriptlets used by the cookie-notice
// and annoyance lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';
import { compileList, unpackCosmetic, mergeCosmetic, adaptRuleForSafari, BLOCKED_PAGE } from '../../engine/compiler.js';
import fsSync from 'node:fs';
import { bulwarkScriptlets } from '../../engine/scriptlets.js';
import { setPopupFilters, popupVerdict } from '../../background/popups.js';
import { urlSkip, noteNavigation, skipTarget } from '../../background/skip.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function page(html, url = 'https://site.org/') {
  const d = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  d.window.Response = Response;
  return d;
}
const run = (d, entries) => d.window.eval(`(${bulwarkScriptlets.toString()})(${JSON.stringify(entries)})`);

test('pop-up filters are packed with the cosmetic data and matched by opener', async () => {
  const c = compileList([
    '||popads.example^$popup',
    '||pop.example^$popup,domain=video.test',
    '/promo-redirect/*$popup,third-party',
    '@@||popads.example/allowed^$popup',
    '||always.example^$popup,important',
    '@@||always.example^$popup'
  ].join('\n'));
  const pu = unpackCosmetic(c.cosmetic).pu;
  assert.equal(pu.length, 6);
  assert.equal(mergeCosmetic([c.cosmetic]).pu.length, 6);
  setPopupFilters(pu);
  assert.equal(await popupVerdict('https://popads.example/go?x=1', 'news.test'), 'block');
  assert.equal(await popupVerdict('https://sub.popads.example/', 'news.test'), 'block');
  assert.equal(await popupVerdict('https://popads.example/allowed', 'news.test'), 'allow');
  assert.equal(await popupVerdict('https://pop.example/', 'video.test'), 'block');
  assert.equal(await popupVerdict('https://pop.example/', 'other.test'), null);
  assert.equal(await popupVerdict('https://ads.example/promo-redirect/1', 'news.test'), 'block');
  assert.equal(await popupVerdict('https://news.test/promo-redirect/1', 'news.test'), null, 'first-party is not matched');
  assert.equal(await popupVerdict('https://always.example/', 'news.test'), 'block', '$important wins over the exception');
  assert.equal(await popupVerdict('https://fine.example/', 'news.test'), null);
});

test('urlskip steps match uBlock Origin', () => {
  assert.equal(urlSkip('https://t.example/r?url=https%3A%2F%2Fdest.example%2Fa%3Fb%3D1', ['?url']), 'https://dest.example/a?b=1');
  assert.equal(urlSkip('https://t.example/r?u=aHR0cHM6Ly9kZXN0LmV4YW1wbGUv', ['?u', '-base64']), 'https://dest.example/');
  assert.equal(urlSkip('https://t.example/r#https://dest.example/x', ['#']), 'https://dest.example/x');
  assert.equal(urlSkip('https://t.example/r?to=dest.example/x', ['?to', '+https']), 'https://dest.example/x');
  assert.equal(urlSkip('https://t.example/CL0/https:%2F%2Fdest.example%2F/1/abc/', ['/\\/CL0\\/(http.*?)\\/\\d\\/[a-f0-9-]+\\//', '-uricomponent']), 'https://dest.example/');
  assert.equal(urlSkip('https://t.example/r?url=javascript:alert(1)', ['?url']), null);
  assert.equal(urlSkip('https://t.example/r', ['?url']), null);
});

test('urlskip compiles to a redirect to the skip page and resolves the target', async () => {
  const c = compileList('||trk.example/out?$urlskip=?target -uricomponent');
  const r = c.rules[0];
  assert.equal(r.action.type, 'redirect');
  assert.equal(r.action.redirect.extensionPath, '/skip/skip.html?s=' + encodeURIComponent('?target -uricomponent'));
  assert.ok(compileList('||trk.example^$urlskip=foo').stats.skipped >= 1, 'bad steps are refused');

  const session = [];
  globalThis.chrome = { declarativeNetRequest: { updateSessionRules: async (u) => { session.push(u); } } };
  noteNavigation({ tabId: 7, frameId: 0, url: 'https://trk.example/out?target=https%3A%2F%2Fshop.example%2Fitem' });
  assert.deepEqual(await skipTarget(7, '?target -uricomponent'), { url: 'https://shop.example/item' });
  assert.equal(session.length, 0);
  // Unknown target: the original address is allowed once in that tab.
  noteNavigation({ tabId: 8, frameId: 0, url: 'https://trk.example/out?nothing=1' });
  const res = await skipTarget(8, '?target');
  assert.equal(res.url, 'https://trk.example/out?nothing=1');
  assert.deepEqual(session[0].addRules[0].condition, { tabIds: [8], resourceTypes: ['main_frame'] });
  assert.deepEqual(await skipTarget(9, '?target'), { url: null });
});

test('$csp and $permissions become response header rules', () => {
  const c = compileList(['||site.test^$csp=worker-src \'none\'', '||site.test^$permissions=browsing-topics=()', '@@||site.test^$csp'].join('\n'));
  const heads = c.rules.map(r => r.action.responseHeaders && r.action.responseHeaders[0].header).filter(Boolean).sort();
  assert.deepEqual(heads, ['content-security-policy', 'permissions-policy']);
  assert.equal(c.quiet, 2, 'header rules are not counted as blocks');
});

test('procedural filters: nested :has, :remove-attr, :remove-class, ::before', () => {
  const c = compileList([
    'site.test##div.card:has(span:has-text(Sponsored))',
    'site.test##a.link:remove-attr(onclick)',
    'site.test##body:remove-class(no-scroll)',
    'site.test##.box:matches-css-before(content: /Ad/)'
  ].join('\n'));
  assert.equal(c.stats.skipReasons['procedural-unsupported'] || 0, 0);
  const spec = unpackCosmetic(c.cosmetic).spec['site.test'];
  assert.equal(spec.p.length, 4);
  const has = spec.p.find(p => JSON.stringify(p).includes('has-text'));
  assert.ok(JSON.stringify(has).includes('"has"'));
  assert.ok(spec.p.some(p => p.a && p.a[0] === 'remove-attr' && p.a[1] === 'onclick'));
  assert.ok(spec.p.some(p => p.a && p.a[0] === 'remove-class'));
});

test('trusted scriptlets only from trusted lists', () => {
  const text = 'site.test##+js(trusted-set-cookie, consent, {"a":1})\nsite.test##+js(set-cookie, consent, reject)';
  const untrusted = compileList(text, { trusted: false });
  assert.equal(untrusted.stats.skipReasons['scriptlet-untrusted'], 1);
  assert.equal(untrusted.stats.scriptlets, 1);
  assert.equal(compileList(text, { trusted: true }).stats.scriptlets, 2);
});

test('cookie-notice scriptlets: set-cookie, click-element, localStorage', async () => {
  const d = page('<!doctype html><body><div id="banner"><button class="reject">Reject</button></div></body>');
  let clicked = 0;
  d.window.document.querySelector('.reject').addEventListener('click', () => { clicked++; });
  run(d, [
    ['set-cookie', 'cookie_consent', 'rejected'],
    ['set-cookie', 'bad', 'arbitrary-value'],
    ['trusted-set-cookie', 'prefs', '{"ads":false}', '1year'],
    ['trusted-click-element', '#banner .reject'],
    ['set-local-storage-item', 'gdpr', 'true']
  ]);
  const ck = d.window.document.cookie;
  assert.match(ck, /cookie_consent=rejected/);
  assert.doesNotMatch(ck, /bad=/, 'set-cookie only accepts known values');
  assert.match(ck, /prefs=/);
  assert.equal(d.window.localStorage.getItem('gdpr'), 'true');
  await sleep(50);
  assert.equal(clicked, 1);
  d.window.close();
});

test('annoyance and anti-adblock scriptlets', async () => {
  const d = page('<!doctype html><body><a id="l" href="https://t.example/r?url=https%3A%2F%2Fdest.example%2F">x</a><p id="t">keep</p><div class="x"></div></body>');
  const w = d.window;
  run(d, [
    ['href-sanitizer', 'a#l', '?url'],
    ['set-attr', 'div.x', 'data-ok', 'true'],
    ['nofab'],
    ['remove-node-text', '#text', 'Please disable your ad blocker']
  ]);
  await sleep(150);
  assert.equal(w.document.getElementById('l').getAttribute('href'), 'https://dest.example/');
  assert.equal(w.document.querySelector('div.x').getAttribute('data-ok'), 'true');
  assert.equal(typeof w.FuckAdBlock, 'function');
  let detected = false;
  w.fuckAdBlock.onDetected(() => { detected = true; });
  w.fuckAdBlock.check();
  const p = w.document.createElement('p');
  p.textContent = 'Please disable your ad blocker';
  w.document.body.appendChild(p);
  await sleep(50);
  assert.equal(p.textContent, '');
  assert.equal(w.document.getElementById('t').textContent, 'keep');
  assert.equal(detected, false);
  w.close();
});

test('json-prune-fetch-response removes ad payloads from responses', async () => {
  const d = page('<!doctype html><body></body>');
  const w = d.window;
  w.fetch = async () => new Response(JSON.stringify({ ads: [1, 2], content: 'ok' }), { headers: { 'content-type': 'application/json' } });
  run(d, [['json-prune-fetch-response', 'ads', '', 'propsToMatch', '/api/']]);
  const body = await (await w.fetch('https://site.org/api/feed')).json();
  assert.deepEqual(body, { content: 'ok' });
  w.close();
});

test('blocked pages go to the warning page; security lists cover whole hosts', () => {
  const doc = compileList('||scam.example^$document\n||mixed.example^$doc,script').rules;
  const page = doc.filter(r => r.action.type === 'redirect');
  assert.equal(page.length, 2);
  assert.ok(page.every(r => r.action.redirect.extensionPath === BLOCKED_PAGE && r.condition.resourceTypes.join() === 'main_frame' && r.priority === 2));
  assert.deepEqual(doc.find(r => r.action.type === 'block').condition.resourceTypes, ['script'], 'the rest stays a plain block');
  // Ordinary lists: a plain host blocks what pages load, not visits.
  const plain = compileList('||tracker.example^').rules;
  assert.equal(plain.length, 1);
  assert.equal(plain[0].action.type, 'block');
  assert.equal(plain[0].condition.resourceTypes, undefined);
  // Security lists: visiting the host is stopped too.
  const strict = compileList('||malware.example^\nmalware2.example\n0.0.0.0 malware3.example', { strict: true }).rules;
  assert.equal(strict.filter(r => r.action.type === 'redirect').length >= 1, true);
  assert.ok(strict.some(r => r.action.type === 'block' && !r.condition.resourceTypes.includes('main_frame')));
  // URLhaus: whole hosts only, never single addresses.
  const uh = compileList('1.2.3.4\n||bad.example^\n||good.example/files/evil.exe^$all\n5.6.7.8/bins/x', { strict: true, hostsOnly: true });
  assert.equal(uh.stats.skipReasons['hosts-only'], 2);
  // Safari has no extension-page redirects here: a plain block.
  assert.deepEqual(adaptRuleForSafari(page[0]).action, { type: 'block' });
});

test('zapper removes clicked elements, gives scrolling back and can undo', async () => {
  const d = page('<!doctype html><html><body style="overflow-y:hidden"><div id="overlay">Subscribe!</div><p id="keep">text</p></body></html>');
  const w = d.window;
  w.__bw = { pick: 'zap' };
  w.chrome = { runtime: { sendMessage: async () => null } };
  w.eval(fsSync.readFileSync(new URL('../../content/picker.js', import.meta.url), 'utf8'));
  const overlay = w.document.getElementById('overlay');
  w.document.elementFromPoint = () => overlay;
  w.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  assert.equal(w.document.getElementById('overlay'), null, 'removed');
  assert.equal(w.getComputedStyle(w.document.body).overflowY, 'auto', 'scrolling given back');
  assert.ok(w.document.getElementById('keep'));
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(w.__bw.pickerOpen, false, 'closed with Esc');
  w.close();
});
