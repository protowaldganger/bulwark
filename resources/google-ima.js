// Minimal Google IMA SDK (ima3.js) surrogate. Every ad request fails
// immediately with a "no ads" error, which IMA-based players handle by
// starting content playback.
(function() {
  'use strict';
  if (window.google && window.google.ima && window.google.ima.VERSION) return;
  const noop = function() {};
  class EventTarget_ {
    constructor() { this._l = new Map(); }
    addEventListener(types, fn) {
      for (const t of [].concat(types)) { if (!this._l.has(t)) this._l.set(t, new Set()); this._l.get(t).add(fn); }
    }
    removeEventListener(types, fn) { for (const t of [].concat(types)) this._l.get(t)?.delete(fn); }
    _emit(type, ev) { for (const fn of this._l.get(type) || []) { try { fn(ev); } catch (e) { setTimeout(() => { throw e; }); } } }
  }
  const AdError = function(code, msg) { this.code = code; this.msg = msg; };
  AdError.prototype.getErrorCode = function() { return this.code; };
  AdError.prototype.getVastErrorCode = function() { return this.code; };
  AdError.prototype.getMessage = function() { return this.msg; };
  AdError.prototype.getType = function() { return 'adLoadError'; };
  AdError.prototype.getInnerError = function() { return null; };
  AdError.prototype.toString = function() { return 'AdError ' + this.code + ': ' + this.msg; };
  AdError.ErrorCode = { VAST_NO_ADS_AFTER_WRAPPER: 303, UNKNOWN_ERROR: 900, VAST_EMPTY_RESPONSE: 1009 };
  AdError.Type = { AD_LOAD: 'adLoadError', AD_PLAY: 'adPlayError' };
  const AdErrorEvent = function(err, ctx) { this.error = err; this.ctx = ctx; this.type = 'adError'; };
  AdErrorEvent.prototype.getError = function() { return this.error; };
  AdErrorEvent.prototype.getUserRequestContext = function() { return this.ctx || {}; };
  AdErrorEvent.Type = { AD_ERROR: 'adError' };
  const AdEvent = function(type) { this.type = type; };
  AdEvent.prototype.getAd = function() { return null; };
  AdEvent.prototype.getAdData = function() { return {}; };
  AdEvent.Type = {
    ALL_ADS_COMPLETED: 'allAdsCompleted', CLICK: 'click', COMPLETE: 'complete', CONTENT_PAUSE_REQUESTED: 'contentPauseRequested',
    CONTENT_RESUME_REQUESTED: 'contentResumeRequested', LOADED: 'loaded', PAUSED: 'pause', RESUMED: 'resume', SKIPPED: 'skip',
    STARTED: 'start', USER_CLOSE: 'userClose', AD_BREAK_READY: 'adBreakReady', AD_PROGRESS: 'adProgress', LOG: 'log'
  };
  class AdsManager extends EventTarget_ {
    init() {} start() {} stop() {} skip() {} pause() {} resume() {} destroy() {} resize() {} discardAdBreak() {} updateAdsRenderingSettings() {}
    collapse() {} expand() {} focus() {} configureAdsManager() {} clicked() {}
    getAdSkippableState() { return false; } getCuePoints() { return []; } getRemainingTime() { return 0; }
    getVolume() { return 1; } setVolume() {} isCustomClickTrackingUsed() { return false; } isCustomPlaybackUsed() { return false; }
  }
  class AdsLoader extends EventTarget_ {
    constructor() { super(); this._settings = new ImaSdkSettings(); }
    contentComplete() {} destroy() {} getSettings() { return this._settings; }
    requestAds(req, ctx) {
      setTimeout(() => {
        this._emit('adError', new AdErrorEvent(new AdError(1009, 'The VAST response document is empty.'), ctx));
      }, 0);
    }
  }
  class ImaSdkSettings {
    getCompanionBackfill() { return 'always'; } getDisableCustomPlaybackForIOS10Plus() { return false; }
    getFeatureFlags() { return {}; } getLocale() { return 'en'; } getNumRedirects() { return 4; }
    getPlayerType() { return ''; } getPlayerVersion() { return ''; } getPpid() { return ''; } isCookiesEnabled() { return false; }
    setAutoPlayAdBreaks() {} setCompanionBackfill() {} setCookiesEnabled() {} setDisableCustomPlaybackForIOS10Plus() {}
    setFeatureFlags() {} setLocale() {} setNumRedirects() {} setPlayerType() {} setPlayerVersion() {} setPpid() {}
    setSessionId() {} setVpaidAllowed() {} setVpaidMode() {}
  }
  ImaSdkSettings.CompanionBackfillMode = { ALWAYS: 'always', ON_MASTER_AD: 'on_master_ad' };
  ImaSdkSettings.VpaidMode = { DISABLED: 0, ENABLED: 1, INSECURE: 2 };
  const AdDisplayContainer = function() {};
  AdDisplayContainer.prototype.initialize = noop;
  AdDisplayContainer.prototype.destroy = noop;
  const AdsRequest = function() {};
  AdsRequest.prototype.setAdWillAutoPlay = noop;
  AdsRequest.prototype.setAdWillPlayMuted = noop;
  AdsRequest.prototype.setContinuousPlayback = noop;
  const AdsRenderingSettings = function() {};
  const AdsManagerLoadedEvent = function() { this.type = 'adsManagerLoaded'; };
  AdsManagerLoadedEvent.prototype.getAdsManager = function() { return new AdsManager(); };
  AdsManagerLoadedEvent.prototype.getUserRequestContext = function() { return {}; };
  AdsManagerLoadedEvent.Type = { ADS_MANAGER_LOADED: 'adsManagerLoaded' };
  const ima = {
    AdDisplayContainer, AdError, AdErrorEvent, AdEvent, AdsLoader, AdsManagerLoadedEvent, AdsRenderingSettings, AdsRequest,
    ImaSdkSettings, settings: new ImaSdkSettings(), VERSION: '3.517.2',
    ViewMode: { FULLSCREEN: 'fullscreen', NORMAL: 'normal' },
    UiElements: { AD_ATTRIBUTION: 'adAttribution', COUNTDOWN: 'countdown' },
    CompanionAdSelectionSettings: function() {},
    OmidAccessMode: { DOMAIN: 'domain', FULL: 'full', LIMITED: 'limited' },
    OmidVerificationVendor: {}
  };
  ima.CompanionAdSelectionSettings.CreativeType = { ALL: 'All', FLASH: 'Flash', IMAGE: 'Image' };
  ima.CompanionAdSelectionSettings.ResourceType = { ALL: 'All', HTML: 'Html', IFRAME: 'IFrame', STATIC: 'Static' };
  ima.CompanionAdSelectionSettings.SizeCriteria = { IGNORE: 'IgnoreSize', SELECT_EXACT_MATCH: 'SelectExactMatch', SELECT_NEAR_MATCH: 'SelectNearMatch' };
  window.google = window.google || {};
  window.google.ima = ima;
})();
