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
  assert.equal(JSON.stringify(pr.auxiliaryUi.messageRenderers.enforcementMessageViewModel), JSON.stringify({ title: 'Ad blockers are not allowed' }), 'the anti-adblock pop-up is left exactly as it is (changing it causes error 282054944)');
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
  let duration = 15, current = 0, clicked = 0, loaded = 15;
  Object.defineProperty(video, 'duration', { get: () => duration });
  Object.defineProperty(video, 'buffered', { get: () => ({ length: 1, start: () => 0, end: () => loaded }) });
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
  assert.equal(current, 0, 'never jumps inside an ad (YouTube treats that as tampering)');
  assert.ok(clicked >= 1, 'clicked skip');
  player.classList.remove('ad-showing');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1.25);
  duration = 600; current = 10; loaded = 600;
  player.classList.add('ad-showing');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(current, 10, 'never seeks inside a stitched (long) stream');
  w.close();
});

test('keyboard focus returns to the player when a video starts, never from a visible field', async () => {
  const d = new JSDOM('<!doctype html><html><body><input id="search"><div id="hidden-toast" style="display:none"><button id="b">Find out why</button></div><div id="movie_player" class="html5-video-player" tabindex="-1"><video></video></div></body></html>',
    { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = d.window;
  w.chrome = { runtime: { sendMessage: () => Promise.resolve(null) }, storage: { local: { get: () => Promise.resolve({}) }, onChanged: { addListener() {} } } };
  w.document.hasFocus = () => true;
  // jsdom has no layout: report boxes for elements that are not display:none.
  w.Element.prototype.getClientRects = function () { return this.closest('[style*="display:none"]') ? [] : [{}]; };
  w.eval(ISO);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await new Promise(r => setTimeout(r, 30));
  const player = w.document.getElementById('movie_player');
  const video = player.querySelector('video');
  // Focus stuck on a button inside a hidden pop-up.
  w.document.getElementById('b').focus();
  video.dispatchEvent(new w.Event('playing'));
  assert.equal(w.document.activeElement, player, 'back on the player');
  // Typing in the search box is never interrupted.
  w.document.getElementById('search').focus();
  video.dispatchEvent(new w.Event('playing'));
  assert.equal(w.document.activeElement.id, 'search');
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
const tick = (ms = 150) => new Promise(r => setTimeout(r, ms));

// Methods (see METHODS): 0 oaeb, 1 eafg, 2 yaf4. A report of 1 means "method 0 failed".
const OAEB_M = 0, FAILED_0 = 1;
function adFreeDom(url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', body = '', m = OAEB_M) {
  const d = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  d.window.Response = Response;
  if (m !== null) d.window.eval(FLAG(m));
  d.window.eval(MAIN);
  // What the isolated script would forward to the service worker.
  d.retired = [];
  d.channel = d.window.document.documentElement.getAttribute('data-bwy');
  d.window.document.addEventListener(d.channel, (e) => { if (String(e.detail)[0] === 'm') d.retired.push(+String(e.detail).slice(1)); });
  return d;
}
// The player's own request: it carries an attestationRequest.
const playerReq = (extra = {}) => ({
  context: { client: { clientName: 'WEB', clientVersion: '2.2026', mainAppWebInfo: { graftUrl: '/watch?v=dQw4w9WgXcQ' } } },
  videoId: 'dQw4w9WgXcQ',
  playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
  attestationRequest: { omitBotguardData: true },
  ...extra
});
const sent = (w, req = playerReq()) => JSON.parse(w.JSON.stringify(req));
const freeResponse = (vid = 'dQw4w9WgXcQ') => {
  const r = playerResponse();
  for (const k of ['adPlacements', 'adSlots', 'playerAds', 'auxiliaryUi']) delete r[k];
  r.videoDetails = { videoId: vid };
  r.playerConfig = { audioConfig: { loudnessDb: 1, muteOnStart: true } };
  return r;
};
const errorResponse = (status = 'UNPLAYABLE', vid = 'dQw4w9WgXcQ') => ({ playabilityStatus: { status, reason: 'Something went wrong' }, videoDetails: { videoId: vid } });

function stubPlayer(w, vid = 'dQw4w9WgXcQ') {
  const pl = w.document.getElementById('movie_player');
  pl.loads = [];
  pl.time = 0;
  pl.getVideoData = () => ({ video_id: vid });
  pl.getCurrentTime = () => pl.time;
  pl.loadVideoById = (o) => pl.loads.push(o);
  return pl;
}
const starve = (pl) => {
  pl.getPlayerStateObject = () => ({ isBuffering: true });
  pl.getStatsForNerds = () => ({ buffer_health_seconds: '0.00 s', resolution: '0x0' });
};

test('ad-free: only the player request is changed, in the uBlock Origin forms', () => {
  const w = adFreeDom().window;
  assert.equal(w.document.documentElement.getAttribute('data-bwf'), null, 'flag attribute removed');
  assert.equal(sent(w).params, 'oAEBogYBLg');
  assert.equal(sent(w, playerReq({ params: 'ygUFbXVzaWM%3D' })).params, 'oAEBogYBLg', 'replaces a tracking params value');
  // A navigation bundle (get_watch) is sent as it is.
  const nav = { context: playerReq().context, playerRequest: playerReq({ params: 'own' }), watchNextRequest: {} };
  assert.equal(sent(w, nav).playerRequest.params, 'own');
  // Requests without an attestationRequest (captions, settings, others) too.
  const noAtt = playerReq(); delete noAtt.attestationRequest;
  assert.equal(sent(w, noAtt).params, undefined);
  assert.equal(sent(w, playerReq({ captionsRequested: true })).params, undefined);
  // Unrelated objects are untouched and stringify still looks native.
  assert.equal(w.JSON.stringify({ a: 1, videoId: 'x' }), '{"a":1,"videoId":"x"}');
  assert.ok(String(w.JSON.stringify).includes('[native code]'));
  // The forms that were refused or still got ads are gone.
  const r = sent(w);
  assert.equal(r.context.client.clientScreen, undefined);
  assert.equal(r.playbackContext.contentPlaybackContext.isInlinePlaybackNoAd, undefined);
  assert.equal(r.playbackContext.contentPlaybackContext.lactMilliseconds, undefined, 'no fake activity time');
});

test('ad-free: the page address is never rewritten (no pp redirect rule, no flag files past the last method)', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'content/youtube-flag-0.js')));
  assert.equal(fs.existsSync(path.join(ROOT, 'content/youtube-flag-3.js')), false);
  // The fallbacks are the other params values that came back without ads.
  assert.equal(sent(adFreeDom(undefined, '', 1).window).params, 'eAFgAQ');
  assert.equal(sent(adFreeDom(undefined, '', 2).window).params, 'YAF4AaIGAS4');
  assert.equal(/addOrReplaceParams/.test(fs.readFileSync(path.join(REPO, 'background/rules.js'), 'utf8')), false);
});

