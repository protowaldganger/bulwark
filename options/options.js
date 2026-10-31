const view = document.getElementById('view');
const fmt = new Intl.NumberFormat();
let data = null;

const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => {
  if (r && r.error) throw new Error(r.error);
  return r;
});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, ms = 2200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

function ago(ts) {
  if (!ts) return 'never';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const sw = (id, on, extra = '') => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${extra}><span></span></label>`;
const row = (title, desc, control, meta = '') => `<div class="row"><div class="grow"><div class="title">${title}</div>${desc ? `<div class="desc">${desc}</div>` : ''}${meta ? `<div class="meta">${meta}</div>` : ''}</div>${control}</div>`;
const strict = () => !!data.settings.privacy.strict;

async function save(patch, msg = 'Saved') {
  data.settings = await send({ t: 'save-settings', patch });
  toast(msg);
}

async function load() {
  data = await send({ t: 'options' });
  document.getElementById('global').checked = data.settings.enabled;
  document.getElementById('global-label').textContent = data.settings.enabled ? 'Protection on' : 'Protection paused';
}

// ================================================================ views

const VIEWS = {
  dashboard() {
    const days = data.stats.days || {};
    const keys = [];
    for (let i = 13; i >= 0; i--) keys.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
    const series = keys.map(k => (days[k] && days[k].blocked) || 0);
    const sum = (f) => Object.values(days).reduce((a, d) => a + (d[f] || 0), 0);
    const today = days[keys[13]] || {};
    const ytCost = sum('ytSamples') ? (sum('ytCostMicros') / sum('ytSamples')).toFixed(1) : null;
    const r = data.rules;
    const staticTotal = r.enabledRulesets.reduce((a, id) => a + ((data.meta.lists[id] && data.meta.lists[id].rules) || 0), 0);
    const filters = Object.entries(data.meta.lists).reduce((a, [id, m]) => a + (r.enabledRulesets.includes(id) ? (m.filters || 0) : 0), 0);
    const top = data.stats.top || [];
    const topMax = top.length ? top[0][1] : 1;

    return `
      <h1>Dashboard</h1>
      <p class="lede">What Bulwark stopped over the last 30 days, and how little it cost. Everything here is counted and stored on this computer only.</p>
      <div class="panel figures">
        <div class="fig"><b>${fmt.format(today.blocked || 0)}</b><span>Requests blocked today</span><small>${fmt.format(sum('blocked'))} in 30 days</small></div>
        <div class="fig"><b>${fmt.format(sum('cookies'))}</b><span>Cookies blocked</span><small>${fmt.format(today.cookies || 0)} today</small></div>
        <div class="fig"><b>${fmt.format(sum('ytPruned') + sum('ytSkipped'))}</b><span>YouTube ads removed</span><small>${fmt.format(sum('ytPruned'))} before load, ${fmt.format(sum('ytSkipped'))} skipped</small></div>
        <div class="fig"><b>${fmt.format(sum('sbSkipped'))}</b><span>Sponsor segments skipped</span><small>${strict() ? 'off under strict privacy' : 'via SponsorBlock'}</small></div>
      </div>
      <div class="two">
        <div class="panel"><h2>Blocked requests, last 14 days</h2>${chart(series, keys)}</div>
        <div class="panel"><h2>Most blocked</h2>
          ${top.length ? `<div class="bars">${top.slice(0, 7).map(([d, n]) => `
            <div class="bar-row"><span class="name">${esc(d)}</span><i style="width:${Math.max(3, n / topMax * 100)}%"></i><span class="n">${fmt.format(n)}</span></div>`).join('')}</div>`
            : `<p class="faint" style="margin:0">${strict() ? 'Strict privacy keeps this list for the current session only. Browse a little and it fills in.' : 'Browse a little and this fills in.'}</p>`}
        </div>
      </div>
      <div class="section">
        <div class="head"><h2>Performance</h2></div>
        <dl class="facts">
          <dt>Network blocking</dt><dd>Native declarativeNetRequest, decided by the browser before a request starts</dd>
          <dt>YouTube ad removal</dt><dd>${ytCost !== null ? `${ytCost} µs per player response` : 'No YouTube playback yet'}</dd>
          <dt>Filters active</dt><dd>${fmt.format(filters)} filters compiled into ${fmt.format(staticTotal)} native rules</dd>
          <dt>Rule headroom</dt><dd>${r.availableStatic === null ? 'n/a' : fmt.format(r.availableStatic) + ' rules left in the shared pool'}</dd>
          <dt>Dynamic rules</dt><dd>${fmt.format(r.dynamic)} of ${fmt.format(r.limits.dynamic)}</dd>
          <dt>Cosmetic index</dt><dd>${data.cosmetic ? `${fmt.format(data.cosmetic.hosts)} sites, ${fmt.format(data.cosmetic.tokens)} generic keys, built in ${data.cosmetic.ms} ms` : 'Not built yet'}</dd>
          <dt>Last full sync</dt><dd>${data.lastSync ? `${ago(data.lastSync.at)}, ${data.lastSync.ms} ms` : 'n/a'}</dd>
          <dt>Script injection</dt><dd>${data.env.mainWorldFallback ? 'Fallback: injected at navigation' : 'Native: registered at document start'}</dd>
        </dl>
      </div>
      ${r.canTest ? `
      <div class="section">
        <div class="head"><h2>Test a URL</h2></div>
        <div class="form-row"><input type="url" id="t-url" placeholder="https://www.youtube.com/api/stats/ads?…"></div>
        <div class="form-row" style="margin-top:8px">
          <input type="text" id="t-init" placeholder="From page, e.g. https://www.youtube.com">
          <select id="t-type">${['script', 'xmlhttprequest', 'image', 'sub_frame', 'main_frame', 'stylesheet', 'media', 'ping', 'other'].map(t => `<option>${t}</option>`).join('')}</select>
          <button class="btn ink" id="t-go">Test</button>
        </div>
        <p class="note" id="t-out">Shows which rule would match a request. Available when Bulwark is loaded unpacked.</p>
      </div>` : ''}
      <div class="section">
        <div class="head"><h2>Diagnostics</h2><button class="btn ghost" id="resync">Resync everything</button><button class="btn ghost" id="reset-stats">Reset statistics</button></div>
        ${data.diagnostics.length ? `<div class="log">${data.diagnostics.map(d => `<div>${new Date(d.at).toLocaleTimeString()}  ${esc(d.area)}: ${esc(d.msg)}</div>`).join('')}</div>` : `<p class="faint" style="margin:0">No problems reported.</p>`}
      </div>`;
  },

  privacy() {
    const s = data.settings;
    const on = strict();
    const dest = (what, when, sent) => `<tr><td>${what}</td><td>${when}</td><td class="muted">${sent}</td></tr>`;
    const custom = s.customLists.filter(c => c.enabled).length;
    return `
      <h1>Privacy</h1>
      <p class="lede">Bulwark has no servers, no accounts and no telemetry. <b>Nothing about you is collected or sent anywhere.</b> The only network requests it can make are listed below, and with strict privacy on it makes none unless you press a button.</p>
      <div class="section">
        <div class="rows">
          ${row('Strict privacy', 'No automatic list updates, no SponsorBlock lookups, and no per-site history is saved. Recommended.', sw('strict', on))}
        </div>
      </div>
      <div class="section">
        <div class="head"><h2>Every request Bulwark can make</h2></div>
        <table class="tbl">
          <thead><tr><th>Where</th><th>When</th><th>What it learns</th></tr></thead>
          <tbody>
            ${dest('raw.githubusercontent.com', on ? 'Only when you press Check for updates' : `Every ${s.update.intervalHours} hours`, 'Your IP address and that a filter list was downloaded. No cookies, no referrer, nothing about your browsing.')}
            ${dest('sponsor.ajay.app', on ? 'Never (strict privacy)' : s.youtube.sponsorblock ? 'When you open a YouTube video' : 'Never (SponsorBlock is off)', 'Your IP address and 4 characters of a hash shared by thousands of videos. Never the video itself.')}
            ${custom ? dest('Lists you added', on ? 'Only when you press Check for updates' : `Every ${s.update.intervalHours} hours`, 'Your IP address, same as above.') : ''}
          </tbody>
        </table>
        <p class="note">Every request goes through one guarded function that allows only these destinations, sends no cookies or referrer, refuses redirects and plain http, and is size-capped. The extension's security policy blocks any other connection type.</p>
      </div>
      <div class="section">
        <div class="head"><h2>What websites can see</h2></div>
        <div class="rows">
          ${row('No fingerprints of its own', 'Bulwark leaves no globals, page attributes, named elements or public events behind, and its internal files have per-session random addresses.', '')}
          ${row('Ad blocking itself is visible', 'Any site can notice that its ads did not load. That is true of every ad blocker and cannot be hidden.', '')}
          ${row('Your IP address and browser', 'Bulwark cannot change these. Use a VPN or Tor, and sign out of YouTube, for that.', '')}
        </div>
      </div>
      <div class="section">
        <div class="head"><h2>Stored on this computer</h2></div>
        <div class="rows">
          ${row('Settings, filters, compiled lists', 'Kept in the browser profile. Export them under Backup; removing Bulwark erases them.', '')}
          ${row('Statistics', on ? 'Daily counts only. The per-site breakdown is kept in memory and gone when the browser restarts.' : 'Daily counts and the most blocked domains, for 30 days.', '<button class="btn" id="erase-stats">Erase</button>')}
        </div>
      </div>`;
  },

  lists() {
    const s = data.settings;
    const groups = {};
    for (const l of data.catalog) (groups[l.group] || (groups[l.group] = [])).push(l);
    const listRow = (l) => {
      const st = data.states[l.id] || {};
      const m = data.meta.lists[l.id];
      const count = m ? m.filters : (st.stats ? st.stats.network + st.stats.cosmetic : null);
      const when = st.updatedAt || (l.bundled ? data.meta.builtAt : null);
      const status = st.error ? `<span class="pill warn" title="${esc(st.error)}">Update failed</span>` :
        when ? `updated ${ago(when)}${st.delta ? ` · ${fmt.format(st.delta.added)} added, ${fmt.format(st.delta.removed)} removed since build` : ''}` : 'downloads when enabled';
      return row(`${esc(l.name)}`, esc(l.description),
        sw('l-' + l.id, s.lists[l.id], `data-list="${esc(l.id)}"`),
        `${count !== null ? fmt.format(count) + ' filters · ' : ''}${status} · <a href="${esc(l.home)}" target="_blank" rel="noopener noreferrer">source</a>`);
    };
    const custom = s.customLists.map(c => {
      const st = data.states[c.id] || {};
      return row(esc(c.name), `<span class="mono">${esc(c.url)}</span>`,
        `<button class="btn ghost" data-remove-list="${esc(c.id)}">Remove</button>${sw('c-' + c.id, c.enabled, `data-custom-list="${esc(c.id)}"`)}`,
        st.error ? `<span class="pill warn">${esc(st.error)}</span>` : st.updatedAt ? `${fmt.format(st.stats ? st.stats.network : 0)} network filters · updated ${ago(st.updatedAt)}` : 'not downloaded yet');
    }).join('');
    const auto = s.update;
    return `
      <h1>Filter lists</h1>
      <p class="lede">The lists Brave Shields uses by default, compiled into native browser rules. All of them download from a single host, and an update only applies what changed.</p>
      <div class="section">
        <div class="head"><h2>Updates</h2><span class="faint">Last check ${data.lastUpdate ? ago(data.lastUpdate.at) : 'never'}</span><button class="btn ghost" id="force">Full refresh</button><button class="btn ink" id="update">Check for updates</button></div>
        <div class="rows">
          ${row('Update automatically', strict() ? 'Off while strict privacy is on. Press Check for updates whenever you like.' : 'Downloads list changes in the background.',
            `<select id="interval" ${strict() ? 'disabled' : ''}>${[6, 12, 24, 48, 72].map(h => `<option value="${h}" ${auto.intervalHours === h ? 'selected' : ''}>Every ${h} hours</option>`).join('')}</select>${sw('auto', auto.auto && !strict(), strict() ? 'disabled' : '')}`)}
        </div>
      </div>
      ${Object.entries(groups).map(([g, ls]) => `<div class="section"><div class="head"><h2>${esc(g)}</h2></div><div class="rows">${ls.map(listRow).join('')}</div></div>`).join('')}
      <div class="section">
        <div class="head"><h2>Your lists</h2></div>
        <div class="rows">${custom || '<div class="empty">Add any Adblock Plus or uBlock Origin compatible list by its https address.</div>'}</div>
        <div class="form-row" style="margin-top:14px">
          <input type="url" id="cl-url" placeholder="https://example.com/filters.txt">
          <input type="text" id="cl-name" placeholder="Name (optional)" style="max-width:220px">
          <button class="btn ink" id="cl-add">Add list</button>
        </div>
      </div>`;
  },

  youtube() {
    const y = data.settings.youtube;
    const opt = (id, on, title, desc, disabled = false) => row(title, desc, sw('y-' + id, on && !disabled, `data-yt="${id}" ${disabled ? 'disabled' : ''}`));
    const cats = [['sponsor', 'Sponsors'], ['selfpromo', 'Self promotion'], ['interaction', 'Subscribe reminders'], ['intro', 'Intros'], ['outro', 'End cards'], ['preview', 'Previews'], ['music_offtopic', 'Non-music'], ['filler', 'Filler']];
    const sbLocked = strict();
    return `
      <h1>YouTube</h1>
      <p class="lede">Four layers, cheapest first. Videos are requested without ads, any ad data that still arrives is removed before the player reads it, ad requests are blocked by the browser, and anything that slips through is skipped the moment it appears.</p>
      <div class="section">
        <div class="head"><h2>Ads</h2></div>
        <div class="rows">
          ${opt('prune', y.prune, 'Remove ads from player data', 'Strips pre-roll, mid-roll and anti-adblock payloads before playback, so no ad is ever scheduled.')}
          ${opt('adFree', y.adFree, 'Ask for ad-free playback', 'Requests the version of each video that YouTube serves without ads, so there is no ad to remove and no spinner before the video starts. If videos stop playing, turn this off.', !y.prune)}
          ${opt('blockPings', y.blockPings, 'Block ad requests', 'Native network rules for YouTube ad endpoints and ad trackers.')}
          ${opt('skipper', y.skipper, 'Fallback skipper', 'If an ad still starts, it is muted, sped up and skipped, then your volume and speed come back.')}
        </div>
      </div>
      <div class="section">
        <div class="head"><h2>Page</h2></div>
        <div class="rows">
          ${opt('hideMerch', y.hideMerch, 'Hide merch and ticket shelves', '')}
          ${opt('hidePromos', y.hidePromos, 'Hide YouTube promotions', 'Premium upsells, movie offers and banners.')}
          ${opt('hideShorts', y.hideShorts, 'Hide Shorts', 'Shorts shelves and the Shorts tab.')}
          ${opt('hideEndCards', y.hideEndCards, 'Hide end screen cards', 'Video and channel cards over the last seconds.')}
        </div>
      </div>
      <div class="section">
        <div class="head"><h2>Sponsored segments</h2>${sbLocked ? '<span class="pill">Off under strict privacy</span>' : ''}</div>
        <div class="rows">
          ${opt('sponsorblock', y.sponsorblock, 'Skip sponsored segments', 'Uses the community SponsorBlock database. Only 4 characters of a hash shared by thousands of videos are sent, never the video id.' + (sbLocked ? ' Turn off strict privacy under Privacy to use it.' : ''), sbLocked)}
          ${opt('sbToast', y.sbToast, 'Show a skip notice', 'A small notice with Undo in the player.', sbLocked)}
          <div class="row"><div class="grow"><div class="title">Segments to skip</div>
            <div class="checks">${cats.map(([k, label]) => `<label><input type="checkbox" data-cat="${k}" ${y.sbCategories.includes(k) ? 'checked' : ''} ${sbLocked ? 'disabled' : ''}><span>${label}</span></label>`).join('')}</div>
          </div></div>
        </div>
      </div>`;
  },

  cookies() {
    const c = data.settings.cookies;
    const choice = (v, title, desc) => `<label class="choice"><input type="radio" name="ck-def" value="${v}" ${c.default === v ? 'checked' : ''}><b>${title}</b><p>${desc}</p></label>`;
    const sites = Object.entries(c.sites).sort((a, b) => a[0].localeCompare(b[0]));
    const sel = (h, p) => `<select data-site="${esc(h)}">${['block', 'necessary', 'allow'].map(x => `<option value="${x}" ${p === x ? 'selected' : ''}>${{ block: 'Block all', necessary: 'Necessary only', allow: 'Allow all' }[x]}</option>`).join('')}</select>`;
    return `
      <h1>Cookies</h1>
      <p class="lede">Cookies are stripped from requests by the browser, guarded inside the page, and cleaned from storage the moment they arrive. <b>Third-party tracking cookies are never accepted</b>, whatever you choose here.</p>
      <div class="section">
        <div class="head"><h2>Default for every site</h2></div>
        <div class="choices">
          ${choice('block', 'Block all', 'No cookies at all. Most private, but sign-ins, carts and preferences break.')}
          ${choice('necessary', 'Necessary only', 'Only what a site needs to work: session, sign-in, security, consent and cart. Recommended.')}
          ${choice('allow', 'Allow all', 'First-party cookies are kept. Third-party trackers stay blocked.')}
        </div>
      </div>
      <div class="section">
        <div class="rows">
          ${row('Block third-party cookies', 'Strips cookies from cross-site requests, except between domains run by the same company (youtube.com and google.com, for example) so sign-in keeps working.', sw('ck-3p', c.blockThirdParty))}
          ${row('Clean existing cookies', 'Apply the current rules to every cookie already stored. This can sign you out of some sites.', '<button class="btn" id="sweep">Clean now</button>')}
        </div>
      </div>
      <div class="section">
        <div class="head"><h2>Per-site</h2></div>
        ${sites.length ? `<table class="tbl"><tbody>
          ${sites.map(([h, p]) => `<tr><td>${esc(h)}</td><td>${sel(h, p)}</td><td class="actions"><button class="btn ghost" data-del-site="${esc(h)}">Remove</button></td></tr>`).join('')}
        </tbody></table>` : '<div class="rows"><div class="empty">No exceptions yet. Set them from the toolbar popup, or add one here.</div></div>'}
        <div class="form-row" style="margin-top:14px">
          <input type="text" id="site-host" placeholder="example.com">
          <select id="site-policy"><option value="block">Block all</option><option value="necessary">Necessary only</option><option value="allow" selected>Allow all</option></select>
          <button class="btn ink" id="site-add">Add</button>
        </div>
      </div>
      <div class="section">
        <div class="head"><h2>Extra necessary cookies</h2></div>
        <p class="muted" style="margin:0 0 12px;max-width:64ch">If a site keeps signing you out, name the cookie it needs. Separate names with commas; <code>*</code> matches anything.</p>
        ${c.rules.length ? `<table class="tbl"><tbody>
          ${c.rules.map((r, i) => `<tr><td>${esc(r.domain)}</td><td class="mono">${esc(r.names)}</td><td class="actions"><button class="btn ghost" data-del-rule="${i}">Remove</button></td></tr>`).join('')}
        </tbody></table>` : ''}
        <div class="form-row" style="margin-top:14px">
          <input type="text" id="rule-domain" placeholder="example.com" style="max-width:240px">
          <input type="text" id="rule-names" placeholder="remember_me, prefs_*">
          <button class="btn ink" id="rule-add">Add</button>
        </div>
      </div>`;
  },

  whitelist() {
    const wl = data.settings.whitelist;
    return `
      <h1>Whitelist</h1>
      <p class="lede">Sites where ad and tracker blocking is off, subdomains included. Cookie protection still applies; set that per site under Cookies.</p>
      <div class="section">
        ${wl.length ? `<table class="tbl"><tbody>${wl.map(h => `<tr><td>${esc(h)}</td><td class="actions"><button class="btn ghost" data-del-wl="${esc(h)}">Remove</button></td></tr>`).join('')}</tbody></table>` : '<div class="rows"><div class="empty">No sites yet.</div></div>'}
        <div class="form-row" style="margin-top:14px">
          <input type="text" id="wl-host" placeholder="example.com">
          <button class="btn ink" id="wl-add">Add site</button>
        </div>
      </div>`;
  },

  filters() {
    return `
      <h1>My filters</h1>
      <p class="lede">Your own rules in Adblock Plus and uBlock Origin syntax. They outrank every list, and your exceptions (<code>@@</code>) win over any list rule.</p>
      <div class="section">
        <textarea class="code" id="custom" spellcheck="false" placeholder="! Examples
||ads.example.com^
example.com##.sidebar-promo
@@||cdn.example.com/player.js$script
example.com##+js(set-constant, adsEnabled, false)">${esc(data.customFilters)}</textarea>
        <div class="form-row" style="margin-top:14px">
          <button class="btn ink" id="custom-save">Apply</button>
          <span class="faint" id="custom-out" style="font-size:13px"></span>
        </div>
      </div>
      <div class="section">
        <div class="head"><h2>Supported syntax</h2></div>
        <p class="muted" style="margin:0;max-width:72ch;font-size:14px">Network: <code>||domain^</code>, <code>|url|</code>, wildcards, <code>/regex/</code>, with <code>$script</code>, <code>image</code>, <code>xhr</code>, <code>frame</code>, <code>media</code>, <code>font</code>, <code>ping</code>, <code>third-party</code>, <code>first-party</code>, <code>domain=</code>, <code>to=</code>, <code>denyallow=</code>, <code>method=</code>, <code>important</code>, <code>match-case</code>, <code>redirect=</code>, <code>removeparam=</code>, <code>document</code>.
        Cosmetic: <code>##</code>, <code>#@#</code>, <code>:has()</code>, <code>:has-text()</code>, <code>:upward()</code>, <code>:matches-path()</code>, <code>:xpath()</code>, <code>:style()</code>, <code>:remove()</code>.
        Scriptlets: <code>set-constant</code>, <code>abort-on-property-read</code>, <code>abort-current-script</code>, <code>json-prune</code>, <code>no-setTimeout-if</code>, <code>no-fetch-if</code>, <code>no-xhr-if</code>, <code>prevent-addEventListener</code>, <code>no-window-open-if</code>, <code>remove-attr</code>, <code>remove-class</code> and more.</p>
      </div>`;
  },

  backup() {
    return `
      <h1>Backup</h1>
      <p class="lede">Settings, per-site choices, whitelist, your lists and your filters in one file. The file stays wherever you save it.</p>
      <div class="section"><div class="rows">
        ${row('Export', 'Save everything as a JSON file.', '<button class="btn ink" id="export">Export</button>')}
        ${row('Import', 'Replace the current settings with a saved file.', '<input type="file" id="import-file" accept="application/json,.json" hidden><button class="btn" id="import">Import</button>')}
        ${row('Reset settings', 'Back to defaults, keeping your filters and lists.', '<button class="btn" id="reset">Reset</button>')}
      </div></div>`;
  },

  about() {
    return `
      <h1>Bulwark</h1>
      <p class="lede">Version ${esc(data.env.version)}, by protowaldganger. Free software under the GNU GPL v3. Built on Manifest V3's native request blocking, with filter compilation modelled on Brave's adblock engine and uBlock Origin Lite.</p>
      <div class="section"><div class="rows">
        ${row('EasyList and EasyPrivacy', 'GPLv3 / CC BY-SA 3.0. The primary ad and tracker lists.', '')}
        ${row('uBlock Origin filters', 'GPLv3. Ads, quick fixes, unbreak and privacy rules.', '')}
        ${row('Brave adblock lists', 'MPL 2.0. Brave Shields fixes and extras.', '')}
        ${row('SponsorBlock', 'CC BY-NC-SA 4.0. Community skip segments, off by default.', '')}
      </div></div>
      <p class="note mono">${esc(data.env.ua)}</p>`;
  }
};

function chart(series, keys) {
  const w = 640, h = 150, pad = 4, max = Math.max(1, ...series);
  const bw = (w - pad * 2) / series.length;
  const bars = series.map((v, i) => {
    const bh = Math.max(2, Math.round((v / max) * (h - 28)));
    return `<rect class="bar${i === series.length - 1 ? ' now' : ''}" x="${(pad + i * bw + 4).toFixed(1)}" y="${h - 20 - bh}" width="${(bw - 8).toFixed(1)}" height="${bh}" rx="4"><title>${keys[i]}: ${fmt.format(v)}</title></rect>`;
  }).join('');
  const labels = keys.map((k, i) => (i % 3 === 1 || i === keys.length - 1 ? `<text class="axis" x="${(pad + i * bw + bw / 2).toFixed(1)}" y="${h - 4}" text-anchor="middle">${i === keys.length - 1 ? 'Today' : k.slice(5).replace('-', '/')}</text>` : '')).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Blocked requests per day">${bars}${labels}</svg>`;
}

