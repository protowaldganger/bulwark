#!/usr/bin/env node
// Bulwark build.
//
// 1. Downloads the bundled filter lists (raw.githubusercontent.com only)
//    and compiles them into declarativeNetRequest static rulesets plus
//    cosmetic and scriptlet data, next to the sources (rulesets/, generated/),
//    so the source tree itself loads unpacked for development.
// 2. Produces dist/: the smallest loadable extension. JavaScript is bundled
//    and minified with esbuild (the service worker becomes one file), CSS
//    and HTML are minified, and only files the extension uses are copied.
//
//   node tools/build.mjs            download fresh lists, then build
//   node tools/build.mjs --offline  build from tools/.cache only

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { LISTS, YT_RULESET } from '../engine/lists.js';
import { compileList, validateRule, fnv1a, badfilterKey, preprocess, packCosmetic, finalizeRules } from '../engine/compiler.js';
import { buildScriptletFile, bulwarkScriptlets } from '../engine/scriptlets.js';
import { TRACKER_COOKIE_SOURCE, ENTITY_GROUPS } from '../engine/cookies.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'tools', '.cache');
const DIST = path.join(ROOT, 'dist');
const OFFLINE = process.argv.includes('--offline');
const REGEX_LIMIT = 1000;

const p = (...x) => path.join(ROOT, ...x);
const d = (...x) => path.join(DIST, ...x);
const log = (...a) => console.log(...a);