test('ad-free: Shorts, mobile clients, embeds and the flag being off are left alone', () => {
  assert.equal(sent(adFreeDom('https://www.youtube.com/shorts/dQw4w9WgXcQ').window).params, undefined);
  const w = adFreeDom().window;
  const mweb = playerReq(); mweb.context.client.clientName = 'MWEB';
  assert.equal(sent(w, mweb).params, undefined);
  assert.equal(sent(adFreeDom('https://www.youtube.com/embed/dQw4w9WgXcQ').window).params, undefined);
  assert.equal(sent(dom().window).params, undefined, 'no flag file');
  // Signed in: YouTube refuses a changed request, so none is sent.
  const si = adFreeDom().window;
  si.ytcfg = { data_: { LOGGED_IN: true } };
  assert.equal(sent(si).params, undefined, 'signed-in requests go out unchanged');
  const home = adFreeDom('https://www.youtube.com/').window;
  const preview = playerReq(); preview.context.client.mainAppWebInfo.graftUrl = '/';
  assert.equal(sent(home, preview).params, undefined);
});

test('ad-free: the variant plays unmuted with the miniplayer, other responses keep their settings', () => {
  const w = adFreeDom().window;
  w.JSON.stringify(playerReq());
  const r = w.JSON.parse(JSON.stringify(freeResponse()));
  assert.equal(r.playerConfig.audioConfig.muteOnStart, undefined);
  assert.equal(r.playerConfig.audioConfig.loudnessDb, 1);
  assert.equal(r.playabilityStatus.miniplayer.miniplayerRenderer.playbackMode, 'PLAYBACK_MODE_ALLOW');
  assert.equal(w.JSON.parse(JSON.stringify(freeResponse('previewVid01'))).playerConfig.audioConfig.muteOnStart, true, 'a muted preview stays muted');
});

