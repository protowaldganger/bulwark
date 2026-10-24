# Bulwark Ad Blocker

By protowaldganger.

A private, fast Manifest V3 ad and tracker blocker for Chrome-based browsers. It is built around one goal: YouTube with no ads and no wait. It compiles the filter lists Brave Shields ships by default into native browser rules, and adds a dedicated YouTube engine, per-site cookie control and a strict privacy mode.

Bulwark has no servers, no accounts and no telemetry. With strict privacy on (the default) it makes no network request at all unless you press **Check for updates**.

## Install

From a release:

1. Download `bulwark.zip` from the Releases page and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `bulwark` folder (the one containing `manifest.json`).
4. Pin Bulwark from the puzzle menu. The dashboard opens on first install.

From source: clone the repository, run `npm install && npm run build`, and load the `dist` folder with **Load unpacked**.

### Other browsers

Bulwark works in Chromium-based browsers (Chrome, Edge, Brave, Arc, Vivaldi) and in browsers that run Chrome extensions on other engines. Every non-core API is feature-detected: if MAIN-world scripts cannot be registered, Bulwark injects them at navigation commit instead (Dashboard shows **Script injection: Fallback**), and if the faded "off" toolbar icon cannot be drawn, the normal icon stays.

## Privacy and security

**What leaves your computer.** Every network request goes through one guarded function. It allows only these destinations, sends no cookies and no referrer, refuses plain http and redirects, and caps the response size:

| Destination | When | What it learns |
| --- | --- | --- |
| raw.githubusercontent.com | Only when you press Check for updates (strict privacy) or on your update interval (strict privacy off) | Your IP address and that a list was downloaded |
| sponsor.ajay.app | Never with strict privacy. Otherwise only if you turn SponsorBlock on | Your IP address and 4 hex characters of a SHA-256 hash, shared by thousands of videos. Never the video ID |
| List URLs you add yourself | Same as filter lists | Your IP address |

All built-in lists come from that single GitHub host, so list maintainers' own servers never see you. The extension's content security policy blocks any non-https connection.

**What websites can see.** Bulwark leaves nothing on the page that names or fingerprints it:

- no globals, symbols or attributes in the page; the YouTube hooks report themselves as native code
- data passes from page scripts to the extension over a private channel with a random name, handed over through an attribute that is removed before any page script runs
- cosmetic CSS is injected at user origin, invisible to the page's stylesheets
- the extension's internal files (redirect surrogates) use per-session random URLs, so sites cannot probe for them
- the element picker uses a random tag name inside a closed shadow root

What no extension can hide: a site can notice its ads did not load, and every site sees your IP address. For that, use a VPN or Tor and stay signed out of YouTube.

**Strict privacy** (on by default, toggle under **Privacy**):

- no automatic list updates (press Check for updates whenever you like)
- SponsorBlock stays off
- the "most blocked domains" breakdown is kept in memory only and never written to disk

**Other hardening:**

- Only Bulwark's own pages and content scripts can message its service worker, and content scripts are limited to a small fixed set of messages.
- Filter lists cannot run arbitrary code. Scriptlets are a fixed set of built-in functions and lists only supply their arguments; uBlock's "trusted" scriptlets are not supported.
- List updates that suddenly shrink below half their usual size are rejected as truncated or tampered with.
- Permissions are the minimum the features need. `unlimitedStorage` was removed.

## What it does

### Network blocking

All request blocking is done by Chrome's native `declarativeNetRequest` engine before a request starts. There is no JavaScript on the request path.

About 145,000 filters from EasyList, EasyPrivacy, uBlock filters (ads, quick fixes, unbreak, privacy) and Brave's unbreak and specific lists compile into about 17,500 native rules. Plain `||host^` filters that share the same options are merged into one rule with a list of request domains, the technique uBlock Origin Lite uses, so Chrome indexes far fewer rules with identical matching. Exceptions beat blocks, `$important` beats exceptions, your own filters beat every list, and the per-site switch beats everything.

Supported syntax covers what real lists use: `||domain^`, wildcards, anchors, `/regex/`, `$third-party`, `$domain=`, `$to=`, `$denyallow=`, `$method=`, resource types, `$important`, `$match-case`, `$document`, `$redirect=` (with neutered surrogates for Google IMA, GPT, GTM, Analytics and others), `$removeparam=`, cross-list `$badfilter`, and `$generichide` / `$elemhide` / `$specifichide`. Filters that cannot be expressed natively (`$popup`, `$csp`, `$replace`, HTML filtering) are skipped rather than applied with a different meaning.

### Cosmetic filtering

- A frame's CSS is injected as soon as its navigation commits, before the page or the content script runs, so hidden ads never flash.
- Generic filters use Brave's and uBlock Origin's technique: the page reports which class and id names exist, and only matching selectors are injected.
- Procedural filters (`:has-text()`, `:upward()`, `:xpath()`, `:matches-path()`, `:min-text-length()`, `:matches-css()`, `:matches-attr()`, `:style()`, `:remove()`) run only on sites that have them.
- Scriptlets for about 4,400 sites load at `document_start` only on the hosts that need them.

### YouTube

Three layers, cheapest first:

