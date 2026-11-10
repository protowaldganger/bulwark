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

const FLAG = (m = 0) => fs.readFileSync(path.join(ROOT, `content/youtube-flag-${m}.js`), 'utf8');
const b64 = (p) => Buffer.from(decodeURIComponent(p).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const YAF4 = [0x60, 0x01, 0x78, 0x01, 0xa2, 0x06, 0x01, 0x2e];
const EAFG = [0x78, 0x01, 0x60, 0x01];
const tick = (ms = 150) => new Promise(r => setTimeout(r, ms));

function adFreeDom(url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', body = '', m = 0) {
  const d = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  d.window.Response = Response;
  d.window.eval(FLAG(m));
  d.window.eval(MAIN);
  // What the isolated script would forward to the service worker.
  d.retired = [];
  const name = d.window.document.documentElement.getAttribute('data-bwy');
  d.window.document.addEventListener(name, (e) => { if (String(e.detail)[0] === 'm') d.retired.push(+String(e.detail).slice(1)); });
  return d;
}
const playerReq = (extra = {}) => ({
  context: { client: { clientName: 'WEB', clientVersion: '2.2026', mainAppWebInfo: { graftUrl: '/watch?v=dQw4w9WgXcQ' } } },
  videoId: 'dQw4w9WgXcQ',
  playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
  ...extra
});
const freeResponse = (vid = 'dQw4w9WgXcQ') => {
  const r = playerResponse();
  for (const k of ['adPlacements', 'adSlots', 'playerAds', 'auxiliaryUi']) delete r[k];
  r.videoDetails = { videoId: vid };
  r.playerConfig = { audioConfig: { loudnessDb: 1, muteOnStart: true } };
  return r;
};
const errorResponse = (status = 'UNPLAYABLE', vid = 'dQw4w9WgXcQ') => ({ playabilityStatus: { status, reason: 'Something went wrong' }, videoDetails: { videoId: vid } });

test('ad-free: player requests get the method 1 params, merged and idempotent', () => {
  const w = adFreeDom().window;
  assert.equal(w.document.documentElement.getAttribute('data-bwf'), null, 'flag attribute removed');
  const plain = JSON.parse(w.JSON.stringify(playerReq()));
  assert.deepEqual([...b64(plain.params)], YAF4);
  // A search-result navigation (get_watch) keeps its own params.
  const own = 'ygUUb2ZmaWNpYWwgbXVzaWMgdmlkZW-gBwE%3D';
  const nav = { context: playerReq().context, playerRequest: playerReq({ params: own }), watchNextRequest: {} };
  const sent = JSON.parse(w.JSON.stringify(nav));
  assert.deepEqual([...b64(sent.playerRequest.params)], [...b64(own), ...YAF4]);
  assert.ok(/^[A-Za-z0-9_%-]+$/.test(sent.playerRequest.params), 'stays URL-safe and encoded');
  // Stringifying the same object twice does not append twice.
  const again = JSON.parse(w.JSON.stringify(nav));
  assert.equal(again.playerRequest.params, sent.playerRequest.params);
  // Unrelated objects are untouched and stringify still looks native.
  assert.equal(w.JSON.stringify({ a: 1, videoId: 'x' }), '{"a":1,"videoId":"x"}');
  assert.ok(String(w.JSON.stringify).includes('[native code]'));
  // Pages that start at a later method use it.
  assert.deepEqual([...b64(JSON.parse(adFreeDom(undefined, '', 1).window.JSON.stringify(playerReq())).params)], EAFG);
  const inline = JSON.parse(adFreeDom(undefined, '', 2).window.JSON.stringify(playerReq()));
  assert.equal(inline.params, undefined);
  assert.equal(inline.playbackContext.contentPlaybackContext.isInlinePlaybackNoAd, true);
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
  const other = freeResponse('previewVid01');
  assert.equal(w.JSON.parse(JSON.stringify(other)).playerConfig.audioConfig.muteOnStart, true, 'a muted preview stays muted');
});

test('ad-free: page loads through the pp rule are unmuted', () => {
  for (const pp of ['YAF4AaIGAS4', 'eAFgAQ%3D%3D']) {
    const w = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ&pp=' + pp).window;
    w.eval(`var ytInitialPlayerResponse = ${JSON.stringify(freeResponse())};`);
    assert.equal(w.ytInitialPlayerResponse.playerConfig.audioConfig.muteOnStart, undefined, pp);
  }
});

function stubPlayer(w, vid = 'dQw4w9WgXcQ') {
  const pl = w.document.getElementById('movie_player');
  pl.loads = [];
  pl.time = 0;
  pl.getVideoData = () => ({ video_id: vid });
  pl.getCurrentTime = () => pl.time;
  pl.loadVideoById = (o) => pl.loads.push(o);
  return pl;
}

test('ad-free: a page load that still has ads is reloaded once, ad-free', async () => {
  const w = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ&pp=ygUFbXVzaWM%3D', '<div id="movie_player"></div>').window;
  const pl = stubPlayer(w);
  const pr = playerResponse(); pr.playerConfig = { playbackStartConfig: { startSeconds: 42 } };
  w.eval(`var ytInitialPlayerResponse = ${JSON.stringify(pr)};`);
  assert.equal(w.ytInitialPlayerResponse.adPlacements, undefined, 'still pruned meanwhile');
  await tick();
  assert.equal(JSON.stringify(pl.loads), JSON.stringify([{ videoId: 'dQw4w9WgXcQ', startSeconds: 42 }]));
  w.eval(`ytInitialPlayerResponse = ${JSON.stringify(pr)};`);
  await tick();
  assert.equal(pl.loads.length, 1, 'only once per video');
  // Live streams are never reloaded.
  const live = adFreeDom('https://www.youtube.com/watch?v=liveliveliv', '<div id="movie_player"></div>').window;
  const lp = stubPlayer(live, 'liveliveliv');
  const lr = playerResponse(); lr.videoDetails = { videoId: 'liveliveliv', isLive: true };
  live.JSON.parse(JSON.stringify(lr));
  await tick();
  assert.equal(lp.loads.length, 0);
});

test('ad-free: when YouTube still sends ads, the next method is used and remembered', async () => {
  const d = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>');
  const w = d.window;
  const pl = stubPlayer(w);
  w.JSON.stringify(playerReq());
  w.JSON.parse(JSON.stringify(playerResponse())); // ads despite method 1
  await tick();
  assert.equal(pl.loads.length, 1);
  assert.deepEqual(d.retired, [1], 'service worker told to start at the next method');
  assert.deepEqual([...b64(JSON.parse(w.JSON.stringify(playerReq())).params)], EAFG);
});

test('ad-free: an error response is retried normally, and the method retired only if that plays', async () => {
  // Refused: the normal retry works, so the method is retired.
  const d = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ&pp=YAF4AaIGAS4', '<div id="movie_player"></div>');
  const w = d.window;
  const pl = stubPlayer(w);
  w.eval(`var ytInitialPlayerResponse = ${JSON.stringify(errorResponse())};`); // the page load itself fails
  await tick();
  assert.equal(pl.loads.length, 1, 'reloaded');
  const retry = JSON.parse(w.JSON.stringify(playerReq()));
  assert.equal(retry.params, undefined, 'the retry goes out unchanged');
  assert.deepEqual(d.retired, []);
  w.JSON.parse(JSON.stringify(playerResponse())); // normal response, OK
  assert.deepEqual(d.retired, [1]);
  assert.deepEqual([...b64(JSON.parse(w.JSON.stringify(playerReq({ videoId: 'otherVideo1' }))).params)], EAFG, 'next video uses method 2');
  // A video that is unavailable either way retires nothing.
  const d2 = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>');
  const p2 = stubPlayer(d2.window);
  d2.window.JSON.stringify(playerReq());
  d2.window.JSON.parse(JSON.stringify(errorResponse('ERROR')));
  await tick();
  assert.equal(p2.loads.length, 1);
  d2.window.JSON.stringify(playerReq());
  d2.window.JSON.parse(JSON.stringify(errorResponse('ERROR')));
  await tick();
  assert.equal(p2.loads.length, 1, 'tried normally once, no loop');
  assert.deepEqual(d2.retired, []);
  // Sign-in and age checks are the video's own requirements.
  const d3 = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>');
  const p3 = stubPlayer(d3.window);
  d3.window.JSON.stringify(playerReq());
  d3.window.JSON.parse(JSON.stringify(errorResponse('LOGIN_REQUIRED')));
  await tick();
  assert.equal(p3.loads.length, 0);
});

test('ad-free: an error screen in the player after an accepted request is caught', async () => {
  const d = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>');
  const w = d.window;
  const pl = stubPlayer(w);
  w.JSON.stringify(playerReq());
  w.JSON.parse(JSON.stringify(freeResponse()));
  // YouTube's "Something went wrong" overlay appears instead of the video.
  const err = w.document.createElement('div');
  err.className = 'ytp-error';
  Object.defineProperty(err, 'offsetWidth', { value: 640 });
  pl.appendChild(err);
  await tick(500);
  assert.equal(pl.loads.length, 1, 'reloaded normally');
  assert.equal(JSON.parse(w.JSON.stringify(playerReq())).params, undefined);
  w.JSON.parse(JSON.stringify(playerResponse()));
  assert.deepEqual(d.retired, [1]);
  // A video that starts playing is left alone.
  const d2 = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>');
  const p2 = stubPlayer(d2.window);
  d2.window.JSON.stringify(playerReq());
  d2.window.JSON.parse(JSON.stringify(freeResponse()));
  p2.time = 3;
  await tick(500);
  assert.equal(p2.loads.length, 0);
  assert.deepEqual(d2.retired, []);
});

test('ad-free: methods that still get ads are kept; a held-back video moves on to the next', async () => {
  // Method 3 (inline) avoids the wait but still gets ads, which are pruned.
  const d = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>', 2);
  const w = d.window;
  const pl = stubPlayer(w);
  const req = JSON.parse(w.JSON.stringify(playerReq()));
  assert.equal(req.playbackContext.contentPlaybackContext.isInlinePlaybackNoAd, true);
  const r = w.JSON.parse(JSON.stringify(playerResponse()));
  assert.equal(r.adPlacements, undefined, 'pruned');
  await tick();
  assert.deepEqual(d.retired, [], 'ads alone do not retire it');
  // But if YouTube still holds the video back, the next method is tried.
  pl.getPlayerStateObject = () => ({ isBuffering: true });
  pl.getStatsForNerds = () => ({ buffer_health_seconds: '0.00 s', resolution: '0x0' });
  await tick(4600);
  assert.deepEqual(d.retired, [3]);
  assert.equal(pl.loads.length, 1, 'reloaded with the next method');
  const next = JSON.parse(w.JSON.stringify(playerReq()));
  assert.ok(next.params && [...b64(next.params)].slice(-3).join() === [0xf0, 0x05, 0x01].join(), 'method 4: field 94');
  // The last methods: a fixed params value, then the channel player.
  assert.equal(JSON.parse(adFreeDom(undefined, '', 4).window.JSON.stringify(playerReq({ params: 'abc' }))).params, 'YAHI');
  assert.equal(JSON.parse(adFreeDom(undefined, '', 5).window.JSON.stringify(playerReq())).context.client.clientScreen, 'CHANNEL');
  // Normal buffering on a slow connection (some data, a picture) is fine.
  const d2 = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>', 2);
  const p2 = stubPlayer(d2.window);
  p2.getPlayerStateObject = () => ({ isBuffering: true });
  p2.getStatsForNerds = () => ({ buffer_health_seconds: '0.40 s', resolution: '1920x1080' });
  d2.window.JSON.stringify(playerReq());
  d2.window.JSON.parse(JSON.stringify(playerResponse()));
  await tick(4600);
  assert.deepEqual(d2.retired, []);
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