async function fetchList(def) {
  const cacheFile = path.join(CACHE, def.id + '.txt');
  if (!OFFLINE) {
    for (const url of def.urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        if (text.length < 50) throw new Error('empty');
        await fs.writeFile(cacheFile, text);
        return { text, source: url };
      } catch (e) {
        log(`  ${def.id}: ${url} failed (${e.message})`);
      }
    }
  }
  try {
    return { text: await fs.readFile(cacheFile, 'utf8'), source: 'cache' };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- compile

async function compileAll() {
  await fs.mkdir(CACHE, { recursive: true });
  await fs.rm(p('generated'), { recursive: true, force: true });
  for (const dir of ['rulesets', 'generated/cosmetic', 'generated/scriptlets']) await fs.mkdir(p(dir), { recursive: true });

  const bundled = LISTS.filter(l => l.bundled);
  const texts = {};
  log('Fetching lists' + (OFFLINE ? ' (offline)' : ''));
  for (const l of bundled) {
    const r = await fetchList(l);
    if (!r) throw new Error(`No source for ${l.id}; run once online`);
    texts[l.id] = r.text;
    log(`  ${l.id.padEnd(16)} ${String(r.text.length).padStart(9)} bytes  ${r.source}`);
  }

  // Badfilters apply across lists (uBO quick fixes disable EasyList rules).
  const globalBad = new Set();
  for (const t of Object.values(texts)) {
    for (const line of preprocess(t)) if (/\$(.*,)?badfilter(,|$)/.test(line) && !/#@?#/.test(line)) globalBad.add(badfilterKey(line));
  }

  const meta = { builtAt: Date.now(), lists: {} };
  const compiled = {};
  for (const l of bundled) {
    const t0 = performance.now();
    const c = compileList(texts[l.id], { badfilters: globalBad });
    // Chrome allows 1000 regex rules per static ruleset.
    let regex = 0;
    const kept = c.rules.filter(r => !r.condition.regexFilter || regex++ < REGEX_LIMIT);
    const rules = kept.length === c.rules.length ? c.rules : finalizeRules(kept);
    for (const r of rules) {
      const err = validateRule(r);
      if (err) throw new Error(`${l.id} rule ${r.id} invalid: ${err}`);
    }
    compiled[l.id] = { ...c, rules, quiet: rules.quiet, ms: Math.round(performance.now() - t0), regex: Math.min(regex, REGEX_LIMIT) };
  }

  // Scriptlet exceptions are global (#@#+js in one list cancels another).
  const scriptletEx = {};
  for (const c of Object.values(compiled)) {
    for (const [h, e] of Object.entries(c.cosmetic.spec)) if (e.j) (scriptletEx[h] || (scriptletEx[h] = [])).push(...e.j);
  }

  const scriptletTables = {};
  for (const l of bundled) {
    const c = compiled[l.id];
    await fs.writeFile(p('rulesets', l.id + '.json'), JSON.stringify(c.rules));
    await fs.writeFile(p('generated/cosmetic', l.id + '.json'), JSON.stringify(packCosmetic(c.cosmetic)));

    // Drop scriptlets cancelled by exceptions from any list.
    const table = {};
    for (const [host, entries] of Object.entries(c.scriptlets)) {
      const ex = new Set();
      const labels = host.split('.');
      for (let i = 0; i < labels.length; i++) for (const x of scriptletEx[labels.slice(i).join('.')] || []) ex.add(x);
      if (ex.has('*')) continue;
      const keep = entries.filter(e => !ex.has(e[0] + '|' + e.slice(1).join('|')));
      if (keep.length) table[host] = keep;
    }
    // Entity keys (example.*) cannot be match patterns; they stay in the
    // table for the service worker, which injects them on navigation.
    const hosts = Object.keys(table).filter(h => !h.endsWith('.*'));
    const relevantEx = {};
    for (const [h, x] of Object.entries(scriptletEx)) if (hosts.some(t => t === h || t.endsWith('.' + h) || h.endsWith('.' + t))) relevantEx[h] = [...new Set(x)];
    if (Object.keys(table).length) {
      scriptletTables[l.id] = { table, relevantEx };
      await fs.writeFile(p('generated/scriptlets', l.id + '.js'), buildScriptletFile(table, relevantEx));
    }

    meta.lists[l.id] = {
      rules: c.rules.length, quiet: c.quiet, regex: c.regex, hash: fnv1a(texts[l.id]),
      filters: c.stats.network + c.stats.cosmetic,
      cosmeticHosts: Object.keys(c.cosmetic.spec).length, genericTokens: Object.keys(c.cosmetic.gen).length, highlyGeneric: c.cosmetic.hg.length,
      scriptletHosts: Object.keys(table).length, badfilters: c.badfilters
    };
    log(`  ${l.id.padEnd(16)} filters ${String(c.stats.network).padStart(6)} -> rules ${String(c.rules.length).padStart(5)}  regex ${String(c.regex).padStart(3)}  cosmetic hosts ${String(meta.lists[l.id].cosmeticHosts).padStart(5)}  generic ${String(meta.lists[l.id].genericTokens).padStart(5)}+${meta.lists[l.id].highlyGeneric}  scriptlet hosts ${String(Object.keys(table).length).padStart(5)}  ${c.ms} ms`);
  }

  const yt = JSON.parse(await fs.readFile(p('rulesets', YT_RULESET + '.json'), 'utf8'));
  for (const r of yt) { const err = validateRule(r); if (err) throw new Error(`youtube rule ${r.id}: ${err}`); }
  meta.lists[YT_RULESET] = { rules: yt.length, quiet: 0 };
  await fs.writeFile(p('generated/meta.json'), JSON.stringify(meta));

  const template = await fs.readFile(p('content/cookie-shim.template.js'), 'utf8');
  const shims = {};
  for (const mode of ['necessary', 'block']) {
    shims[mode] = template.replace('__MODE__', () => mode).replace('__TRACKER__', () => TRACKER_COOKIE_SOURCE.replace(/`/g, '\\`')).replace('__ENTITIES__', () => JSON.stringify(ENTITY_GROUPS));
    await fs.writeFile(p('generated', `cookie-${mode}.js`), '/* Generated by tools/build.mjs from content/cookie-shim.template.js. */\n' + shims[mode]);
  }

  const manifest = JSON.parse(await fs.readFile(p('manifest.json'), 'utf8'));
  manifest.declarative_net_request.rule_resources = [
    { id: YT_RULESET, enabled: true, path: `rulesets/${YT_RULESET}.json` },
    ...bundled.map(l => ({ id: l.id, enabled: !!l.enabledByDefault, path: `rulesets/${l.id}.json` }))
  ];
  await fs.writeFile(p('manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const total = Object.values(meta.lists).reduce((a, m) => a + m.rules, 0);
  log(`Static rules total: ${total}`);
  return { scriptletTables, shims };
}

// ---------------------------------------------------------------- dist

const MIN = { minify: true, legalComments: 'none', target: 'chrome121', charset: 'utf8' };

async function minifyJs(code, format = 'iife') {
  return (await esbuild.transform(code, { ...MIN, loader: 'js', format })).code;
}

function minifyHtml(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ').trim();
}

async function copy(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

async function buildDist({ scriptletTables, shims }) {
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });

  // Service worker: one bundled, minified file (one fetch and parse at
  // worker start instead of a module graph).
  await esbuild.build({ ...MIN, entryPoints: [p('background/sw.js')], bundle: true, format: 'iife', outfile: d('background.js') });

  // Pages: bundle JS, merge theme + page CSS, minify HTML.
  for (const page of ['popup', 'options']) {
    await esbuild.build({ ...MIN, entryPoints: [p(page, page + '.js')], bundle: true, format: 'iife', outfile: d(page, page + '.js') });
    const css = (await fs.readFile(p('ui/theme.css'), 'utf8')) + '\n' + (await fs.readFile(p(page, page + '.css'), 'utf8'));
    await fs.writeFile(d(page, page + '.css'), (await esbuild.transform(css, { ...MIN, loader: 'css' })).code);
    let html = await fs.readFile(p(page, page + '.html'), 'utf8');
    html = html.replace(/<link rel="stylesheet" href="\.\.\/ui\/theme\.css">\s*/, '').replace(' type="module"', '');
    await fs.writeFile(d(page, page + '.html'), minifyHtml(html));
  }

  // Content scripts and styles.
  for (const f of ['cosmetic.js', 'picker.js', 'youtube-iso.js', 'youtube-main.js']) {
    await fs.mkdir(d('content'), { recursive: true });
    await fs.writeFile(d('content', f), await minifyJs(await fs.readFile(p('content', f), 'utf8')));
  }
  await fs.writeFile(d('content/youtube.css'), (await esbuild.transform(await fs.readFile(p('content/youtube.css'), 'utf8'), { ...MIN, loader: 'css' })).code);

  // Generated data. Scriptlet files keep their first-line data table and
  // embed a minified runtime.
  const runtime = (await minifyJs('(' + bulwarkScriptlets.toString() + ')', 'esm')).trim().replace(/;$/, '');
  await fs.mkdir(d('generated/scriptlets'), { recursive: true });
  for (const [id, { table, relevantEx }] of Object.entries(scriptletTables)) {
    await fs.writeFile(d('generated/scriptlets', id + '.js'), buildScriptletFile(table, relevantEx, runtime));
  }
  for (const [mode, src] of Object.entries(shims)) await fs.writeFile(d('generated', `cookie-${mode}.js`), await minifyJs(src));
  await copy(p('generated/meta.json'), d('generated/meta.json'));
  for (const f of await fs.readdir(p('generated/cosmetic'))) await copy(p('generated/cosmetic', f), d('generated/cosmetic', f));
  for (const f of await fs.readdir(p('rulesets'))) await copy(p('rulesets', f), d('rulesets', f));

  // Redirect surrogates.
  await fs.mkdir(d('resources'), { recursive: true });
  for (const f of await fs.readdir(p('resources'))) {
    if (f.endsWith('.js')) await fs.writeFile(d('resources', f), await minifyJs(await fs.readFile(p('resources', f), 'utf8')));
    else await copy(p('resources', f), d('resources', f));
  }

  // Icons and manifest.
  const manifest = JSON.parse(await fs.readFile(p('manifest.json'), 'utf8'));
  for (const f of new Set([...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)])) await copy(p(f), d(f));
  manifest.background = { service_worker: 'background.js' };
  await fs.writeFile(d('manifest.json'), JSON.stringify(manifest));
  await copy(p('LICENSE'), d('LICENSE'));
  await copy(p('LICENSE-NOTICES.txt'), d('LICENSE-NOTICES.txt'));

  const files = await walk(DIST);
  let bytes = 0;
  for (const f of files) bytes += (await fs.stat(f)).size;
  log(`dist: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
}

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(f)); else out.push(f);
  }
  return out;
}

compileAll().then(buildDist).catch(e => { console.error(e); process.exit(1); });
