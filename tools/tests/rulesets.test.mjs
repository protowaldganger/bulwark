// Validates the generated rulesets and checks real-world outcomes:
// ads and trackers blocked, YouTube playback and sign-in untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRule } from '../../engine/compiler.js';
import { evaluate } from './dnr-matcher.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const resources = manifest.declarative_net_request.rule_resources;
const rulesets = resources.filter(r => r.enabled).map(r => ({ id: r.id, rules: JSON.parse(fs.readFileSync(path.join(ROOT, r.path), 'utf8')) }));

test('every static rule is valid, ids are unique, regex rules within limit', () => {
  let total = 0;
  for (const rs of rulesets) {
    const ids = new Set();
    let regex = 0;
    for (const r of rs.rules) {
      assert.equal(validateRule(r), null, `${rs.id}#${r.id}`);
      assert.ok(!ids.has(r.id), `duplicate id ${rs.id}#${r.id}`);
      ids.add(r.id);
      if (r.condition.regexFilter) regex++;
    }
    assert.ok(regex <= 1000, `${rs.id} has ${regex} regex rules`);
    total += rs.rules.length;
  }
  assert.ok(total < 300000, `total static rules ${total} exceeds the shared pool`);
});

test('manifest references existing files only', () => {
  const files = [
    manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page,
    ...Object.values(manifest.icons), ...resources.map(r => r.path),
    ...manifest.content_scripts.flatMap(c => [...(c.js || []), ...(c.css || [])])
  ];
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  // redirect targets exist
  for (const rs of rulesets) for (const r of rs.rules) {
    const p = r.action.redirect && r.action.redirect.extensionPath;
    if (p) assert.ok(fs.existsSync(path.join(ROOT, p)), `${rs.id}#${r.id} -> ${p}`);
  }
});

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const req = (url, type, documentUrl) => ({ url, type, initiator: documentUrl ? new URL(documentUrl).origin : undefined, documentUrl });

