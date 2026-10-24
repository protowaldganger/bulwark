// Filter list catalog. Shared by the build tool (Node) and the service worker.
// Every list is fetched from a single host (raw.githubusercontent.com), so
// list updates reveal nothing to the list maintainers' own servers.
// `bundled` lists are compiled into static DNR rulesets at build time and
// receive incremental updates at runtime (disabled static rules + dynamic
// additions). Non-bundled lists are fetched and applied entirely at runtime.

export const UBO = 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/';
export const EASYLIST_GH = 'https://raw.githubusercontent.com/easylist/easylist/gh-pages/';
export const BRAVE_GH = 'https://raw.githubusercontent.com/brave/adblock-lists/master/';

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
    id: 'ubo-filters', name: 'uBlock filters: Ads', group: 'Ads', bundled: true, enabledByDefault: true,
    description: 'Aggressive ad, anti-adblock and video ad rules from the uBlock Origin team.',
    urls: [UBO + 'filters.txt'],
    home: 'https://github.com/uBlockOrigin/uAssets'
  },
  {
    id: 'ubo-quick-fixes', name: 'uBlock filters: Quick fixes', group: 'Ads', bundled: true, enabledByDefault: true,
    description: 'Fast-moving fixes, including YouTube cosmetic and network rules. Updated several times a day.',
    urls: [UBO + 'quick-fixes.txt'],
    home: 'https://github.com/uBlockOrigin/uAssets'
  },
  {
    id: 'ubo-unbreak', name: 'uBlock filters: Unbreak', group: 'Unbreak', bundled: true, enabledByDefault: true,
    description: 'Exceptions that fix sites broken by other lists.',
    urls: [UBO + 'unbreak.txt'],
    home: 'https://github.com/uBlockOrigin/uAssets'
  },
  {
    id: 'ubo-privacy', name: 'uBlock filters: Privacy', group: 'Privacy', bundled: true, enabledByDefault: true,
    description: 'Tracking parameter removal and extra privacy rules.',
    urls: [UBO + 'privacy.txt'],
    home: 'https://github.com/uBlockOrigin/uAssets'
  },
  {
    id: 'brave-unbreak', name: 'Brave Unbreak', group: 'Unbreak', bundled: true, enabledByDefault: true,
    description: 'Brave Shields site fixes.',
    urls: [BRAVE_GH + 'brave-unbreak.txt'],
    home: 'https://github.com/brave/adblock-lists'
  },
  {
    id: 'brave-specific', name: 'Brave Specific', group: 'Privacy', bundled: true, enabledByDefault: true,
    description: 'Brave Shields extras, such as blocking third-party requests to localhost.',
    urls: [BRAVE_GH + 'brave-lists/brave-specific.txt'],
    home: 'https://github.com/brave/adblock-lists'
  },
  {
    id: 'cookie-notices', name: 'uBlock filters: Cookie notices', group: 'Annoyances', bundled: false, enabledByDefault: false,
    description: 'Hides cookie consent banners. Cookies themselves are handled by Cookie control.',
    urls: [UBO + 'annoyances-cookies.txt'],
    home: 'https://github.com/uBlockOrigin/uAssets'
  },
  {
    id: 'ubo-annoyances', name: 'uBlock filters: Annoyances', group: 'Annoyances', bundled: false, enabledByDefault: false,
    description: 'Hides popups, newsletter nags and other annoyances.',
    urls: [UBO + 'annoyances-others.txt'],
    home: 'https://github.com/uBlockOrigin/uAssets'
  }
];

// The hand-written YouTube ruleset ships with the extension and is not a list.
export const YT_RULESET = 'bulwark-youtube';

export function listById(id) {
  return LISTS.find(l => l.id === id) || null;
}
