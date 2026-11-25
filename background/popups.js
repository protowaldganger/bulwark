// Pop-up blocking. Chrome's request rules cannot see that a request opens a
// new tab, so $popup filters are kept here instead: when a page opens a
// tab or window whose address matches one, the new tab is closed. The
// filters arrive packed inside each list's cosmetic data (`pu`, see
// packPopup in engine/compiler.js) and are merged by cosmetic.js.
//
// Matching is cheap: popups are rare, plain `||host^` filters are looked
// up by host, and only the few hundred pattern filters are tested in turn.

import { hostKeys } from '../engine/compiler.js';
import * as idb from './idb.js';

let index = null; // { byHost: Map<host, entry[]>, rest: entry[] }

function urlFilterToRegex(f, caseSensitive) {
  let src = '';
  let i = 0;
  if (f.startsWith('||')) { src += '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^\\/?#@]*\\.)?'; i = 2; }
  else if (f.startsWith('|')) { src += '^'; i = 1; }
  let end = f.length, anchorEnd = false;
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

function compile([u, f, inc, exc, req]) {
  let re = null;
  if (u && u.length > 2 && u.startsWith('/') && u.endsWith('/')) { try { re = new RegExp(u.slice(1, -1), f & 4 ? '' : 'i'); } catch { return null; } }
  else if (u) { try { re = urlFilterToRegex(u, !!(f & 4)); } catch { return null; } }
  return { re, f, inc: inc || null, exc: exc || null, req: req || null };
}

export function setPopupFilters(packed) {
  const byHost = new Map(), rest = [];
  for (const p of packed || []) {
    const e = compile(p);
    if (!e) continue;
    const m = typeof p[0] === 'string' && /^\|\|([a-z0-9.-]+)\^?$/.exec(p[0]);
    if (m) (byHost.get(m[1]) || byHost.set(m[1], []).get(m[1])).push(e);
    else rest.push(e);
  }
  index = { byHost, rest, size: (packed || []).length };
}

async function ensureIndex() {
  if (!index) setPopupFilters(await idb.kv.get('popups') || []);
  return index;
}

const inList = (host, list) => list.some(d => host === d || host.endsWith('.' + d));
const site = (h) => { const p = h.split('.'); return p.slice(p.length > 2 && p[p.length - 1].length === 2 && /^(co|com|net|org|gov|ac|edu)$/.test(p[p.length - 2]) ? -3 : -2).join('.'); };

// 'block', 'allow' or null for a popup to `url` opened by a page on `opener`.
export async function popupVerdict(url, opener) {
  const idx = await ensureIndex();
  if (!idx.size || !/^https?:/i.test(url)) return null;
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  const candidates = [...idx.rest];
  for (const k of hostKeys(host)) { const l = idx.byHost.get(k); if (l) candidates.push(...l); }
  let block = false, allow = false, important = false;
  for (const e of candidates) {
    if (e.re && !e.re.test(url)) continue;
    if (e.inc && !(opener && inList(opener, e.inc))) continue;
    if (e.exc && opener && inList(opener, e.exc)) continue;
    if (e.req && !inList(host, e.req)) continue;
    if (e.f & (8 | 16)) {
      const third = !opener || site(opener) !== site(host);
      if ((e.f & 8) && third) continue;
      if ((e.f & 16) && !third) continue;
    }
    if (e.f & 1) allow = true;
    else { block = true; if (e.f & 2) important = true; }
  }
  if (block && (important || !allow)) return 'block';
  return allow ? 'allow' : null;
}

export function popupCount() { return index ? index.size : 0; }