const MUST_BLOCK = [
  req('https://www.youtube.com/api/stats/ads?ver=2&ns=1&event=2', 'xmlhttprequest', YT),
  req('https://www.youtube.com/pagead/adview?ai=abc&sigh=1', 'image', YT),
  req('https://www.youtube.com/youtubei/v1/player/ad_break?prettyPrint=false', 'xmlhttprequest', YT),
  req('https://googleads.g.doubleclick.net/pagead/id', 'xmlhttprequest', YT),
  req('https://www.youtube.com/pagead/paralleladview?ai=x', 'xmlhttprequest', YT),
  req('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'script', 'https://news.example.com/article'),
  req('https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'script', 'https://news.example.com/article'),
  req('https://www.googletagservices.com/tag/js/gpt.js', 'script', 'https://news.example.com/article'),
  req('https://c.amazon-adsystem.com/aax2/apstag.js', 'script', 'https://news.example.com/article'),
  req('https://connect.facebook.net/en_US/fbevents.js', 'script', 'https://shop.example.com/'),
  req('https://static.hotjar.com/c/hotjar-123.js', 'script', 'https://shop.example.com/'),
  req('https://ib.adnxs.com/ut/v3/prebid', 'xmlhttprequest', 'https://news.example.com/'),
  req('https://cdn.taboola.com/libtrc/site/loader.js', 'script', 'https://news.example.com/')
];

const MUST_NOT_BLOCK = [
  req(YT, 'main_frame'),
  req('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', 'xmlhttprequest', YT),
  req('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', 'xmlhttprequest', YT),
  req('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', 'xmlhttprequest', YT),
  req('https://rr3---sn-5hne6nzk.googlevideo.com/videoplayback?expire=1&ei=x&ip=1&id=o-abc&itag=248&source=youtube&mime=video%2Fwebm', 'xmlhttprequest', YT),
  req('https://rr3---sn-5hne6nzk.googlevideo.com/videoplayback?expire=1&itag=251&mime=audio%2Fwebm', 'media', YT),
  req('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', 'image', YT),
  req('https://yt3.ggpht.com/ytc/abc=s88-c-k-c0x00ffffff-no-rj', 'image', YT),
  req('https://www.youtube.com/s/player/a1b2c3d4/player_ias.vflset/en_US/base.js', 'script', YT),
  req('https://www.youtube.com/s/desktop/abc/jsbin/desktop_polymer.vflset/desktop_polymer.js', 'script', YT),
  req('https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en', 'xmlhttprequest', YT),
  req('https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT', 'xmlhttprequest', YT),
  req('https://www.youtube.com/embed/dQw4w9WgXcQ', 'sub_frame', 'https://blog.example.com/post'),
  req('https://accounts.google.com/ServiceLogin?service=youtube', 'main_frame'),
  req('https://www.gstatic.com/youtube/img/branding/youtubelogo/svg/youtubelogo.svg', 'image', YT),
  req('https://www.wikipedia.org/', 'main_frame'),
  req('https://www.wikipedia.org/portal/wikipedia.org/assets/js/index.js', 'script', 'https://www.wikipedia.org/'),
  req('https://github.com/login', 'main_frame')
];

test('ads and trackers are blocked', () => {
  for (const r of MUST_BLOCK) {
    const out = evaluate(rulesets, r);
    assert.ok(out.action === 'block' || out.action === 'redirect', `${r.url} -> ${out.action}`);
  }
});

test('YouTube playback, sign-in and ordinary sites are never blocked', () => {
  for (const r of MUST_NOT_BLOCK) {
    const out = evaluate(rulesets, r);
    // removeparam rules are redirects that only change URLs carrying the param
    const harmless = out.action === 'redirect' && out.rule.action.redirect.transform &&
      !(out.rule.action.redirect.transform.queryTransform?.removeParams || []).some(p => new URL(r.url).searchParams.has(p));
    assert.ok(out.action === 'none' || out.action === 'allow' || harmless, `${r.url} -> ${out.action} via ${out.ruleset}#${out.rule && out.rule.id} ${JSON.stringify(out.rule && out.rule.condition)}`);
  }
});

test('ad_status.js bait is answered with the surrogate, not blocked', () => {
  const out = evaluate(rulesets, req('https://static.doubleclick.net/instream/ad_status.js', 'script', YT));
  assert.equal(out.action, 'redirect');
  assert.equal(out.rule.action.redirect.extensionPath, '/resources/ad_status.js');
});

test('rule matching stays fast enough for a sanity check', () => {
  // Not a benchmark of Chrome (which uses an indexed matcher); guards
  // against pathological rules such as catastrophic regexes.
  const t0 = performance.now();
  for (const r of MUST_NOT_BLOCK.slice(0, 5)) evaluate(rulesets, r);
  assert.ok(performance.now() - t0 < 20000);
});

test('merged host rules still block every host they were built from', async () => {
  const { preprocess } = await import('../../engine/compiler.js');
  const lines = preprocess(fs.readFileSync(path.join(ROOT, 'tools/.cache/easyprivacy.txt'), 'utf8'))
    .filter(l => /^\|\|[a-z0-9.-]+\^$/.test(l));
  const sample = lines.filter((_, i) => i % Math.ceil(lines.length / 400) === 0);
  const ep = rulesets.filter(r => r.id === 'easyprivacy' || r.id === 'ubo-unbreak' || r.id === 'brave-unbreak' || r.id === 'ubo-privacy');
  let blocked = 0, allowed = 0;
  for (const l of sample) {
    const host = l.slice(2, -1);
    const out = evaluate(ep, { url: `https://${host}/t.js`, type: 'script', initiator: 'https://news.example.org', documentUrl: 'https://news.example.org/' });
    if (out.action === 'block') blocked++; else allowed++;
  }
  // A handful may be unblocked on purpose by the unbreak lists.
  assert.ok(blocked / sample.length > 0.97, `${blocked} blocked, ${allowed} allowed`);
  // Subdomains match like ||host^ does, unrelated look-alikes do not.
  const host = sample[0].slice(2, -1);
  assert.equal(evaluate(ep, { url: `https://cdn.${host}/x`, type: 'image', initiator: 'https://a.org' }).action, 'block');
  assert.equal(evaluate(ep, { url: `https://${host}.example.net/x`, type: 'image', initiator: 'https://a.org' }).action, 'none');
});
