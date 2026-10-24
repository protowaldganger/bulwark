// The only way Bulwark talks to the network.
//
// Every outgoing request goes through netFetch, which enforces:
//   - an allowlist: the filter list host, SponsorBlock (only when the user
//     turned it on) and list URLs the user added by hand
//   - https only, GET only, no cookies, no referrer, no cache, no redirects
//     (a redirect could otherwise move the request to another host)
//   - a size cap and a timeout
// The manifest CSP additionally limits connections to https.

import { LISTS } from '../engine/lists.js';

export const LIST_HOST = 'raw.githubusercontent.com';
export const SB_HOST = 'sponsor.ajay.app';
const MAX_BYTES = 12 * 1024 * 1024;
const TIMEOUT = 45000;

const builtInUrls = new Set(LISTS.flatMap(l => l.urls));

export function isAllowedUrl(url, { customUrls = [], sponsorblock = false } = {}) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (builtInUrls.has(url)) return true;
  if (customUrls.includes(url)) return true;
  if (sponsorblock && u.hostname === SB_HOST && u.pathname.startsWith('/api/skipSegments/')) return true;
  return false;
}

export async function netFetch(url, policy) {
  if (!isAllowedUrl(url, policy)) throw new Error('Blocked by Bulwark network policy: ' + url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'error',
      mode: 'cors',
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = +res.headers.get('content-length');
    if (len > MAX_BYTES) throw new Error('Response too large');
    // Stream with a running cap so a hostile server cannot exhaust memory.
    if (!res.body || !res.body.getReader) return await res.text();
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { ctrl.abort(); throw new Error('Response too large'); }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(buf);
  } finally {
    clearTimeout(timer);
  }
}