test('ad-free: a page load that has ads is reloaded once, ad-free', async () => {
  const w = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>').window;
  const pl = stubPlayer(w);
  const pr = playerResponse(); pr.playerConfig = { playbackStartConfig: { startSeconds: 42 } };
  w.eval(`var ytInitialPlayerResponse = ${JSON.stringify(pr)};`);
  assert.equal(w.ytInitialPlayerResponse.adPlacements, undefined, 'still pruned meanwhile');
  await tick();
  assert.equal(JSON.stringify(pl.loads), JSON.stringify([{ videoId: 'dQw4w9WgXcQ', startSeconds: 42 }]));
  w.eval(`ytInitialPlayerResponse = ${JSON.stringify(pr)};`);
  await tick();
  assert.equal(pl.loads.length, 1, 'only once per video');
  const live = adFreeDom('https://www.youtube.com/watch?v=liveliveliv', '<div id="movie_player"></div>').window;
  const lp = stubPlayer(live, 'liveliveliv');
  const lr = playerResponse(); lr.videoDetails = { videoId: 'liveliveliv', isLive: true };
  live.JSON.parse(JSON.stringify(lr));
  await tick();
  assert.equal(lp.loads.length, 0, 'live streams are never reloaded');
});

test('ad-free: when YouTube still sends ads, the next method is used and remembered', async () => {
  const d = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>');
  const w = d.window;
  const pl = stubPlayer(w);
  w.JSON.stringify(playerReq());
  w.JSON.parse(JSON.stringify(playerResponse())); // ads despite method 0
  await tick();
  assert.equal(pl.loads.length, 1);
  assert.deepEqual(d.retired, [FAILED_0], 'service worker told to start at the next method');
  assert.equal(sent(w, playerReq({ videoId: 'otherVideo1' })).params, 'oAEBogYBLg', 'other videos still ask ad-free after one failure');
});

test('ad-free: an error response is retried untouched, and the method retired only if that plays', async () => {
  const d = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>');
  const w = d.window;
  const pl = stubPlayer(w);
  w.JSON.stringify(playerReq());
  w.JSON.parse(JSON.stringify(errorResponse()));
  await tick();
  assert.equal(pl.loads.length, 1, 'reloaded');
  assert.equal(sent(w).params, undefined, 'the retry goes out unchanged');
  assert.deepEqual(d.retired, []);
  const back = w.JSON.parse(JSON.stringify(playerResponse())); // plays
  assert.deepEqual(d.retired, [FAILED_0]);
  assert.ok(back.adPlacements, 'the retry keeps its ads: playing beats blocking');
  assert.equal(sent(w, playerReq({ videoId: 'otherVideo1' })).params, 'oAEBogYBLg', 'other videos still ask ad-free after one failure');
  // A video that is unavailable either way retires nothing and never loops.
  const d2 = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>');
  const p2 = stubPlayer(d2.window);
  d2.window.JSON.stringify(playerReq());
  d2.window.JSON.parse(JSON.stringify(errorResponse('ERROR')));
  await tick();
  d2.window.JSON.stringify(playerReq());
  d2.window.JSON.parse(JSON.stringify(errorResponse('ERROR')));
  await tick();
  assert.equal(p2.loads.length, 1, 'tried once, no loop');
  assert.deepEqual(d2.retired, []);
  // Sign-in and age checks are the video's own requirements.
  const d3 = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>');
  const p3 = stubPlayer(d3.window);
  d3.window.JSON.stringify(playerReq());
  d3.window.JSON.parse(JSON.stringify(errorResponse('LOGIN_REQUIRED')));
  await tick();
  assert.equal(p3.loads.length, 0);
});

