(function() {
  'use strict';
  const noop = function() {};
  const noopthis = function() { return this; };
  const noopnull = function() { return null; };
  const nooparray = function() { return []; };
  const noopstr = function() { return ''; };
  const companionAdsService = {
    addEventListener: noopthis, enableSyncLoading: noop, setRefreshUnfilledSlots: noop
  };
  const contentService = { addEventListener: noopthis, setContent: noop };
  const PassbackSlot = function() {};
  let p = PassbackSlot.prototype;
  p.display = noop; p.get = noopnull; p.set = noopthis; p.setClickUrl = noopthis;
  p.setTagForChildDirectedTreatment = noopthis; p.setTargeting = noopthis; p.updateTargetingFromMap = noopthis;
  const pubAdsService = {
    addEventListener: noopthis, removeEventListener: noopthis, clear: noop, clearCategoryExclusions: noopthis,
    clearTagForChildDirectedTreatment: noopthis, clearTargeting: noopthis, collapseEmptyDivs: noop,
    defineOutOfPagePassback: function() { return new PassbackSlot(); }, definePassback: function() { return new PassbackSlot(); },
    disableInitialLoad: noop, display: noop, enableAsyncRendering: noop, enableLazyLoad: noop,
    enableSingleRequest: noop, enableSyncRendering: noop, enableVideoAds: noop, get: noopnull,
    getAttributeKeys: nooparray, getTargeting: nooparray, getTargetingKeys: nooparray, getSlots: nooparray,
    isInitialLoadDisabled: function() { return true; }, refresh: noop, set: noopthis, setCategoryExclusion: noopthis,
    setCentering: noop, setCookieOptions: noopthis, setForceSafeFrame: noopthis, setLocation: noopthis,
    setPrivacySettings: noopthis, setPublisherProvidedId: noopthis, setRequestNonPersonalizedAds: noopthis,
    setSafeFrameConfig: noopthis, setTagForChildDirectedTreatment: noopthis, setTargeting: noopthis,
    setVideoContent: noopthis, updateCorrelator: noop
  };
  const SizeMappingBuilder = function() {};
  p = SizeMappingBuilder.prototype;
  p.addSize = noopthis; p.build = noopnull;
  const Slot = function() {};
  p = Slot.prototype;
  p.addService = noopthis; p.clearCategoryExclusions = noopthis; p.clearTargeting = noopthis;
  p.defineSizeMapping = noopthis; p.get = noopnull; p.getAdUnitPath = nooparray; p.getAttributeKeys = nooparray;
  p.getCategoryExclusions = nooparray; p.getDomId = noopstr; p.getResponseInformation = noopnull;
  p.getSlotElementId = noopstr; p.getSlotId = noopthis; p.getTargeting = nooparray; p.getTargetingKeys = nooparray;
  p.set = noopthis; p.setCategoryExclusion = noopthis; p.setClickUrl = noopthis; p.setCollapseEmptyDiv = noopthis;
  p.setTargeting = noopthis; p.updateTargetingFromMap = noopthis;
  const gpt = window.googletag || {};
  const cmd = gpt.cmd || [];
  gpt.apiReady = true;
  gpt.cmd = [];
  gpt.cmd.push = function(a) { try { a(); } catch (e) { /* ignore */ } return 1; };
  gpt.companionAds = function() { return companionAdsService; };
  gpt.content = function() { return contentService; };
  gpt.defineOutOfPageSlot = function() { return new Slot(); };
  gpt.defineSlot = function() { return new Slot(); };
  gpt.destroySlots = noop;
  gpt.disablePublisherConsole = noop;
  gpt.display = noop;
  gpt.enableServices = noop;
  gpt.getVersion = noopstr;
  gpt.pubads = function() { return pubAdsService; };
  gpt.pubadsReady = true;
  gpt.setAdIframeTitle = noop;
  gpt.sizeMapping = function() { return new SizeMappingBuilder(); };
  window.googletag = gpt;
  while (cmd.length !== 0) gpt.cmd.push(cmd.shift());
})();
