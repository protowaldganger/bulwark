# Bulwark Ad Blocker

By protowaldganger. Current version: **1.2.2**.

A private, fast Manifest V3 ad and tracker blocker for Chrome-based browsers and Safari. It is built around one goal: YouTube with no ads and no wait. It compiles the filter lists Brave Shields ships by default into native browser rules, and adds a dedicated YouTube engine, per-site cookie control and a strict privacy mode.

Bulwark has no servers, no accounts and no telemetry. With strict privacy on (the default) it makes no network request at all unless you press **Check for updates**.

## What's new in 1.2.4

YouTube:
- **Videos play first.** In late 2026 YouTube started answering some ad-blocking tricks with a full-page "This content isn't available. Try again later." or a video stuck on a spinner at 0:00 with "Experiencing interruptions?". Bulwark now gives way: if a video stays stuck or YouTube shows its error, Bulwark loads it once more exactly as YouTube sent it. An ad may then play, and is skipped. A video that plays beats an ad that is blocked.
- **"Video won't play? Fix it".** A new button in the Bulwark popup on YouTube. It loads the video again with nothing changed or removed, for the rest of that page. Reloading the page goes back to normal.
- **Ads stitched into the video are jumped over.** Signed-in viewers get some ads inside the video stream. Bulwark used to fast-forward them, which YouTube answered with "Something went wrong" for a few seconds. It now jumps to the end of the ad and keeps YouTube's "abnormality" check switched off, as uBlock Origin does.
- **Brave: no wait when you click to the next video.** Bulwark switches off two YouTube experiments that kept every ad-free request (Shields' and Bulwark's) from applying, and marks the player so Shields asks the way that works first. Opening a video directly (a link or a new tab) still waits on a spinner before the video starts: 3 to 20 seconds in testing, varying from load to load, with no ads and no error.
- **Brave: YouTube video ads are left to Shields.** Running both made YouTube stop videos with "Something went wrong". Details under [YouTube](#youtube).
- **No "Something went wrong" when signed in.** YouTube refuses a changed video request from a signed-in account, so Bulwark no longer sends one when you are signed in; ads are skipped instead.
- **No more ads flashing past and "Something went wrong" in Brave.** Bulwark had four ways of asking YouTube for a video without ads and moved to the next one whenever one had a bad moment. Three of them no longer work (one is refused, two still bring ads), so it soon ended up on those for hours. Bulwark now uses only the one that works, falls back to a normal load for a single video when needed, and tries again sooner.
- **No more changed YouTube addresses.** Bulwark used to add a `pp` setting to every video address to ask for the ad-free version. YouTube now rejects that with its "content isn't available" page, so it is gone. Bulwark only changes the player's own request, the same way uBlock Origin does, and only in the four forms uBlock Origin itself uses on youtube.com.
- **YouTube's cookie prompt is answered for you.** "Before you continue to YouTube" is answered with **Reject all**, the same as clicking it yourself. Only a button labelled exactly "Reject all" (in a few languages) is ever clicked, at most once a minute per tab. Your YouTube settings cookie (`PREF`: language, theme, autoplay) is now kept as necessary.
- **"Experiencing interruptions?" is hidden again.** YouTube moved it to a new kind of notice; Bulwark now finds it by its text, in English and Swedish, so other notices still show.
- **No more "Something went wrong".** When YouTube answered an ad-free request with its error screen, 1.2.0 left the error up. Bulwark now has several ways of asking, notices when YouTube refuses one or holds the video back anyway, plays the video normally right away, and switches to the next way for every video after that. **Options > YouTube** shows which method is in use.
- **No more "Video paused. Continue watching?" at the start of a video.** Two of the ad-free methods told YouTube you had been inactive for a long time, and YouTube answered with its pause prompt set to fire at once. No method does that any more.
- **No more black screen with "Experiencing interruptions?".** YouTube now also puts ads in the video stream itself and sends them at playing speed. When an ad turns up anyway, Bulwark loads the video again with the next ad-free method, and it never jumps further into an ad than has arrived (jumping past that left the player stuck at 0:00). The "Experiencing interruptions?" message is hidden.
- **No more stuck "Something went wrong" screen.** YouTube now refuses the two channel-page ad-free variants for many signed-in viewers and shows its error screen, which is part of the watch page, not the player. Bulwark noticed the error but reloaded the video behind that screen, so it stayed up. Now the screen is detected, the video is loaded normally, and once it works the screen is taken down and playback starts.
- **No more 10 to 30 seconds of buffering before a video.** YouTube now holds a video back ("Experiencing interruptions?") when ads it scheduled are removed, so a request that still gets ads no longer helps. Bulwark now starts with the request that got no ads in testing, and moves on from any request that still gets ads, remembering the one that works.
- **You stay signed in after closing the browser.** With **Necessary only**, a site's long-lived "keep me signed in" cookie was removed when its name was not one Bulwark recognised, so you had to sign in again after every restart. Cookies the site's own server sets as HttpOnly (out of reach of page scripts, which is where sign-ins live) are now kept. Analytics and ad cookies are set by scripts and are still removed, and known tracker cookies are removed either way.
- **No more two videos playing at once.** YouTube fetches other videos while one plays (the next one for autoplay, and ad breaks). Bulwark could load one of those into the player on top of the video you were watching, so two soundtracks played together. Now only the video the page is for is ever reloaded.

Safety:
- **Warning page for dangerous sites.** Two new lists are on by default: uBlock Origin's "Badware risks" (scams, fake downloads, tech-support fraud, bundled adware) and URLhaus's malware hosts. Opening a listed site shows Bulwark's warning page instead of the page, with **Go back** and, behind a click, **Open anyway** (this tab only) or **Don't warn me about this site again**. Any filter that blocks a whole page (`$document`) now shows this page instead of the browser's bare error.
- **Cryptominers and more ad servers.** uBlock Origin's "Resource abuse" list and Peter Lowe's ad and tracking server list are on by default, as in uBlock Origin.

Control:
- **Switches for each site** in the Bulwark button: **No pop-ups**, **No media** (video and audio), **No fonts**, **No JavaScript** and **No hiding**. They are listed, and can be cleared, under **Sites** in the dashboard.
- **Remove element.** Click anything on a page to remove it right away, with Undo; nothing is saved and a reload brings it back. An overlay that locked scrolling gives it back.
- **Request log.** From the Bulwark button: everything Bulwark blocked, allowed or changed in that tab, with the list and the rule that did it, live, with filters and search. It lives in memory only and goes when the tab closes. Chrome only provides this to extensions loaded unpacked.
- **Lighter mode** (off by default, under **Filter lists**) skips the generic hiding rules, as uBlock Origin Lite does; switch **Full hiding** on for a site that needs them.
- **More YouTube switches:** hide Playables and members-only videos; end screen cards now also cover info cards; promotions now also cover paid movie suggestions.

Blocking:
- **Pop-ups and pop-unders are closed.** About 3,000 `$popup` filters from the lists (and any you write yourself) now work: when a page opens a tab or window to a matching address, Bulwark closes it.
- **Tracking links are skipped.** About 210 `$urlskip` filters send links that bounce through a tracker straight to their destination, so the tracker is never contacted. Links on pages are also rewritten to their real address (`href-sanitizer`).
- **More filters work.** `$csp` and `$permissions` filters, procedural filters nested in `:has()`, `:remove-attr()`, `:remove-class()` and `::before`/`::after` styles, and about 30 more scriptlets used against anti-adblock walls and cookie banners. Lists that are not uBlock Origin's or Brave's cannot use the powerful "trusted" scriptlets, as in uBlock Origin.
- **New optional lists** under **Filter lists**, all off by default: Cookie notices (answers banners with "reject" where it can and keeps that answer), Annoyances, Fanboy's Social Blocking List, AdGuard URL Tracking filter and Frellwit's Swedish Filter.

Privacy and cookies:
- **Global Privacy Control.** Bulwark tells every site not to sell or share your data, with the `Sec-GPC` header and `navigator.globalPrivacyControl`. On by default; switch under **Privacy**.

## What's new in 1.2.3

- **Cookie banners stay answered.** With **Necessary only**, Bulwark removed the cookie some sites use to remember your cookie-banner choice, so the banner came back on every visit (X stores it as `d_prefs`). Your answer to a cookie banner is now kept as a necessary cookie on X and on sites that use common consent-tool names; tracking cookies are still removed.

## What's new in 1.2.2

- **No more warnings on the extensions page.** Chrome and Brave skip regular-expression rules that compile to more than 2 KB, and listed a warning for each one. The build now asks Chromium which expressions it accepts and leaves the 27 oversized ones out (list updates check the same way), and expressions that end in an open repeat are rewritten to a smaller equivalent form. Nothing that was blocking before stops blocking: the browser was already skipping these rules.

## What's new in 1.2.1

- **YouTube no longer gets stuck on "Something went wrong".** When YouTube answered an ad-free request with its error screen, 1.2.0 left the error up. Bulwark now has six ways of asking, notices when YouTube refuses one or holds the video back anyway, plays the video normally right away, and switches to the next way for every video after that. **Options > YouTube** shows which method is in use.

## What's new in 1.2.0

- **YouTube videos start right away.** When ads are blocked, YouTube makes the video wait on a spinner for most of the ads' length, with no ad shown. Bulwark now asks YouTube for the version of each video it serves without ads, so there is no ad and no wait: under 1 second to the first frame instead of about 13 seconds in testing. New option **Ask for ad-free playback** under **YouTube** (on by default). Details in [YouTube](#youtube).
- **YouTube anti-adblock hooks.** The player's "abnormality" check, which swaps the video for the anti-adblock screen, is never registered, and a fixed 17 second penalty timer runs at once.
- **Safari.** A Safari build with a rule adapter and a script that builds and signs the app with Xcode. See [Safari](#safari).

## Install

From a release:

1. Download `bulwark.zip` from the Releases page and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `bulwark` folder (the one containing `manifest.json`).
4. Pin Bulwark from the puzzle menu. The dashboard opens on first install.

From source: clone the repository, run `npm install && npm run build`, and load the `dist` folder with **Load unpacked**.

Updating: replace the folder's contents with the new version, then click the reload button on Bulwark in `chrome://extensions`. Settings are kept.

Safari: see [Safari](#safari).

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

- no globals, symbols or attributes left in the page; the YouTube hooks report themselves as native code
- data passes from page scripts to the extension over a private channel with a random name, handed over through an attribute that is removed before any page script runs
- cosmetic CSS is injected at user origin, invisible to the page's stylesheets
- the extension's internal files (redirect surrogates) use per-session random URLs, so sites cannot probe for them
- the element picker uses a random tag name inside a closed shadow root

What no extension can hide: a site can notice its ads did not load, and every site sees your IP address. For that, use a VPN or Tor and stay signed out of YouTube. With **Ask for ad-free playback** on, YouTube also receives the ad-free request itself (a changed value in its player requests), so it can tell that this method is in use. Turn the option off if you would rather not send it.

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

All request blocking is done by the browser's native `declarativeNetRequest` engine before a request starts. There is no JavaScript on the request path.

About 150,000 filters from EasyList, EasyPrivacy, uBlock filters (ads, quick fixes, unbreak, privacy, badware risks, resource abuse), Brave's unbreak and specific lists, Peter Lowe's list and URLhaus compile into about 19,500 native rules. Regular expressions the browser would skip for size (over 2 KB compiled) are left out at build time; the build checks them in Chromium and records the answers in `tools/regex-support.json`. Plain `||host^` filters that share the same options are merged into one rule with a list of request domains, the technique uBlock Origin Lite uses, so Chrome indexes far fewer rules with identical matching. Exceptions beat blocks, `$important` beats exceptions, your own filters beat every list, and the per-site switch beats everything.

Supported syntax covers what real lists use: `||domain^`, wildcards, anchors, `/regex/`, `$third-party`, `$domain=`, `$to=`, `$denyallow=`, `$method=`, resource types, `$important`, `$match-case`, `$document`, `$redirect=` (with neutered surrogates for Google IMA, GPT, GTM, Analytics and others), `$removeparam=`, cross-list `$badfilter`, and `$generichide` / `$elemhide` / `$specifichide`. `$csp` and `$permissions` add response headers, and `$urlskip` sends the tab to a small extension page that works out the real destination and goes there. `$popup` filters are matched when a page opens a new tab or window, and the tab is closed. A filter that blocks a whole page sends the tab to Bulwark's warning page (uBlock Origin's "strict blocking"); in the security lists every listed host counts as a whole page. Filters that cannot be expressed in MV3 (`$replace`, HTML filtering, CNAME uncloaking) are skipped rather than applied with a different meaning.

### Cosmetic filtering

- A frame's CSS is injected as soon as its navigation commits, before the page or the content script runs, so hidden ads never flash.
- Generic filters use Brave's and uBlock Origin's technique: the page reports which class and id names exist, and only matching selectors are injected.
- Procedural filters (`:has-text()`, `:upward()`, `:xpath()`, `:matches-path()`, `:min-text-length()`, `:matches-css()` including `::before` / `::after`, `:matches-attr()`, procedural filters inside `:has()`, `:style()`, `:remove()`, `:remove-attr()`, `:remove-class()`) run only on sites that have them.
- Scriptlets for about 5,500 sites (about 12,000 with every optional list on) load at `document_start` only on the hosts that need them. Scriptlets that can set arbitrary values, click elements or rewrite responses ("trusted" scriptlets) run only from uBlock Origin's and Brave's lists and from your own filters.

### YouTube

Four layers, cheapest first:

1. **Ad-free playback requests.** When YouTube schedules ads for a video and a blocker removes them, YouTube's streaming server holds back the video, so it sits on a spinner at 0:00 with no ad ("fake buffering", then "Experiencing interruptions?"). Bulwark avoids this by changing how the player asks for the video. Only the player's own request is changed (the one that carries an `attestationRequest`); the page address, navigation bundles and caption requests are never touched. Bulwark sets the request's `params` to `oAEBogYBLg`, and falls back to `eAFgAQ` and then `YAF4AaIGAS4`. Tested on 24 November 2026, signed in and signed out, against every form in uBlock Origin's lists, these three were the only ones that came back without ads: the channel-page form was refused ("Something went wrong") and the `YAHI`, inline, `ADUNIT` and `8AUB` forms still carried ads, so Bulwark does not use them. The ad-free variant starts muted and hides the miniplayer button, so both are put back. If YouTube refuses it for a video, holds the video back anyway or sends ads, that one video is loaded again untouched. After three failures within an hour Bulwark stops asking for two hours and only removes ads. When you are signed in to YouTube, Bulwark never asks: YouTube ties a signed-in player's request to an integrity check and refuses any changed one with "Something went wrong" (error 282054944), so signed-in ads are skipped instead, including the "Visit site" card some ads end with. Shorts, embedded players, hover previews and live streams are left to the other layers. Option: **Ask for ad-free playback** (on by default); switching it off and on starts again from the first form.
2. **Payload pruning.** YouTube's ad schedule (`adPlacements`, `adSlots`, `playerAds`, `adBreakHeartbeatParams`) is removed from the player data before the player reads it, through `JSON.parse`, `Response.json()` and the inline `ytInitialPlayerResponse` / `ytInitialData`. No ad is ever played. On its own this does not stop the start-up wait described above, which is why layer 1 exists. The same pass removes the ads panel and Shorts ads, and leaves the anti-adblock pop-up in the data untouched (changing it makes YouTube stop with "Something went wrong"; it is hidden on screen instead). Cost: about 10 to 20 µs per player response.
   The page hooks also keep the player's "abnormality" check from being registered (it stops the video with "Something went wrong" when an ad is cut short) and run YouTube's fixed 17 s anti-adblock wait at once.
3. **Network rules** for ad pings, `pagead`, `ad_break` and DoubleClick from YouTube pages. The `ad_status.js` detection bait gets a surrogate instead of being blocked.
4. **Stitched ads.** Signed-in viewers often get ads stitched into the video stream itself, which no request can avoid. Bulwark moves the player straight to the end of such an ad, as uBlock Origin does, and they never count against a request form.
5. **Fallback skipper.** If an ad still starts, it is muted and played at 16x, and your volume and speed come back. It never jumps inside an ad: YouTube now answers that with "Something went wrong". It wakes only when the player's state changes and pauses in background tabs.
6. **Safety net.** If a video stays at 0:00 with nothing loaded for about 4 seconds, or YouTube shows its error screen, the video is loaded once more with nothing changed and nothing removed, and the error screen is taken down when it plays. Once per video, so it can never loop.

#### In Brave

Brave Shields runs its own YouTube ad handling (uBlock Origin's quick fixes). Two blockers changing the same player fight each other, and with a signed-in account YouTube now stops the video with "Something went wrong" (error 282054944) whenever an ad is rushed or changed. So in Brave, Bulwark leaves YouTube video ads to Shields: it does not change player requests or data and does not touch ads in the player. It does one small thing to help Shields: Shields picks its way of asking for the ad-free video by a marker in the player's user agent, and tries the channel-page, YAHI and inline forms before `oaeb`. For a signed-in account those three failed in testing, so a video could reload three times before it played. Bulwark adds the `oaeb` marker up front (as long as **Ask for ad-free playback** is on), so Shields asks the working way first. It also switches off two YouTube experiments (`all_web_enable_network_machine` and `all_web_network_machine_raw_request`): with them on, as on a signed-in test account, the player builds its requests in a way no request rule can reach, so neither Shields nor Bulwark could ask for the ad-free version at all. Bulwark does the same in other browsers. It still answers YouTube's cookie prompt, hides feed, search and sidebar ads, blocks ad requests and hides "Experiencing interruptions?". Tested on 24 November 2026 with a signed-in account: clicking from one video to the next plays at once with no ads. Opening a video directly (a link, a new tab) waited 10 to 15 seconds on a spinner at first, because YouTube puts that first answer inside the page itself, out of reach of request rules, and its streaming server then tells the player to wait. Bulwark removes the ad schedule from that built-in first answer (Shields' rules did not, in testing), so the player does not wait for an ad. The ready-made "Ad blockers are not allowed on YouTube" pop-up in the same answer is left exactly as it is: removing it, or even marking it not visible, is what makes YouTube stop with "Something went wrong" (error 282054944). The stylesheet hides it on screen. It also runs YouTube's fixed 17-second anti-adblock timer at once (as uBlock Origin's quick fixes do; in testing it held a flagged account's videos back for about 20 seconds), and shortens the server's wait: it finds the wait time in YouTube's small streaming control messages (from googlevideo.com) and sets it to about 0.1 s, leaving video data untouched. This follows Brave's own script for the same problem (`brave-yt-sabr-fix`), which Brave switched off in May 2026 without giving a reason, so if YouTube starts misbehaving in Brave, switching **Ask for ad-free playback** off removes it along with the rest of this help. What is left: a video opened directly still waits 3 to 20 seconds (it varied from load to load in testing), with nothing loading meanwhile. It looks like a wait YouTube's server sets for accounts it has flagged for ad blocking; nothing in the page that Bulwark could change made it shorter. Clicking from one video to the next is not affected. Keep Shields on for YouTube.

#### If YouTube still breaks

1. Click the Bulwark button and choose **Video won't play? Fix it**. The video loads again untouched; ads may play and are skipped.
2. Still stuck: switch **Ask for ad-free playback** off under **YouTube** in the dashboard.
3. Still stuck: turn Bulwark off for youtube.com with the big switch in the Bulwark button. If the video then works, please open an issue.
4. If it fails with Bulwark off too, YouTube itself is refusing your connection (it sends the same "This content isn't available" page when it limits an address, for example on a VPN).

Optional: hide merch shelves, promotions, Shorts, Playables, members-only videos and end-screen and info cards; SponsorBlock auto-skip with an Undo notice (off under strict privacy).

### Cookie control

| Policy | First-party cookies | Third-party cookies |
| --- | --- | --- |
| Block all | none | none |
| **Necessary only** (default) | session, sign-in, security, CSRF, consent, cart, load-balancer and bot-protection cookies, and cookies the site's server marks HttpOnly (where "keep me signed in" lives) | none |
| Allow all | all except known trackers | non-tracking only |

Third-party tracking cookies are never accepted under any setting. Enforcement happens at three levels: Chrome strips `Cookie` / `Set-Cookie` headers, a `document.cookie` guard runs at `document_start`, and cookies that still land are classified and removed immediately. Domains run by the same company (youtube.com and google.com, for example) can share cookies so sign-in keeps working. If a site keeps signing you out, switch it to **Allow all** from the popup, or name the cookie under **Cookies > Extra necessary cookies**. With the optional **Cookie notices** list on, the consent cookies it sets to answer banners are kept too.

### Interface

Monochrome ink on white, Apple's system typeface (San Francisco on macOS), pill buttons, hairline rows and grey-pill navigation. Dark mode follows the system.

- **Popup:** global switch, per-site switch, live counts, per-site cookie policy, switches for the site (no pop-ups, media, fonts, JavaScript or hiding), list status, element picker, element remover, request log, dashboard.
- **Dashboard:** Dashboard, Privacy, Filter lists, YouTube, Cookies, Sites, My filters, Backup, About.
- **Warning page** for dangerous sites, and a **request log** page per tab.
- **Right-click menu:** block element, block media source, pause on this site, cookie policy for this site, open dashboard.

## Size and speed

| | 1.0 | 1.1 | 1.2 |
| --- | --- | --- | --- |
| Installed size | 16.6 MB | 6.1 MB | 6.1 MB |
| Files | 101 | 66 | 68 |
| Download (zip) | 2.7 MB | 1.7 MB | 1.7 MB |
| Native rules Chrome must index | 117,951 | 17,538 | 17,511 |
| Service worker | 15 modules | 1 file, 83 KB | 1 file, 86 KB |

Nothing was removed to get there. Merged host rules, a compact cosmetic format that stores each selector once, scriptlet data that ships once instead of twice, rule hashes recomputed on demand instead of shipped, minified code, and an "off" icon drawn at runtime do the work.

1.2 adds the ad-free YouTube requests and Safari support without changing the download size or the rule count.

Speed changes in 1.1: CSS injection at navigation commit; cached per-site plans in the service worker; a one-file service worker that starts faster; content scripts that send only what changed; the YouTube helper reacting to events instead of polling heavy queries; and the toolbar icon updated only for tabs whose state differs.

## Safari

Safari on macOS runs web extensions from inside a small Mac app, so Bulwark for Safari is built on your own Mac with Xcode (Safari 16.4 or later).

1. `npm install && npm run build`. Besides `dist/`, this writes the Safari version to `dist-safari/`: rules are rewritten into the subset Safari supports (about 50 of 17,500 are left out), and features Safari lacks are detected at runtime.
2. `bash safari/build-safari.command` wraps it in an app, builds it, installs it as `~/Applications/Bulwark.app` and opens it once.
3. In Safari: **Settings > Extensions**, tick **Bulwark Ad Blocker** and click **Always Allow on Every Website...**.

Safari only keeps signed extensions after a restart. Sign in to Xcode with a free Apple Account and create an **Apple Development** certificate, and the script signs Bulwark with it; otherwise **Allow unsigned extensions** is needed every time Safari starts. Full steps and the differences from the Chrome version: [safari/README.md](safari/README.md).

## Filter list updates

Bundled lists ship as static rulesets. An update downloads the list, compiles it with the same compiler, and diffs it against the bundled copy by rule identity: changed rules are switched off inside the static ruleset and their replacements are added as dynamic rules. Unchanged lists are detected by checksum. Runtime lists (cookie notices, annoyances, your own URLs) are applied as dynamic rules.

## Development

`dist/` is the minified build that ships. The source tree also loads unpacked as-is, as long as `node_modules/` is not present.

```sh
npm install                  # esbuild, jsdom, fake-indexeddb (build and tests only)
npm install -g playwright    # optional: lets the build check new regular expressions in Chromium
npm run build                # download lists, compile, produce dist/ and dist-safari/
npm run build:offline        # same, from cached lists
npm test                     # 65 tests against the source (run a build first)
BW_DIST=1 npm test           # the same tests against dist/
npm run test:safari          # every Safari rule checked against what Safari accepts
```

The tests boot the real service worker against in-memory Chrome APIs that apply Chrome's own validation (and Safari's, for the Safari build), run the content scripts in jsdom, check that page scripts cannot see or spoof Bulwark's channels, verify the network guard, and check rule outcomes with a reference matcher: ads blocked; YouTube playback and sign-in untouched; merged host rules still block every host they came from.

## Known limits

- URLhaus also lists over 100,000 single malware download addresses; only its whole bad hosts fit the browser's rule budget, so only those are used.
- The request log needs Bulwark loaded unpacked (Chrome only reports matched rules to unpacked extensions). On Safari, blocked pages show Safari's own error instead of the warning page.
- Pop-ups are closed just after they open, so one may flash briefly. A pop-under opened by a script with no address cannot be matched.
- `$replace`, HTML filtering and CNAME uncloaking have no MV3 equivalent and are skipped.
- Server-side stitched YouTube ads cannot be removed from the stream; the skipper fast-forwards them.
- YouTube changes its anti-adblock checks every few weeks. When a video would not play otherwise, Bulwark lets its ads play (and skips them) rather than leave you on an error.
- The automated tests use simulated browser APIs and a simulated page. Real-world use so far: a Chromium-based browser and Safari 27 on macOS.

## License and credits

Bulwark is free software by protowaldganger, released under the GNU General Public License v3.0 or later (see `LICENSE`).

Filter lists are compiled, not modified, and belong to their authors: EasyList, EasyPrivacy and Fanboy's Social Blocking List (GPLv3 / CC BY-SA 3.0), uBlock Origin uAssets (GPLv3), Brave adblock-lists (MPL 2.0), Peter Lowe's list (free to use, see pgl.yoyo.org), URLhaus Malicious URL Blocklist by malware-filter (CC0, data from abuse.ch), AdGuard URL Tracking filter (GPLv3), Frellwit's Swedish Filter (GPLv3). SponsorBlock data is CC BY-NC-SA 4.0. The redirect surrogates are compatible reimplementations of the neutered scripts used by uBlock Origin and Brave.
