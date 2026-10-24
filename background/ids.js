// Dynamic rule id ranges, shared by rules.js and stats.js.
export const ID = {
  whitelist: 1,
  pause: 2,
  cookieTrackers: 10,
  cookieThirdParty: 11,
  cookieEntityBase: 20,     // 20..49
  cookieBlockSites: 50,
  customBase: 1000,         // 1000..99999
  listBase: 100000          // 100000 + listIndex * 100000 + n
};

// Bumped whenever dynamic rules change, so caches can refresh lazily.
export const dynamicState = { version: 0 };