test('ad-free: the untouched retry is never judged as the ad-free request (no chain of retired methods)', async () => {
  // Seen live in Brave: the ad-free request is refused, the untouched retry
  // plays with its ads, and those ads must not count against the method a
  // second time or against the next one.
  const d = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>');
  const w = d.window;
  const pl = stubPlayer(w);
  w.JSON.stringify(playerReq());
  w.JSON.parse(JSON.stringify(errorResponse()));
  w.JSON.parse(JSON.stringify(errorResponse())); // YouTube parses it twice
  await tick();
  w.JSON.stringify(playerReq());
  w.JSON.parse(JSON.stringify(playerResponse()));
  w.JSON.parse(JSON.stringify(playerResponse()));
  await tick(300);
  assert.deepEqual(d.retired, [FAILED_0], 'one report, for the refused method only');
  assert.equal(pl.loads.length, 1, 'one reload');
});

test('ad-free: ads that show up in the player anyway move on to the next method', async () => {
  const d = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player" class="html5-video-player"></div>');
  const w = d.window;
  const pl = stubPlayer(w);
  w.JSON.stringify(playerReq());
  w.JSON.parse(JSON.stringify(freeResponse()));
  pl.classList.add('ad-showing');
  await tick(700);
  assert.deepEqual(d.retired, [FAILED_0]);
  assert.equal(pl.loads.length, 1, 'reloaded with the next method');
  assert.equal(sent(w, playerReq({ videoId: 'otherVideo1' })).params, 'oAEBogYBLg', 'other videos still ask ad-free after one failure');
});

test('ad-free: the next video fetched ahead for autoplay is never loaded into the player', async () => {
  const d = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player" class="html5-video-player"></div>');
  const w = d.window;
  const pl = stubPlayer(w);
  w.JSON.stringify(playerReq({ videoId: 'nextVideo01', playbackContext: { prefetchPlaybackContext: {} } }));
  w.JSON.parse(JSON.stringify({ ...playerResponse(), videoDetails: { videoId: 'nextVideo01' } }));
  await tick(600);
  assert.equal(pl.loads.length, 0, 'not loaded on top of the playing video');
  assert.deepEqual(d.retired, []);
  w.JSON.parse(JSON.stringify({ ...playerResponse(), videoDetails: { videoId: 'otherVideo1' } }));
  await tick(600);
  assert.equal(pl.loads.length, 0);
  w.history.pushState({}, '', '/watch?v=nextVideo01');
  pl.getVideoData = () => ({ video_id: 'nextVideo01' });
  w.JSON.stringify(playerReq({ videoId: 'nextVideo01' }));
  w.JSON.parse(JSON.stringify({ ...playerResponse(), videoDetails: { videoId: 'nextVideo01' } }));
  await tick();
  assert.deepEqual(d.retired, [FAILED_0]);
  assert.equal(pl.loads.length, 1);
  assert.equal(pl.loads[0].videoId, 'nextVideo01');
});

