// Dynamic rule id ranges, shared by rules.js and stats.js.
export const ID = {
  whitelist: 1,
  pause: 2,
  // 3 and 4: retired (YouTube watch-page address rewrite). Left unused so
  // the cleanup of old dynamic rules (ids below customBase) removes them.
  gpc: 5,                   // Sec-GPC: 1 on every request
  strictAllow: 6,           // sites the user chose to open despite a warning
  siteSwitchBase: 60,       // 60..69: per-site switches (fonts, media, JavaScript)
  skipBypassBase: 5000,     // session rules: 5000..5999, one per tab
  proceedBase: 6000,        // session rules: 6000..6999, "open anyway" per tab
  cookieTrackers: 10,
  cookieThirdParty: 11,
  cookieEntityBase: 20,     // 20..49
  cookieBlockSites: 50,
  customBase: 1000,         // 1000..99999
  listBase: 100000          // 100000 + listIndex * 100000 + n
};

// Bumped whenever dynamic rules change, so caches can refresh lazily.
export const dynamicState = { version: 0 };
