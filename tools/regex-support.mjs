// Chrome compiles every regexFilter with RE2 and skips rules whose program
// needs more than 2 KB (for example \w{30,}), with a warning on the
// extension's page. There is no RE2 here, so the build asks Chromium itself
// (declarativeNetRequest.isRegexSupported, through Playwright) and keeps the
// answers in tools/regex-support.json, which is committed: builds without
// Playwright reuse them, and only new expressions need a browser.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const FILE = path.join(path.dirname(new URL(import.meta.url).pathname), 'regex-support.json');
const key = (regex, cs) => (cs ? '1' : '0') + regex;

async function askChromium(items) {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch {
    // Also a global install (npm install -g playwright).
    try {
      const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
      ({ chromium } = createRequire(path.join(root, 'noop.js'))('playwright'));
    } catch { return null; }
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bw-rx-'));
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'rx', version: '1', permissions: ['declarativeNetRequest'], background: { service_worker: 'sw.js' } }));
  await fs.writeFile(path.join(dir, 'sw.js'), '');
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`] });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    return await sw.evaluate(async (list) => {
      const out = [];
      for (const [regex, cs] of list) {
        const r = await chrome.declarativeNetRequest.isRegexSupported({ regex, isCaseSensitive: cs });
        out.push(r.isSupported ? true : r.reason || false);
      }
      return out;
    }, items);
  } catch { return null; } finally {
    if (ctx) await ctx.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// rules: DNR rules. Returns a predicate that is false for rules Chrome would
// skip. Unknown expressions are kept when no browser is available.
export async function regexSupport(rules, log = () => {}) {
  let known = {};
  try { known = JSON.parse(await fs.readFile(FILE, 'utf8')); } catch { /* first run */ }
  const want = new Map();
  for (const r of rules) {
    const c = r.condition;
    if (c.regexFilter) want.set(key(c.regexFilter, !!c.isUrlFilterCaseSensitive), [c.regexFilter, !!c.isUrlFilterCaseSensitive]);
  }
  const unknown = [...want.entries()].filter(([k]) => !(k in known));
  if (unknown.length) {
    const answers = await askChromium(unknown.map(([, v]) => v));
    if (answers) {
      unknown.forEach(([k], i) => { known[k] = answers[i]; });
      log(`  checked ${unknown.length} new regular expressions in Chromium`);
    } else log(`  WARNING: ${unknown.length} regular expressions not checked (no Playwright Chromium); kept`);
  }
  // Keep the file to what the lists use now, sorted for stable diffs.
  const out = {};
  for (const k of [...want.keys()].sort()) if (k in known) out[k] = known[k];
  await fs.writeFile(FILE, JSON.stringify(out, null, 1) + '\n');
  return (r) => {
    const c = r.condition;
    if (!c.regexFilter) return true;
    return known[key(c.regexFilter, !!c.isUrlFilterCaseSensitive)] !== 'memoryLimitExceeded' && known[key(c.regexFilter, !!c.isUrlFilterCaseSensitive)] !== 'syntaxError' && known[key(c.regexFilter, !!c.isUrlFilterCaseSensitive)] !== false;
  };
}
