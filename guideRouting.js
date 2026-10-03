(function(root, factory){
  'use strict';
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.GrowellGuideRouting = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  function text(value){ return typeof value === 'string' ? value : ''; }

  // Use device signals, never viewport width: a resized desktop or touch-enabled
  // Windows laptop should still receive the PC guide. Nothing is stored or sent.
  function isMobileDevice(navigatorLike){
    var nav = navigatorLike || {};
    var ua = text(nav.userAgent);
    var platform = text(nav.platform);
    var data = nav.userAgentData || {};
    var dataPlatform = text(data.platform);
    if(/Windows/i.test(ua) || /^Win/i.test(platform) || /^Windows$/i.test(dataPlatform)) return false;
    if(/Android|iPhone|iPad|iPod/i.test(ua) || /^(Android|iOS)$/i.test(dataPlatform)) return true;
    // iPadOS can identify itself as a Mac when requesting desktop websites.
    if((/Macintosh/i.test(ua) || /^Mac/i.test(platform)) && Number(nav.maxTouchPoints) > 1) return true;
    if(/Macintosh|X11|Linux/i.test(ua) || /^(Mac|Linux)/i.test(platform) || /^(macOS|Linux|Chrome OS)$/i.test(dataPlatform)) return false;
    return data.mobile === true || /Mobile|Tablet|IEMobile|Opera Mini/i.test(ua);
  }

  function target(navigatorLike){
    return isMobileDevice(navigatorLike)
      ? { href: '/guide.html', label: '모바일 사용 가이드' }
      : { href: '/guide-pc.html', label: 'PC 사용 가이드' };
  }

  // Returns whether navigation occurred. Replacing the wrong guide avoids a
  // back-button loop, while file previews and unrelated pages remain untouched.
  function redirect(locationLike, navigatorLike){
    var location = locationLike || {};
    if(!/^https?:$/.test(text(location.protocol)) || typeof location.replace !== 'function') return false;
    var pathname = text(location.pathname);
    if(pathname !== '/guide.html' && pathname !== '/guide-pc.html') return false;
    var destination = target(navigatorLike).href;
    if(pathname === destination) return false;
    location.replace(destination + text(location.search) + text(location.hash));
    return true;
  }

  return { isMobileDevice: isMobileDevice, target: target, redirect: redirect };
});