test('ad-free: the watch page error screen is caught and taken down once the video works', async () => {
  const d = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    '<ytd-watch-flexy player-unavailable><div id="player"><yt-playability-error-supported-renderers id="error-screen">Something went wrong</yt-playability-error-supported-renderers><div id="movie_player"></div></div></ytd-watch-flexy>');
  const w = d.window;
  const pl = stubPlayer(w);
  let played = 0, response = null;
  pl.playVideo = () => { played++; };
  pl.getPlayerResponse = () => response;
  w.JSON.stringify(playerReq());
  w.JSON.parse(JSON.stringify(freeResponse()));
  await tick(500);
  assert.equal(pl.loads.length, 1, 'reloaded untouched');
  response = { videoDetails: { videoId: 'dQw4w9WgXcQ' }, playabilityStatus: { status: 'OK' } };
  w.JSON.stringify(playerReq()); // the retry's own request
  w.JSON.parse(JSON.stringify(playerResponse()));
  assert.deepEqual(d.retired, [FAILED_0]);
  await tick(600);
  assert.equal(w.document.querySelector('ytd-watch-flexy').hasAttribute('player-unavailable'), false);
  assert.equal(w.document.getElementById('error-screen').hidden, true);
  assert.equal(played, 1, 'playback started');
});

test('safety net: an error screen on any video is answered with one untouched reload', async () => {
  // No ad-free request at all (a normal page load): the error screen still
  // gets one retry with nothing changed.
  const d = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    '<ytd-watch-flexy><div id="player"><div id="movie_player"></div></div></ytd-watch-flexy>', null);
  const w = d.window;
  const pl = stubPlayer(w);
  w.document.querySelector('ytd-watch-flexy').setAttribute('player-unavailable', '');
  await tick(700);
  assert.equal(pl.loads.length, 1, 'reloaded once');
  assert.ok(w.JSON.parse(JSON.stringify(playerResponse())).adPlacements, 'its ads are left in');
  w.document.querySelector('ytd-watch-flexy').removeAttribute('player-unavailable');
  w.document.querySelector('ytd-watch-flexy').setAttribute('player-unavailable', '');
  await tick(700);
  assert.equal(pl.loads.length, 1, 'never twice');
});

test('safety net: a video held at 0:00 after its ads were removed is loaded again with its ads', async () => {
  const d = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>', null);
  const w = d.window;
  const pl = stubPlayer(w);
  starve(pl);
  assert.equal(w.JSON.parse(JSON.stringify(playerResponse())).adPlacements, undefined, 'pruned first');
  await tick(4600);
  assert.equal(pl.loads.length, 1, 'reloaded');
  assert.equal(sent(w).params, undefined);
  assert.ok(w.JSON.parse(JSON.stringify(playerResponse())).adPlacements, 'then left alone');
  // Normal buffering on a slow connection (some data, a picture) is fine.
  const d2 = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>', null);
  const p2 = stubPlayer(d2.window);
  p2.getPlayerStateObject = () => ({ isBuffering: true });
  p2.getStatsForNerds = () => ({ buffer_health_seconds: '0.40 s', resolution: '1920x1080' });
  d2.window.JSON.parse(JSON.stringify(playerResponse()));
  await tick(4600);
  assert.equal(p2.loads.length, 0);
});

test('ad-free: a held-back video moves on to the next method', async () => {
  const d = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>');
  const pl = stubPlayer(d.window);
  starve(pl);
  d.window.JSON.stringify(playerReq());
  d.window.JSON.parse(JSON.stringify(freeResponse()));
  await tick(4600);
  assert.deepEqual(d.retired, [FAILED_0]);
  assert.equal(pl.loads.length, 1);
});

test('"Fix this video" leaves the page alone and loads the video again', async () => {
  const d = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player"></div>');
  const w = d.window;
  const pl = stubPlayer(w);
  w.document.dispatchEvent(new w.CustomEvent(d.channel + 'f'));
  await tick();
  assert.equal(pl.loads.length, 1);
  assert.equal(sent(w).params, undefined, 'requests unchanged');
  assert.equal(sent(w, playerReq({ videoId: 'otherVideo1' })).params, undefined, 'for every video after it');
  assert.ok(w.JSON.parse(JSON.stringify(playerResponse())).adPlacements, 'ads left in');
  assert.ok(w.JSON.parse(JSON.stringify(playerResponse())).auxiliaryUi.messageRenderers.enforcementMessageViewModel, 'the anti-adblock pop-up is left alone');
});

