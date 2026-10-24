/* ============================================================
   Garth's Brew Bar — Draft Board · watchdog (v1.8)

   THE PROBLEM THIS SOLVES

   board.js asks the sheet for new data on a timer. That works —
   until it stops asking.

   Fire OS suspends an idle tab and freezes its JavaScript
   timers. Bar wifi drops. When either happens the polling loop
   simply stops, and because the board already has 18 rows drawn
   it goes on looking perfectly correct. No error, no blank
   screen, nothing to notice from across the room. The menu is
   just quietly wrong, possibly for days.

   That is the worst kind of failure for something hanging on a
   wall: it fails silently, and it fails looking fine.

   WHAT THIS DOES

   Watches the clock rather than the data. If board.js hasn't had
   a SUCCESSFUL fetch in five minutes, something has stopped, and
   the page reloads itself. It also reacts to the moments a
   frozen page wakes up — tab becoming visible, network coming
   back — and asks for fresh data immediately.

   THE ONE RULE IT WON'T BREAK

   Never replace a readable board with a browser error page.
   On silence it first fetches the sheet to confirm the network
   is genuinely back. Only then does it reload. Still offline, it
   leaves the stale menu up: out-of-date beer is bad, 'No
   internet connection' above the bar is worse.
   ============================================================ */

(function () {
  'use strict';

  var MAX_SILENCE_MS = 5 * 60 * 1000;
  var CHECK_EVERY_MS = 20 * 1000;
  var NIGHTLY_RELOAD_HOUR = 4;

  var reloading = false;

  function lastSuccessMs() {
    try {
      if (!window.GBB || !window.GBB.getLastSuccessAt) return null;
      var t = window.GBB.getLastSuccessAt();
      if (!t) return null;
      return (t instanceof Date) ? t.getTime() : new Date(t).getTime();
    } catch (e) {
      return null;
    }
  }

  function silenceMs() {
    var t = lastSuccessMs();
    return (t === null) ? null : (Date.now() - t);
  }

  function showStale(on) {
    var dot = document.getElementById('gbb-stale-dot');
    if (dot) dot.hidden = !on;
  }

  function reload(reason) {
    if (reloading) return;
    reloading = true;
    if (window.console && console.log) console.log('[gbb-watchdog] reloading: ' + reason);
    /* Cache-bust: Silk holds the HTML for ten minutes and will
       happily serve the same stale page straight back. */
    var base = location.origin + location.pathname;
    location.replace(base + '?wd=' + Date.now());
  }

  function reloadIfOnline(reason) {
    var meta = document.querySelector('meta[name="gbb-csv-url"]');
    if (!meta || !meta.content) { reload(reason + ' (no csv url)'); return; }
    fetch(meta.content + '&wd=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (r && r.ok) reload(reason); })
      .catch(function () { /* still down - leave the menu readable */ });
  }

  function check() {
    var s = silenceMs();
    if (s === null) return;
    showStale(s > MAX_SILENCE_MS);
    if (s > MAX_SILENCE_MS) reloadIfOnline('no successful fetch in ' + Math.round(s / 1000) + 's');
  }

  setInterval(check, CHECK_EVERY_MS);

  function onWake() {
    var s = silenceMs();
    if (s !== null && s > MAX_SILENCE_MS) {
      reloadIfOnline('woke after ' + Math.round(s / 1000) + 's silent');
    } else if (window.GBB && window.GBB.refresh) {
      window.GBB.refresh();
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') onWake();
  });
  window.addEventListener('online', onWake);
  window.addEventListener('focus', onWake);

  setInterval(function () {
    var d = new Date();
    if (d.getHours() === NIGHTLY_RELOAD_HOUR && d.getMinutes() === 0 && d.getSeconds() < 40) {
      reload('nightly');
    }
  }, 20 * 1000);

  /* From the Silk console: GBBWatchdog.status() / .kick() */
  window.GBBWatchdog = {
    status: function () {
      var s = silenceMs();
      return {
        secondsSinceLastGoodFetch: s === null ? null : Math.round(s / 1000),
        limitSeconds: MAX_SILENCE_MS / 1000,
        online: navigator.onLine,
        visible: document.visibilityState
      };
    },
    kick: function () { reload('manual'); }
  };
})();