1. **Payload pruning.** YouTube's ad schedule (`adPlacements`, `adSlots`, `playerAds`, `adBreakHeartbeatParams`) is removed from the player data before the player reads it, through `JSON.parse`, `Response.json()` and the inline `ytInitialPlayerResponse` / `ytInitialData`. No ad is ever scheduled, so videos start as soon as content is buffered. The same pass removes the anti-adblock dialog payload, the ads panel and Shorts ads. Cost: about 10 to 20 µs per player response.
2. **Network rules** for ad pings, `pagead`, `ad_break` and DoubleClick from YouTube pages. The `ad_status.js` detection bait gets a surrogate instead of being blocked.
3. **Fallback skipper.** If an ad still starts, it is muted, played at 16x and skipped, and your volume and speed come back. Long (stitched) streams are never seeked. It wakes only when the player's state changes and pauses in background tabs.

Optional: hide merch shelves, promotions, Shorts and end-screen cards; SponsorBlock auto-skip with an Undo notice (off under strict privacy).

### Cookie control

| Policy | First-party cookies | Third-party cookies |
| --- | --- | --- |
| Block all | none | none |
| **Necessary only** (default) | session, sign-in, security, CSRF, consent, cart, load-balancer and bot-protection cookies | none |
| Allow all | all except known trackers | non-tracking only |

Third-party tracking cookies are never accepted under any setting. Enforcement happens at three levels: Chrome strips `Cookie` / `Set-Cookie` headers, a `document.cookie` guard runs at `document_start`, and cookies that still land are classified and removed immediately. Domains run by the same company (youtube.com and google.com, for example) can share cookies so sign-in keeps working. If a site keeps signing you out, switch it to **Allow all** from the popup, or name the cookie under **Cookies > Extra necessary cookies**.

### Interface

Monochrome ink on white, Apple's system typeface (San Francisco on macOS), pill buttons, hairline rows and grey-pill navigation. Dark mode follows the system.

- **Popup:** global switch, per-site switch, live counts, per-site cookie policy, list status, element picker, dashboard.
- **Dashboard:** Dashboard, Privacy, Filter lists, YouTube, Cookies, Whitelist, My filters, Backup, About.
- **Right-click menu:** block element, block media source, pause on this site, cookie policy for this site, open dashboard.

## Size and speed

| | 1.0 | 1.1 |
| --- | --- | --- |
| Installed size | 16.6 MB | 6.1 MB |
| Files | 101 | 66 |
| Download (zip) | 2.7 MB | 1.7 MB |
| Native rules Chrome must index | 117,951 | 17,538 |
| Service worker | 15 modules | 1 file, 83 KB |

Nothing was removed to get there. Merged host rules, a compact cosmetic format that stores each selector once, scriptlet data that ships once instead of twice, rule hashes recomputed on demand instead of shipped, minified code, and an "off" icon drawn at runtime do the work.

Speed changes in 1.1: CSS injection at navigation commit; cached per-site plans in the service worker; a one-file service worker that starts faster; content scripts that send only what changed; the YouTube helper reacting to events instead of polling heavy queries; and the toolbar icon updated only for tabs whose state differs.

## Filter list updates

Bundled lists ship as static rulesets. An update downloads the list, compiles it with the same compiler, and diffs it against the bundled copy by rule identity: changed rules are switched off inside the static ruleset and their replacements are added as dynamic rules. Unchanged lists are detected by checksum. Runtime lists (cookie notices, annoyances, your own URLs) are applied as dynamic rules.

## Development

`dist/` is the minified build that ships. The source tree also loads unpacked as-is, as long as `node_modules/` is not present.

```sh
npm install                  # esbuild, jsdom, fake-indexeddb (build and tests only)
npm run build                # download lists, compile, produce dist/
npm run build:offline        # same, from cached lists
npm test                     # 46 tests against the source
BW_DIST=1 node --test tools/tests/sw.test.mjs tools/tests/engine.test.mjs tools/tests/youtube.test.mjs   # against dist/
```

The tests boot the real service worker against in-memory Chrome APIs that apply Chrome's own validation, run the content scripts in jsdom, check that page scripts cannot see or spoof Bulwark's channels, verify the network guard, and check rule outcomes with a reference matcher: ads blocked; YouTube playback and sign-in untouched; merged host rules still block every host they came from.

## Known limits

- Popup and pop-under blocking (`$popup`) has no MV3 equivalent.
- `$csp`, `$replace`, `$urlskip`, HTML filtering and procedural filters nested in other pseudo-classes are skipped.
- Server-side stitched YouTube ads cannot be removed from the stream; the skipper fast-forwards them.
- Not tested in a live browser session; tests use simulated Chrome APIs and a simulated page.

## License and credits

Bulwark is free software by protowaldganger, released under the GNU General Public License v3.0 or later (see `LICENSE`).

Filter lists are compiled, not modified, and belong to their authors: EasyList and EasyPrivacy (GPLv3 / CC BY-SA 3.0), uBlock Origin uAssets (GPLv3), Brave adblock-lists (MPL 2.0). SponsorBlock data is CC BY-NC-SA 4.0. The redirect surrogates are compatible reimplementations of the neutered scripts used by uBlock Origin and Brave.