test('anti-adblock hooks: abnormality listener dropped, other callbacks untouched, 17 s wait shortened', async () => {
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

test('ads stitched into the stream are jumped over and never count against a method', async () => {
  const d = adFreeDom('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div id="movie_player" class="html5-video-player"></div>');
  const w = d.window;
  const pl = stubPlayer(w);
  const seeks = [];
  pl.getStatsForNerds = () => ({ debug_info: 'SSAP, AD 1 of 2', buffer_health_seconds: '3.00 s', resolution: '1920x1080' });
  pl.getProgressState = () => ({ current: 1, duration: 15 });
  pl.seekTo = (t) => seeks.push(t);
  w.JSON.stringify(playerReq());
  w.JSON.parse(JSON.stringify(freeResponse()));
  pl.classList.add('ad-showing');
  await tick(700);
  assert.ok(seeks.includes(15), 'moved to the end of the ad');
  assert.deepEqual(d.retired, [], 'the method is kept');
  assert.equal(pl.loads.length, 0, 'no reload');
});

test('Brave marker: adds "; oaeb" to the player user agent once, nothing else', () => {
  const BRAVE = fs.readFileSync(path.join(ROOT, 'content/youtube-brave.js'), 'utf8');
  const d = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', runScripts: 'outside-only' });
  const w = d.window;
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36,gzip(gfe)';
  w.ytcfg = { data_: { INNERTUBE_CONTEXT: { client: { clientName: 'WEB', userAgent: ua, hl: 'sv' } }, EXPERIMENT_FLAGS: { all_web_enable_network_machine: true, all_web_network_machine_raw_request: true, other_flag: true }, WEB_PLAYER_CONTEXT_CONFIGS: { WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH: { serializedExperimentFlags: 'a=1&all_web_enable_network_machine=true&all_web_network_machine_raw_request=true&b=true' } } } };
  w.eval(BRAVE);
  assert.equal(w.ytcfg.data_.WEB_PLAYER_CONTEXT_CONFIGS.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH.serializedExperimentFlags, 'a=1&all_web_enable_network_machine=false&all_web_network_machine_raw_request=false&b=true', 'the player copy too');
  const F = w.ytcfg.data_.EXPERIMENT_FLAGS;
  assert.equal(F.all_web_enable_network_machine, false, 'network machine off');
  assert.equal(F.all_web_network_machine_raw_request, false);
  assert.equal(F.other_flag, true, 'other experiments untouched');
  const c = w.ytcfg.data_.INNERTUBE_CONTEXT.client;
  assert.equal(c.userAgent, ua.replace('10_15_7)', '10_15_7; oaeb)'));
  w.eval(BRAVE);
  assert.equal(c.userAgent.match(/oaeb/g).length, 1, 'never twice');
  assert.equal(c.hl, 'sv', 'nothing else changed');
  // Other sites and other clients are left alone.
  const m = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://m.youtube.com/watch?v=x', runScripts: 'outside-only' }).window;
  m.ytcfg = { data_: { INNERTUBE_CONTEXT: { client: { clientName: 'MWEB', userAgent: ua } } } };
  m.eval(BRAVE);
  assert.equal(m.ytcfg.data_.INNERTUBE_CONTEXT.client.userAgent, ua);
  w.close(); m.close();
});

test('Brave start-up wait: a SABR backoff is shortened in place, video data passes untouched', async () => {
  const BRAVE = fs.readFileSync(path.join(ROOT, 'content/youtube-brave.js'), 'utf8');
  const d = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', runScripts: 'outside-only' });
  const w = d.window;
  const small = Uint8Array.from([0x0a, 0x02, 0x08, 0x01, 0x20, 0xe0, 0x5d, 0x28, 0x05]); // field 4 = 12000 ms
  const big = new Uint8Array(5000).fill(0x20);
  w.Response = Response;
  w.fetch = (url) => Promise.resolve(new Response(String(url).includes('big') ? big : small, { status: 200, headers: { 'content-type': 'application/vnd.yt-ump' } }));
  w.eval(BRAVE);
  const r = await w.fetch('https://rr1---sn-x.googlevideo.com/videoplayback?sabr=1&rn=1');
  const out = new Uint8Array(await r.arrayBuffer());
  assert.equal(out.length, small.length, 'same length');
  assert.deepEqual([...out.slice(0, 5)], [0x0a, 0x02, 0x08, 0x01, 0x20], 'bytes before it untouched');
  const wait = (out[5] & 0x7f) + (out[6] & 0x7f) * 128;
  assert.ok(out[5] & 0x80 && !(out[6] & 0x80) && wait >= 50 && wait < 150, 'wait now ' + wait + ' ms');
  assert.deepEqual([...out.slice(7)], [0x28, 0x05], 'bytes after it untouched');
  assert.equal(r.status, 200);
  const rb = new Uint8Array(await (await w.fetch('https://rr1---sn-x.googlevideo.com/videoplayback?sabr=1&big=1')).arrayBuffer());
  assert.deepEqual(rb, big, 'large responses (video) pass through as they are');
  const other = new Uint8Array(await (await w.fetch('https://www.youtube.com/youtubei/v1/next')).arrayBuffer());
  assert.deepEqual(other, small, 'other requests are not touched');
  assert.ok(String(w.fetch).includes('[native code]'), 'fetch still looks native');
  w.close();
});

test('Brave: the page\'s built-in answer loses its ad schedule, live streams are left alone', () => {
  const BRAVE = fs.readFileSync(path.join(ROOT, 'content/youtube-brave.js'), 'utf8');
  const w = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', runScripts: 'outside-only' }).window;
  w.Response = Response; w.fetch = () => Promise.resolve(new Response(''));
  w.eval(BRAVE);
  w.eval(`var ytInitialPlayerResponse = ${JSON.stringify(playerResponse())};`);
  const r = w.ytInitialPlayerResponse;
  assert.equal(r.adPlacements, undefined); assert.equal(r.adSlots, undefined); assert.equal(r.playerAds, undefined);
  assert.equal(r.streamingData.adaptiveFormats[0].itag, 248, 'the video itself untouched');
  assert.ok(r.auxiliaryUi.messageRenderers.enforcementMessageViewModel, 'the anti-adblock pop-up stays (removing it causes error 282054944)');
  const live = playerResponse(); live.videoDetails.isLive = true;
  w.eval(`ytInitialPlayerResponse = ${JSON.stringify(live)};`);
  assert.ok(w.ytInitialPlayerResponse.adPlacements, 'live streams keep theirs');
  w.close();
});

test('Brave: the 17 s anti-adblock timer runs at once, other timers are untouched', async () => {
  const BRAVE = fs.readFileSync(path.join(ROOT, 'content/youtube-brave.js'), 'utf8');
  const w = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', runScripts: 'outside-only' }).window;
  w.Response = Response; w.fetch = () => Promise.resolve(new Response(''));
  w.eval(BRAVE);
  let ran = false, other = false; const t0 = Date.now();
  w.hit = () => { ran = true; }; w.hit2 = () => { other = true; };
  w.eval('setTimeout(hit.bind(null), 17000); setTimeout(function () { hit2(); }, 17000);');
  await new Promise(r => setTimeout(r, 200));
  assert.ok(ran && Date.now() - t0 < 1000, 'native-code 17 s timer ran at once');
  assert.equal(other, false, 'a page function with the same delay still waits');
  w.close();
});
