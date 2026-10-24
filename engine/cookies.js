// Cookie classification. Shared by the service worker (chrome.cookies
// cleanup) and, through the build step, by the document.cookie shims.
//
// "Necessary only" keeps a cookie when:
//   - its name is not a known tracker, AND
//   - it matches a strictly-necessary pattern (session, auth, CSRF,
//     consent record, cart, load balancer, bot protection, language), OR
//     it is a session cookie (no expiry), OR a user rule allows it.
// Everything else is non-essential and is removed.

export const TRACKER_COOKIE_SOURCE = String.raw`^(?:_ga(?:_.*)?|_gid|_gat.*|__utm[a-z]|_gcl_.*|_gac_.*|_fbp|_fbc|fr|_hj.*|_clck|_clsk|_uet[sv]id|muid|_pin_unauth|_pinterest_.*|_tt_.*|_ttp|tt_webid.*|ajs_.*|amplitude_.*|amp_.*|mp_.*_mixpanel|mixpanel.*|_parsely.*|__qca|_scid.*|_sctr|ide|dsid|test_cookie|__gads|__gpi|__eoi|_rdt_uuid|li_sugr|li_fat_id|bcookie|lidc|anj|uuid2|_dc_gtm_.*|_vwo.*|_vis_opt.*|optimizely.*|_mkto_trk|hubspotutk|__hs.*|_lr_.*|_cs_.*|_tq_id.*|_pk_.*|_ym.*|yandexuid|visitor_info1_live|_an_uid|panoramaid.*|_sp_id.*|_sp_ses.*|s_cc|s_sq|s_vi|s_fid|s_ecid|amcv_.*|amcvs_.*|at_check|mbox|__adroll.*|__ar_v4|_au_.*|_lc2_fpi.*|_pubcid.*|cto_.*|__kla_id|_ketch.*|_chartbeat.*|_cb|_cb_svref|_ttgclid|_scclid|_rdt_cid|_twclid|twclid|_gat_.*|wt3_.*|_hp2_.*|ab\.storage\..*|_dd_s|intercom-id-.*|_delighted.*|_omappvp|_omappvs|_tfpvi|cookieyes-analytics|_mcid|_ce\..*|_conv_.*|__ss_tk|__ss|__ssid|_dpm_.*|demdex|dextp|_fw_crm_v|_zitok|_gd.*)$`;

export const NECESSARY_COOKIE_SOURCE = String.raw`^(?:__host-.*|__secure-.*|.*sess(?:ion)?(?:id|_?id|_?key|_?token)?|.*[_.-]sid|sid|ssid|hsid|apisid|sapisid|.*csrf.*|.*xsrf.*|.*_token|token|.*auth.*|.*login.*|logged_in|.*remember.*|.*consent.*|.*gdpr.*|euconsent.*|socs|optanon.*|cookielawinfo.*|cookieyes-consent|cc_cookie|cookiebot.*|cmp.*|.*cart.*|.*basket.*|.*checkout.*|currency|lang|language|locale|.*_locale|jsessionid|phpsessid|asp\.net_sessionid|\.aspxauth.*|aspxauth.*|cfid|cftoken|laravel_session|connect\.sid|ci_session|wordpress_.*|wp-settings.*|cf_clearance|__cf_bm|__cfruid|_cfuvid|cf_ob_info|cf_use_ob|__ddg.*|ak_bmsc|bm_.*|_abck|incap_.*|visid_incap_.*|nlbi_.*|awsalb.*|awselb.*|arraffinity.*|route|server.*|x-ms-.*|ests.*|buid|fpc|stsservicecookie|msfpc|login_info|ysc|nid|aec|ak_.*|datadome|captcha.*|.*recaptcha.*|__stripe_.*|_shopify_s|_shopify_y|secure_customer_sig|cart_sig|_secure_session_id|xs|c_user|datr|sb|auth_token|ct0|twid|li_at|liap|jsessionid|reddit_session|token_v2|session-id|session-token|ubid-.*|at-main|sess-at-.*|x-main|myacinfo|dslang|user_session|_gh_sess|dotcom_user|has_recent_activity|.*_csrf_token|tfa.*|mfa.*|2fa.*|sidcc|lsid|account_chooser|otz|smsv|visitor_privacy_metadata|msp.*|uaid|wlssc|signinstatecookie|pplstate|mscc|aasp|dssid2|dssf|x-apple-.*|i18n-prefs)$`;

export const TRACKER_COOKIE_RE = new RegExp(TRACKER_COOKIE_SOURCE, 'i');
export const NECESSARY_COOKIE_RE = new RegExp(NECESSARY_COOKIE_SOURCE, 'i');

// Sign-in cookies with names too generic to allow everywhere, keyed by
// the site that sets them.
export const SITE_NECESSARY = {
  'slack.com': ['d', 'd-s', 'b', 'lc', 'x'],
  'facebook.com': ['c_user', 'xs', 'datr', 'sb', 'presence', 'wd'],
  'instagram.com': ['ds_user_id', 'mid', 'ig_did', 'rur'],
  'x.com': ['kdt', 'att', 'guest_id'],
  'twitter.com': ['kdt', 'att', 'guest_id'],
  'linkedin.com': ['li_rm', 'bscookie', 'li_mc'],
  'discord.com': ['__dcfduid', '__sdcfduid'],
  'notion.so': ['notion_user_id', 'notion_browser_id', 'notion_users'],
  'figma.com': ['figma.st', 'figma.session'],
  'netflix.com': ['netflixid', 'securenetflixid', 'nfvdid', 'flwssn'],
  'spotify.com': ['sp_dc', 'sp_key', 'sp_t'],
  'reddit.com': ['loid', 'edgebucket', 'csv'],
  'atlassian.net': ['tenant.session.token'],
  'zoom.us': ['_zm_ssid', '_zm_cluster', '_zm_page_auth']
};

