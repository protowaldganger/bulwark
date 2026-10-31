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

// ------------------------------------------------- ad-free playback requests

const FLAG = fs.readFileSync(path.join(ROOT, 'content/youtube-flag.js'), 'utf8');
const b64 = (p) => Buffer.from(decodeURIComponent(p).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function adFreeDom(url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', body = '') {
  const d = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  d.window.Response = Response;
  d.window.eval(FLAG);
  d.window.eval(MAIN);
  return d;
}
const playerReq = (extra = {}) => ({
  context: { client: { clientName: 'WEB', clientVersion: '2.2026', mainAppWebInfo: { graftUrl: '/watch?v=dQw4w9WgXcQ' } } },
  videoId: 'dQw4w9WgXcQ',
  playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
  ...extra
});
const freeResponse = () => {
  const r = playerResponse();
  for (const k of ['adPlacements', 'adSlots', 'playerAds', 'auxiliaryUi']) delete r[k];
  r.playerConfig = { audioConfig: { loudnessDb: 1, muteOnStart: true } };
  return r;
};

test('ad-free: player requests get params field 15, merged and idempotent', () => {
  const w = adFreeDom().window;
  assert.equal(w.document.documentElement.getAttribute('data-bwf'), null, 'flag attribute removed');
  const plain = JSON.parse(w.JSON.stringify(playerReq()));
  assert.deepEqual([...b64(plain.params)], [0x78, 0x01]);
  // A search-result navigation (get_watch) keeps its own params.
  const nav = { context: playerReq().context, playerRequest: playerReq({ params: 'ygUUb2ZmaWNpYWwgbXVzaWMgdmlkZW-gBwE%3D' }), watchNextRequest: {} };
  const sent = JSON.parse(w.JSON.stringify(nav));
  assert.equal(sent.playerRequest.params, 'ygUUb2ZmaWNpYWwgbXVzaWMgdmlkZW-gBwF4AQ%3D%3D');
  // Stringifying the same object twice does not append twice.
  const again = JSON.parse(w.JSON.stringify(nav));
  assert.equal(again.playerRequest.params, sent.playerRequest.params);
  // Unrelated objects are untouched and stringify still looks native.
  assert.equal(w.JSON.stringify({ a: 1, videoId: 'x' }), '{"a":1,"videoId":"x"}');
  assert.ok(String(w.JSON.stringify).includes('[native code]'));
});

test('ad-free: Shorts, mobile clients, embeds and the flag being off are left alone', () => {
  const shorts = adFreeDom('https://www.youtube.com/shorts/dQw4w9WgXcQ').window;
  assert.equal(JSON.parse(shorts.JSON.stringify(playerReq())).params, undefined);
  const w = adFreeDom().window;
  const mweb = playerReq(); mweb.context.client.clientName = 'MWEB';
  assert.equal(JSON.parse(w.JSON.stringify(mweb)).params, undefined);
  const embed = adFreeDom('https://www.youtube.com/embed/dQw4w9WgXcQ').window;
  assert.equal(JSON.parse(embed.JSON.stringify(playerReq())).params, undefined);
  const off = dom().window; // no flag file
  assert.equal(JSON.parse(off.JSON.stringify(playerReq())).params, undefined);
  // Hover previews on other pages are not watch playback.
  const home = adFreeDom('https://www.youtube.com/').window;
  const preview = playerReq(); preview.context.client.mainAppWebInfo.graftUrl = '/';
  assert.equal(JSON.parse(home.JSON.stringify(preview)).params, undefined);
});

test('ad-free: the variant plays unmuted with the miniplayer, other responses keep their settings', () => {
  const w = adFreeDom().window;
  w.JSON.stringify(playerReq());
  const r = w.JSON.parse(JSON.stringify(freeResponse()));
  assert.equal(r.playerConfig.audioConfig.muteOnStart, undefined);
  assert.equal(r.playerConfig.audioConfig.loudnessDb, 1);
  assert.equal(r.playabilityStatus.miniplayer.miniplayerRenderer.playbackMode, 'PLAYBACK_MODE_ALLOW');
  const other = freeResponse(); other.videoDetails.videoId = 'previewVid01';
  assert.equal(w.JSON.parse(JSON.stringify(other)).playerConfig.audioConfig.muteOnStart, true, 'a muted preview stays muted');
});

test('ad-free: page loads through the pp rule are unmuted', () => {
  const w = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ&pp=eAE%3D').window;
  w.eval(`var ytInitialPlayerResponse = ${JSON.stringify(freeResponse())};`);
  assert.equal(w.ytInitialPlayerResponse.playerConfig.audioConfig.muteOnStart, undefined);
});

function stubPlayer(w, vid = 'dQw4w9WgXcQ') {
  const pl = w.document.getElementById('movie_player');
  pl.loads = [];
  pl.getVideoData = () => ({ video_id: vid });
  pl.getCurrentTime = () => 0;
  pl.loadVideoById = (o) => pl.loads.push(o);
  return pl;
}

test('ad-free: a page load that still has ads is reloaded once, ad-free', async () => {
  const w = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ&pp=ygUFbXVzaWM%3D', '<div id="movie_player"></div>').window;
  const pl = stubPlayer(w);
  const pr = playerResponse(); pr.playerConfig = { playbackStartConfig: { startSeconds: 42 } };
  w.eval(`var ytInitialPlayerResponse = ${JSON.stringify(pr)};`);
  assert.equal(w.ytInitialPlayerResponse.adPlacements, undefined, 'still pruned meanwhile');
  await new Promise(r => setTimeout(r, 120));
  assert.equal(JSON.stringify(pl.loads), JSON.stringify([{ videoId: 'dQw4w9WgXcQ', startSeconds: 42 }]));
  w.eval(`ytInitialPlayerResponse = ${JSON.stringify(pr)};`);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(pl.loads.length, 1, 'only once per video');
  // Live streams are never reloaded.
  const live = adFreeDom('https://www.youtube.com/watch?v=liveliveliv', '<div id="movie_player"></div>').window;
  const lp = stubPlayer(live, 'liveliveliv');
  const lr = playerResponse(); lr.videoDetails = { videoId: 'liveliveliv', isLive: true };
  live.JSON.parse(JSON.stringify(lr));
  await new Promise(r => setTimeout(r, 120));
  assert.equal(lp.loads.length, 0);
});

test('ad-free: when YouTube still sends ads, the next method is used', async () => {
  const w = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>').window;
  const pl = stubPlayer(w);
  w.JSON.stringify(playerReq());
  w.JSON.parse(JSON.stringify(playerResponse())); // ads despite field 15
  await new Promise(r => setTimeout(r, 120));
  assert.equal(pl.loads.length, 1);
  const next = JSON.parse(w.JSON.stringify(playerReq()));
  assert.equal(next.params, undefined);
  assert.equal(next.playbackContext.contentPlaybackContext.isInlinePlaybackNoAd, true);
});

test('ad-free: a refused variant is retried as a normal request', async () => {
  const w = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>').window;
  const pl = stubPlayer(w);
  w.JSON.stringify(playerReq());
  const refused = { playabilityStatus: { status: 'UNPLAYABLE', errorScreen: { playerErrorMessageRenderer: { subreason: { runs: [{ navigationEndpoint: { urlEndpoint: { url: 'https://support.google.com/youtube/answer/3037019' } } }] } } } }, videoDetails: { videoId: 'dQw4w9WgXcQ' } };
  w.JSON.parse(JSON.stringify(refused));
  await new Promise(r => setTimeout(r, 120));
  assert.equal(pl.loads.length, 1);
  assert.equal(JSON.parse(w.JSON.stringify(playerReq())).params, undefined, 'the retry goes out unchanged');
  // A video that is simply unavailable is not retried.
  const w2 = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>').window;
  const p2 = stubPlayer(w2);
  w2.JSON.stringify(playerReq());
  w2.JSON.parse(JSON.stringify({ playabilityStatus: { status: 'ERROR', reason: 'Video unavailable' }, videoDetails: { videoId: 'dQw4w9WgXcQ' } }));
  await new Promise(r => setTimeout(r, 120));
  assert.equal(p2.loads.length, 0);
});

test('anti-adblock hooks: abnormality listener dropped, 17 s wait shortened', async () => {
  const w = dom().window;
  let pageRegistered = 0;
  w.hit = () => pageRegistered++;
  await w.eval(`Promise.resolve({}).then(function (W) { hit(); /* W.addEventListener("onAbnormalityDetected", f) */ })`);
  assert.equal(pageRegistered, 0, 'page callback that registers onAbnormalityDetected never runs');
  let ok = 0;
  await w.eval(`Promise.resolve(2).then(function (v) { return v * 2; })`).then(v => { ok = v; });
  assert.equal(ok, 4, 'other callbacks unaffected');
  let ran = false;
  const t0 = Date.now();
  w.ranNative = () => { ran = true; };
  w.eval(`setTimeout(ranNative.bind(null), 17000)`);
  await new Promise(r => setTimeout(r, 200));
  assert.ok(ran && Date.now() - t0 < 1000, 'native-code 17 s timer runs at once');
});
