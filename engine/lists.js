// Filter list catalog. Shared by the build tool (Node) and the service worker.
// Every list is fetched from a single host (raw.githubusercontent.com), so
// list updates reveal nothing to the list maintainers' own servers.
// `trusted` lists may use trusted scriptlets (uBlock Origin's and Brave's
// own lists, as in uBlock Origin).
// `strict` lists name dangerous sites: a listed host is blocked as a page
// too, with Bulwark's warning page. `hostsOnly` keeps whole hosts and drops
// single addresses (URLhaus lists over 100,000 of those).
// `bundled` lists are compiled into static DNR rulesets at build time and
// receive incremental updates at runtime (disabled static rules + dynamic
// additions). Non-bundled lists are fetched and applied entirely at runtime.

export const UBO = 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/';
export const EASYLIST_GH = 'https://raw.githubusercontent.com/easylist/easylist/gh-pages/';
export const BRAVE_GH = 'https://raw.githubusercontent.com/brave/adblock-lists/master/';
export const UBO_3P = 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/thirdparties/';

export const LISTS = [
  {
    id: 'easylist', name: 'EasyList', group: 'Ads', bundled: true, enabledByDefault: true,
    description: 'The primary ad filter list, shared by Brave, uBlock Origin and Adblock Plus.',
    urls: [EASYLIST_GH + 'easylist.txt'],
    home: 'https://easylist.to/'
  },
  {
    id: 'easyprivacy', name: 'EasyPrivacy', group: 'Privacy', bundled: true, enabledByDefault: true,
    description: 'Blocks trackers, analytics beacons and fingerprinting scripts.',
    urls: [EASYLIST_GH + 'easyprivacy.txt'],
    home: 'https://easylist.to/'
  },
  {
    id: 'ubo-filters', trusted: true, name: 'uBlock filters: Ads', group: 'Ads', bundled: true, enabledByDefault: true,
    description: 'Aggressive ad, anti-adblock and video ad rules from the uBlock Origin team.',
    urls: [UBO + 'filters.txt'],
    home: 'https://github.com/uBlockOrigin/uAssets'
  },
  {
    id: 'ubo-quick-fixes', trusted: true, name: 'uBlock filters: Quick fixes', group: 'Ads', bundled: true, enabledByDefault: true,
    description: 'Fast-moving fixes, including YouTube cosmetic and network rules. Updated several times a day.',
    urls: [UBO + 'quick-fixes.txt'],
    home: 'https://github.com/uBlockOrigin/uAssets'
  },
  {
    id: 'ubo-unbreak', trusted: true, name: 'uBlock filters: Unbreak', group: 'Unbreak', bundled: true, enabledByDefault: true,
    description: 'Exceptions that fix sites broken by other lists.',
    urls: [UBO + 'unbreak.txt'],
    home: 'https://github.com/uBlockOrigin/uAssets'
  },
  {
    id: 'ubo-privacy', trusted: true, name: 'uBlock filters: Privacy', group: 'Privacy', bundled: true, enabledByDefault: true,
    description: 'Tracking parameter removal and extra privacy rules.',
    urls: [UBO + 'privacy.txt'],
    home: 'https://github.com/uBlockOrigin/uAssets'
  },
  {
    id: 'brave-unbreak', trusted: true, name: 'Brave Unbreak', group: 'Unbreak', bundled: true, enabledByDefault: true,
    description: 'Brave Shields site fixes.',
    urls: [BRAVE_GH + 'brave-unbreak.txt'],
    home: 'https://github.com/brave/adblock-lists'
  },
  {
    id: 'brave-specific', trusted: true, name: 'Brave Specific', group: 'Privacy', bundled: true, enabledByDefault: true,
    description: 'Brave Shields extras, such as blocking third-party requests to localhost.',
    urls: [BRAVE_GH + 'brave-lists/brave-specific.txt'],
    home: 'https://github.com/brave/adblock-lists'
  },
  {
    id: 'ubo-badware', trusted: true, strict: true, name: 'uBlock filters: Badware risks', group: 'Security', bundled: true, enabledByDefault: true,
    description: 'Sites known to push scams, fake downloads, tech-support fraud and bundled adware. Opening one shows a warning first.',
    urls: [UBO + 'badware.txt'],
    home: 'https://github.com/uBlockOrigin/uAssets'
  },
  {
    id: 'urlhaus', strict: true, hostsOnly: true, name: 'Malicious URL Blocklist (URLhaus)', group: 'Security', bundled: true, enabledByDefault: true,
    description: 'Hosts that spread malware, from abuse.ch\'s URLhaus, updated twice a day. Opening one shows a warning first.',
    urls: [UBO_3P + 'urlhaus-filter/urlhaus-filter-online.txt'],
    home: 'https://gitlab.com/malware-filter/urlhaus-filter'
  },
  {
    id: 'ubo-resource-abuse', trusted: true, name: 'uBlock filters: Resource abuse', group: 'Security', bundled: true, enabledByDefault: true,
    description: 'Cryptocurrency miners and other scripts that use your computer\'s power without asking.',
    urls: [UBO + 'resource-abuse.txt'],
    home: 'https://github.com/uBlockOrigin/uAssets'
  },
  {
    id: 'peter-lowe', name: "Peter Lowe's Ad and tracking server list", group: 'Ads', bundled: true, enabledByDefault: true,
    description: 'A small, carefully kept list of ad and tracking servers, used by uBlock Origin by default.',
    urls: [UBO_3P + 'pgl.yoyo.org/as/serverlist'],
    home: 'https://pgl.yoyo.org/adservers/'
  },
  {
    id: 'cookie-notices', trusted: true, name: 'uBlock filters: Cookie notices', group: 'Annoyances', bundled: true, enabledByDefault: false,
    description: 'Answers cookie banners with "reject" or "necessary only" where it can, and hides the rest along with the overlays that stop scrolling. The consent cookie it sets is kept so the banner stays away.',
    urls: [UBO + 'annoyances-cookies.txt'],
    home: 'https://github.com/uBlockOrigin/uAssets'
  },
  {
    id: 'ubo-annoyances', trusted: true, name: 'uBlock filters: Annoyances', group: 'Annoyances', bundled: true, enabledByDefault: false,
    description: 'Hides newsletter pop-ups, "allow notifications" prompts, app banners and other nags. Can occasionally hide something you wanted.',
    urls: [UBO + 'annoyances-others.txt'],
    home: 'https://github.com/uBlockOrigin/uAssets'
  },
  {
    id: 'fanboy-social', name: 'EasyList Social', group: 'Annoyances', bundled: true, enabledByDefault: false,
    description: 'Hides social media share buttons, like boxes and embedded social widgets.',
    urls: [EASYLIST_GH + 'fanboy-social.txt'],
    home: 'https://easylist.to/'
  },
  {
    id: 'adguard-url-tracking', name: 'AdGuard URL Tracking Protection', group: 'Privacy', bundled: true, enabledByDefault: false,
    description: 'Removes thousands of tracking parameters (utm_, fbclid and the like) from web addresses. Rarely, a link that relies on one stops working.',
    urls: ['https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_17_TrackParam/filter.txt'],
    home: 'https://github.com/AdguardTeam/AdguardFilters'
  },
  {
    id: 'frellwit-swedish', name: "Frellwit's Swedish Filter", group: 'Regional', bundled: true, enabledByDefault: false,
    description: 'Ads, tracking and annoyances on Swedish sites that the international lists miss.',
    urls: ['https://raw.githubusercontent.com/lassekongo83/Frellwits-filter-lists/master/Frellwits-Swedish-Filter.txt'],
    home: 'https://github.com/lassekongo83/Frellwits-filter-lists'
  }
];

// The hand-written YouTube ruleset ships with the extension and is not a list.
export const YT_RULESET = 'bulwark-youtube';

export function listById(id) {
  return LISTS.find(l => l.id === id) || null;
}
