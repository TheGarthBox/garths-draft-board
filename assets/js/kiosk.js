/* ============================================================
   Garth's Brew Bar — Kiosk helper (v1)

   Fixes two Fire TV / Silk problems that the board itself can't:

   1. THE PAGE SCROLLS AND SILK'S URL BAR STAYS VISIBLE.
      Silk reserves space for its own chrome, so a `height: 100vh`
      page is taller than the visible area — hence the scrollbar,
      and hence the nav bar only hiding once you scroll. We measure
      the real visible height and pin the board to exactly that, so
      there is nothing to scroll in the first place.

   2. THE SCREENSAVER STILL KICKS IN.
      Fire OS treats a static web page as an idle device. The Screen
      Wake Lock API tells the OS the screen is in use. It must be
      requested from a user gesture and re-requested whenever the
      page is backgrounded and returns.

   Both need a single button press on the remote to arm, because
   browsers require a user gesture for fullscreen and wake lock.
   That's what the "Press OK" overlay is for. Press it once per
   power cycle and the board runs clean until the stick reboots.
   ============================================================ */

(function () {
  'use strict';

  var wakeLock = null;

  /* ---------- 1. Kill the scroll ---------- */
  function fitViewport() {
    // window.innerHeight is the *visible* height, excluding Silk chrome.
    document.documentElement.style.setProperty('--gbb-vh', window.innerHeight + 'px');
  }
  fitViewport();
  window.addEventListener('resize', fitViewport);
  window.addEventListener('orientationchange', fitViewport);
  // Silk animates its chrome away; re-measure a few times after load.
  [250, 750, 1500, 3000].forEach(function (ms) { setTimeout(fitViewport, ms); });

  /* ---------- 2. Wake lock ---------- */
  function requestWakeLock() {
    if (!('wakeLock' in navigator)) return Promise.resolve(false);
    return navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
      return true;
    }).catch(function () { return false; });
  }

  // Re-acquire after the screen or tab comes back.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && wakeLock === null) requestWakeLock();
  });

  /* ---------- 3. Fullscreen ---------- */
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function goFullscreen() {
    var el = document.documentElement;
    var fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!fn) return Promise.resolve(false);
    try {
      var p = fn.call(el, { navigationUI: 'hide' });
      return (p && p.then) ? p.then(function () { return true; }, function () { return false; })
                           : Promise.resolve(true);
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  /* ---------- 4. The one-press overlay ---------- */
  var overlay = document.createElement('div');
  overlay.className = 'gbb-kiosk-prompt';
  overlay.setAttribute('role', 'button');
  overlay.setAttribute('tabindex', '0');
  overlay.innerHTML =
    '<div class="gbb-kiosk-inner">' +
      '<div class="gbb-kiosk-head">Press OK on the remote</div>' +
      '<div class="gbb-kiosk-sub">Goes full screen and keeps the display awake</div>' +
    '</div>';

  function arm() {
    Promise.all([goFullscreen(), requestWakeLock()]).then(function (r) {
      fitViewport();
      setTimeout(fitViewport, 500);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (window.console && console.log) {
        console.log('[gbb-kiosk] fullscreen=' + r[0] + ' wakeLock=' + r[1]);
      }
    });
  }

  overlay.addEventListener('click', arm);
  overlay.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ' || e.keyCode === 13 || e.keyCode === 32) arm();
  });
  // Any keypress anywhere also arms it — the Fire TV remote's OK button
  // usually lands as a click, but D-pad centre can arrive as a keydown.
  document.addEventListener('keydown', function (e) {
    if (!isFullscreen() && (e.keyCode === 13 || e.key === 'Enter')) arm();
  });

  function mount() {
    if (isFullscreen()) return;
    document.body.appendChild(overlay);
    try { overlay.focus(); } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  document.addEventListener('fullscreenchange', function () {
    if (!isFullscreen()) mount(); else if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    fitViewport();
  });

  /* ---------- Expose for debugging ---------- */
  window.GBBKiosk = {
    arm: arm,
    status: function () {
      return {
        fullscreen: isFullscreen(),
        wakeLockSupported: 'wakeLock' in navigator,
        wakeLockActive: wakeLock !== null,
        visibleHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        scrollable: document.documentElement.scrollHeight > window.innerHeight + 2
      };
    }
  };
})();