function siteAllows(domain, name) {
  if (!domain) return false;
  const lower = name.toLowerCase();
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const list = SITE_NECESSARY[labels.slice(i).join('.')];
    if (list && list.includes(lower)) return true;
  }
  return false;
}

export function isTrackerCookie(name) {
  return TRACKER_COOKIE_RE.test(name);
}

/**
 * @param {{name:string, session?:boolean}} cookie
 * @param {'block'|'necessary'|'allow'} policy
 * @param {(name:string)=>boolean} [userAllow] per-site user rule
 * @param {string} [domain] cookie domain, for site-specific sign-in cookies
 * @returns {boolean} true when the cookie should be kept
 */
export function keepCookie(cookie, policy, userAllow, domain) {
  if (policy === 'allow') return !isTrackerCookie(cookie.name);
  if (policy === 'block') return false;
  if (userAllow && userAllow(cookie.name)) return true;
  if (siteAllows(domain, cookie.name)) return true;
  if (isTrackerCookie(cookie.name)) return false;
  if (NECESSARY_COOKIE_RE.test(cookie.name)) return true;
  return cookie.session === true;
}

// Domains that only ever set tracking cookies when embedded. Their cookies
// are stripped on every third-party request regardless of site policy.
export const TRACKER_COOKIE_DOMAINS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'googletagmanager.com', 'facebook.net', 'connect.facebook.net', 'scorecardresearch.com',
  'quantserve.com', 'adnxs.com', 'criteo.com', 'criteo.net', 'rubiconproject.com', 'pubmatic.com',
  'openx.net', 'casalemedia.com', 'taboola.com', 'outbrain.com', 'amazon-adsystem.com',
  'adsrvr.org', 'bidswitch.net', 'demdex.net', 'everesttech.net', 'rlcdn.com', 'bluekai.com',
  'krxd.net', 'mathtag.com', 'agkn.com', 'adform.net', 'smartadserver.com', 'yieldmo.com',
  'sharethrough.com', 'teads.tv', '3lift.com', 'tapad.com', 'crwdcntrl.net', 'exelator.com',
  'turn.com', 'contextweb.com', 'lijit.com', 'sovrn.com', 'media.net', 'zemanta.com',
  'hotjar.com', 'mixpanel.com', 'segment.io', 'segment.com', 'amplitude.com', 'fullstory.com',
  'clarity.ms', 'bat.bing.com', 'ads.linkedin.com', 'px.ads.linkedin.com', 'analytics.tiktok.com',
  'ads-twitter.com', 'analytics.twitter.com', 't.co', 'pinterest.com', 'ct.pinterest.com',
  'snapchat.com', 'tr.snapchat.com', 'yandex.ru', 'mc.yandex.ru', 'adroll.com', 'quantcount.com',
  'moatads.com', 'doubleverify.com', 'adsafeprotected.com', 'chartbeat.com', 'newrelic.com', 'nr-data.net'
];

// Groups of domains run by the same entity. Cookies flow freely inside a
// group (for example youtube.com and google.com) so sign-in keeps working,
// the same compromise Brave makes.
export const ENTITY_GROUPS = [
  ['google.com', 'youtube.com', 'googlevideo.com', 'ytimg.com', 'ggpht.com', 'gstatic.com', 'googleapis.com', 'googleusercontent.com', 'youtube-nocookie.com', 'google.se', 'google.co.uk', 'google.de', 'google.fr', 'withgoogle.com', 'blogger.com', 'gmail.com'],
  ['microsoft.com', 'microsoftonline.com', 'live.com', 'office.com', 'office.net', 'sharepoint.com', 'outlook.com', 'msauth.net', 'msftauth.net', 'bing.com', 'skype.com', 'xbox.com', 'azure.com', 'windows.net', 'onedrive.com', 'msn.com', 'teams.microsoft.com'],
  ['apple.com', 'icloud.com', 'apple-cloudkit.com', 'cdn-apple.com', 'mzstatic.com'],
  ['github.com', 'githubusercontent.com', 'githubassets.com', 'github.io'],
  ['atlassian.com', 'atlassian.net', 'jira.com', 'bitbucket.org', 'trello.com'],
  ['amazon.com', 'amazon.se', 'amazon.de', 'amazon.co.uk', 'media-amazon.com', 'ssl-images-amazon.com', 'amazonaws.com', 'primevideo.com', 'twitch.tv'],
  ['figma.com', 'figmausercontent.com'],
  ['slack.com', 'slack-edge.com', 'slack-imgs.com'],
  ['spotify.com', 'scdn.co', 'spotifycdn.com'],
  ['stripe.com', 'stripe.network', 'stripecdn.com']
];
