// YouTube MAIN-world pruner and isolated skipper, run in jsdom.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = process.env.BW_DIST ? path.join(REPO, 'dist') : REPO; // BW_DIST=1 tests the minified build
const MAIN = fs.readFileSync(path.join(ROOT, 'content/youtube-main.js'), 'utf8');
const ISO = fs.readFileSync(path.join(ROOT, 'content/youtube-iso.js'), 'utf8');

const playerResponse = () => ({
  responseContext: {},
  playabilityStatus: { status: 'OK' },
  streamingData: { adaptiveFormats: [{ itag: 248 }] },
  videoDetails: { videoId: 'dQw4w9WgXcQ', title: 'Test' },
  adPlacements: [{ adPlacementRenderer: { config: { adPlacementConfig: { kind: 'AD_PLACEMENT_KIND_START' } } } }],
  adSlots: [{ adSlotRenderer: {} }],
  playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
  adBreakHeartbeatParams: 'Q0FB',
  auxiliaryUi: { messageRenderers: { enforcementMessageViewModel: { title: 'Ad blockers are not allowed' } } }
});

function dom(html = '<!doctype html><html><head></head><body></body></html>') {
  const d = new JSDOM(html, { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', runScripts: 'outside-only', pretendToBeVisual: true });
  d.window.Response = Response;
  d.window.eval(MAIN);
  return d;
}

test('inline ytInitialPlayerResponse is pruned when the page assigns it', () => {
  const d = dom();
  const w = d.window;
  w.eval(`var ytInitialPlayerResponse = ${JSON.stringify(playerResponse())};`);
  const pr = w.ytInitialPlayerResponse;
  assert.equal(pr.adPlacements, undefined);
  assert.equal(pr.adSlots, undefined);
  assert.equal(pr.playerAds, undefined);
  assert.equal(pr.adBreakHeartbeatParams, undefined);
  assert.equal(pr.auxiliaryUi.messageRenderers.enforcementMessageViewModel, undefined);
  assert.equal(pr.streamingData.adaptiveFormats[0].itag, 248, 'content untouched');
  assert.equal(pr.videoDetails.videoId, 'dQw4w9WgXcQ');
});

test('JSON.parse of /player and pbj responses is pruned', () => {
  const w = dom().window;
  const a = w.JSON.parse(JSON.stringify(playerResponse()));
  assert.equal(a.adPlacements, undefined);
  const pbj = w.JSON.parse(JSON.stringify([{ playerResponse: playerResponse() }, { response: {} }]));
  assert.equal(pbj[0].playerResponse.adPlacements, undefined);
  const plain = w.JSON.parse('{"a":1,"b":[1,2,3]}');
  assert.equal(JSON.stringify(plain), '{"a":1,"b":[1,2,3]}');
  assert.ok(String(w.JSON.parse).includes('[native code]'), 'JSON.parse still looks native');
});

test('fetch Response.json is pruned', async () => {
  const w = dom().window;
  const res = new w.Response(JSON.stringify(playerResponse()), { headers: { 'content-type': 'application/json' } });
  const body = await res.json();
  assert.equal(body.adPlacements, undefined);
  assert.equal(body.playerAds, undefined);
});

test('ads engagement panel and Shorts ad entries are removed', () => {
  const w = dom().window;
  const next = w.JSON.parse(JSON.stringify({ engagementPanels: [
    { engagementPanelSectionListRenderer: { targetId: 'engagement-panel-ads' } },
    { engagementPanelSectionListRenderer: { targetId: 'engagement-panel-comments-section' } }
  ] }));
  assert.equal(next.engagementPanels.length, 1);
  const reels = w.JSON.parse(JSON.stringify({ entries: [
    { command: { reelWatchEndpoint: { videoId: 'a' } } },
    { command: { reelWatchEndpoint: { videoId: 'b', adClientParams: { isAd: true } } } }
  ] }));
  assert.equal(reels.entries.length, 1);
});

test('pruning cost on a realistic player response is in microseconds', () => {
  const w = dom().window;
  const big = playerResponse();
  big.streamingData.adaptiveFormats = Array.from({ length: 60 }, (_, i) => ({ itag: i, url: 'x'.repeat(400) }));
  big.captions = { tracks: Array.from({ length: 40 }, (_, i) => ({ lang: 'l' + i })) };
  const text = JSON.stringify(big);
  const N = 2000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) w.JSON.parse(text);
  const hooked = (performance.now() - t0) / N;
  const t1 = performance.now();
  for (let i = 0; i < N; i++) JSON.parse(text);
  const native = (performance.now() - t1) / N;
  const overhead = hooked - native;
  console.log(`    JSON.parse ${native.toFixed(3)} ms native, +${(overhead * 1000).toFixed(1)} µs with pruning`);
  assert.ok(overhead < 0.5, `overhead ${overhead} ms`);
});

test('skipper mutes, speeds up and skips an ad, then restores playback', async () => {
  const d = new JSDOM('<!doctype html><html><body><div id="movie_player" class="html5-video-player"><video></video><button class="ytp-skip-ad-button">Skip</button></div></body></html>',
    { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = d.window;
  const sent = [];
  w.chrome = {
    runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve({ segments: [] }); } },
    storage: { local: { get: () => Promise.resolve({ settings: { youtube: { skipper: true, sponsorblock: false } } }) }, onChanged: { addListener() {} } }
  };
  const video = w.document.querySelector('video');
  let duration = 15, current = 0, clicked = 0;
  Object.defineProperty(video, 'duration', { get: () => duration });
  Object.defineProperty(video, 'currentTime', { get: () => current, set: (v) => { current = v; } });
  w.document.querySelector('.ytp-skip-ad-button').addEventListener('click', () => clicked++);
  video.muted = false;
  video.playbackRate = 1.25;
  w.eval(ISO);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  const player = w.document.getElementById('movie_player');
  player.classList.add('ad-showing');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(video.muted, true);
  assert.equal(video.playbackRate, 16);
  assert.ok(current >= 14.8, 'jumped to the end of the ad');
  assert.ok(clicked >= 1, 'clicked skip');
  player.classList.remove('ad-showing');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1.25);
  duration = 600; current = 10;
  player.classList.add('ad-showing');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(current, 10, 'never seeks inside a stitched (long) stream');
  w.close();
});

test('pruner stats reach the isolated script privately and leave nothing on the page', async () => {
  const d = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', runScripts: 'outside-only' });
  const w = d.window;
  w.Response = Response;
  const sent = [];
  w.chrome = {
    runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve(null); } },
    storage: { local: { get: () => Promise.resolve({}) }, onChanged: { addListener() {} } }
  };
  const symbolsBefore = Object.getOwnPropertySymbols(w).length;
  const keysBefore = new Set(Object.getOwnPropertyNames(w));
  w.eval(MAIN);
  const added = Object.getOwnPropertyNames(w).filter(k => !keysBefore.has(k));
  w.eval(ISO);
  await new Promise(r => setTimeout(r, 0));
  try {
    assert.equal(w.document.documentElement.attributes.length, 0, 'handoff attribute removed');
    assert.equal(Object.getOwnPropertySymbols(w).length, symbolsBefore, 'no symbols added to window');
    assert.deepEqual(added.filter(k => !/^yt/.test(k)), [], 'MAIN world adds no globals');
  } catch (e) { w.close(); throw e; }
  w.JSON.parse(JSON.stringify(playerResponse()));
  await new Promise(r => setTimeout(r, 3700));
  const st = sent.find(m => m.t === 'yt-stats');
  assert.ok(st && st.pruned === 1 && st.samples === 1);
  w.close();
});