// ============================================================== wiring

async function route() {
  const v = (location.hash.slice(1) || 'dashboard');
  const name = VIEWS[v] ? v : 'dashboard';
  for (const a of document.querySelectorAll('.side nav a')) {
    if (a.dataset.v === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  view.innerHTML = VIEWS[name]();
  bind[name] && bind[name]();
}

const on = (sel, ev, fn) => { const el = view.querySelector(sel); if (el) el.addEventListener(ev, fn); };
const onAll = (sel, ev, fn) => view.querySelectorAll(sel).forEach(el => el.addEventListener(ev, fn));
const refresh = async () => { await load(); await route(); };

const bind = {
  dashboard() {
    on('#t-go', 'click', async () => {
      const out = view.querySelector('#t-out');
      try {
        const res = await send({ t: 'test-url', url: view.querySelector('#t-url').value.trim(), initiator: view.querySelector('#t-init').value.trim(), type: view.querySelector('#t-type').value });
        out.innerHTML = res.matched && res.matched.length
          ? res.matched.map(m => `<span class="pill ink">${esc(m.rulesetId)} · rule ${m.ruleId}</span>`).join(' ')
          : 'No rule matches. The request would go through.';
      } catch (e) { out.textContent = e.message; }
    });
    on('#resync', 'click', async () => { toast('Resyncing…'); await send({ t: 'resync' }); await refresh(); toast('Resynced'); });
    on('#reset-stats', 'click', async () => { await send({ t: 'reset-stats' }); await refresh(); toast('Statistics reset'); });
  },
  privacy() {
    on('#strict', 'change', async (e) => {
      await save({ privacy: { strict: e.target.checked } }, e.target.checked ? 'Strict privacy on' : 'Strict privacy off');
      route();
    });
    on('#erase-stats', 'click', async () => { await send({ t: 'reset-stats' }); await refresh(); toast('Statistics erased'); });
  },
  lists() {
    onAll('[data-list]', 'change', async (e) => {
      await save({ lists: { [e.target.dataset.list]: e.target.checked } }, e.target.checked ? 'List on' : 'List off');
      setTimeout(refresh, 600);
    });
    onAll('[data-custom-list]', 'change', async (e) => {
      const id = e.target.dataset.customList;
      await save({ customLists: data.settings.customLists.map(c => (c.id === id ? { ...c, enabled: e.target.checked } : c)) });
    });
    onAll('[data-remove-list]', 'click', async (e) => {
      await send({ t: 'remove-custom-list', id: e.target.dataset.removeList });
      await refresh(); toast('List removed');
    });
    on('#cl-add', 'click', async () => {
      const url = view.querySelector('#cl-url').value.trim();
      const name = view.querySelector('#cl-name').value.trim();
      try { toast('Downloading list…', 6000); await send({ t: 'add-custom-list', url, name }); await refresh(); toast('List added'); }
      catch (e) { toast(e.message, 4000); }
    });
    const runUpdate = async (force) => {
      toast(force ? 'Refreshing every list…' : 'Checking for updates…', 20000);
      try {
        const res = await send({ t: 'update-now', force });
        const updated = res.results.filter(r => r.updated).length, failed = res.results.filter(r => r.error).length;
        await refresh();
        toast(failed ? `${updated} updated, ${failed} failed` : updated ? `${updated} lists updated` : 'Everything is up to date');
      } catch (e) { toast(e.message, 4000); }
    };
    on('#update', 'click', () => runUpdate(false));
    on('#force', 'click', () => runUpdate(true));
    on('#auto', 'change', (e) => save({ update: { auto: e.target.checked } }));
    on('#interval', 'change', (e) => save({ update: { intervalHours: +e.target.value } }));
  },
  youtube() {
    onAll('[data-yt]', 'change', (e) => save({ youtube: { [e.target.dataset.yt]: e.target.checked } }));
    onAll('[data-cat]', 'change', () => {
      const cats = [...view.querySelectorAll('[data-cat]:checked')].map(i => i.dataset.cat);
      save({ youtube: { sbCategories: cats.length ? cats : ['sponsor'] } });
    });
  },
  cookies() {
    const c = () => data.settings.cookies;
    onAll('input[name="ck-def"]', 'change', (e) => save({ cookies: { default: e.target.value } }, 'Default cookie policy updated'));
    on('#ck-3p', 'change', (e) => save({ cookies: { blockThirdParty: e.target.checked } }));
    on('#sweep', 'click', async () => {
      if (!confirm('Remove every stored cookie that the current rules would not keep?')) return;
      const r = await send({ t: 'sweep-all' });
      toast(`${fmt.format(r.removed)} cookies removed`);
    });
    onAll('[data-site]', 'change', async (e) => { await save({ cookies: { sites: { ...c().sites, [e.target.dataset.site]: e.target.value } } }); });
    onAll('[data-del-site]', 'click', async (e) => {
      const sites = { ...c().sites }; delete sites[e.target.dataset.delSite];
      await save({ cookies: { sites } }); route();
    });
    on('#site-add', 'click', async () => {
      const h = normHost(view.querySelector('#site-host').value);
      if (!h) return toast('Enter a domain like example.com');
      await save({ cookies: { sites: { ...c().sites, [h]: view.querySelector('#site-policy').value } } }); route();
    });
    onAll('[data-del-rule]', 'click', async (e) => {
      const rules = c().rules.filter((_, i) => i !== +e.target.dataset.delRule);
      await save({ cookies: { rules } }); route();
    });
    on('#rule-add', 'click', async () => {
      const domain = normHost(view.querySelector('#rule-domain').value);
      const names = view.querySelector('#rule-names').value.trim();
      if (!domain || !names) return toast('Enter a domain and at least one cookie name');
      await save({ cookies: { rules: [...c().rules, { domain, names }] } }); route();
    });
  },
  whitelist() {
    onAll('[data-del-wl]', 'click', async (e) => {
      await save({ whitelist: data.settings.whitelist.filter(h => h !== e.target.dataset.delWl) }, 'Removed'); route();
    });
    const add = async () => {
      const h = normHost(view.querySelector('#wl-host').value);
      if (!h) return toast('Enter a domain like example.com');
      await save({ whitelist: [...data.settings.whitelist, h] }, 'Added'); route();
    };
    on('#wl-add', 'click', add);
    on('#wl-host', 'keydown', (e) => { if (e.key === 'Enter') add(); });
  },
  filters() {
    on('#custom-save', 'click', async () => {
      const out = view.querySelector('#custom-out');
      out.textContent = 'Compiling…';
      try {
        const text = view.querySelector('#custom').value;
        const r = await send({ t: 'save-custom-filters', text });
        data.customFilters = text;
        out.textContent = `${r.network} network, ${r.cosmetic} cosmetic, ${r.scriptlets} scriptlet filters applied` +
          (r.skipped ? `, ${r.skipped} lines skipped` : '') + (r.rejected ? `, ${r.rejected} rejected by the browser` : '') + '. Reload pages to see changes.';
      } catch (e) { out.textContent = e.message; }
    });
  },
  backup() {
    on('#export', 'click', async () => {
      const d = await send({ t: 'export' });
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `bulwark-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    on('#import', 'click', () => view.querySelector('#import-file').click());
    on('#import-file', 'change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const json = JSON.parse(await f.text());
        await send({ t: 'import', data: json });
        await refresh(); toast('Backup imported');
      } catch (err) { toast('Import failed: ' + err.message, 4000); }
    });
    on('#reset', 'click', async () => {
      if (!confirm('Reset all settings to defaults? Your filters and lists are kept.')) return;
      const keep = { customLists: data.settings.customLists };
      const d = await send({ t: 'export' });
      await send({ t: 'import', data: { app: 'bulwark', settings: keep, customFilters: d.customFilters } });
      await refresh(); toast('Settings reset');
    });
  }
};

function normHost(v) {
  let h = String(v || '').trim().toLowerCase();
  try { if (/^https?:\/\//.test(h)) h = new URL(h).hostname; } catch { return ''; }
  h = h.replace(/^www\./, '').replace(/\/.*$/, '');
  return /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(h) ? h : '';
}

document.getElementById('global').addEventListener('change', async (e) => {
  await send({ t: 'set-global', enabled: e.target.checked });
  await refresh();
});
window.addEventListener('hashchange', route);
load().then(route).catch((e) => { view.innerHTML = `<p class="pill warn">${esc(e.message)}</p>`; });
