/* ============================================================
   Garth's Brew Bar — Draft Board · auto-fit (v1.7)

   WHY THIS EXISTS

   Long beer names were getting cut off with an ellipsis on the
   bar TVs — "Central Waters Bourbon Barrel Chocolate Kr…" — while
   looking perfectly fine on a laptop.

   The row CSS is `white-space: nowrap; overflow: hidden;
   text-overflow: ellipsis`, which is a silent failure mode: the
   board never looks broken, it just quietly stops telling you the
   name of the beer.

   The sizes themselves are fine. What varies is the FONT. The
   board asks Google for Lora and Source Serif 4; if that request
   is slow or blocked — which happens on Fire TV's Silk browser on
   bar wifi — the text renders in Georgia instead, which is wider.
   Same string, same box, more pixels. That's the ellipsis.

   So the fix can't be "pick a smaller size." It has to react to
   whatever font actually rendered, on whatever screen.

   HOW IT WORKS

   After every redraw, measure each line of text against the width
   it actually has. If it doesn't fit, scale that one line down
   just enough that it does — down to 70% of its normal size, and
   no further, because unreadable text is no better than truncated
   text. Lines that fit are left completely alone.

   Nothing here is layout-specific. It reads the computed style off
   the element, so it keeps working if the type sizes in
   board-v16.css change later.
   ============================================================ */

(function () {
  'use strict';

  /* Don't shrink past this. Below ~70% the text stops being
     readable from across the room, which is the whole job. */
  var MIN_SCALE = 0.70;

  /* Lines that are allowed to shrink. The tap NUMBER is excluded
     on purpose — it's the anchor of the row and should stay
     visually constant down the column. */
  var SELECTOR = '.gbb-tap-heading, .gbb-tap-meta, .gbb-tap-pours';

  var probe = null;

  /* An offscreen, unconstrained copy. We can't just read
     scrollWidth: with text-overflow:ellipsis the browser reports
     the CLIPPED width, so an overflowing line looks like it fits. */
  function getProbe() {
    if (!probe) {
      probe = document.createElement('div');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText =
        'position:absolute;left:-99999px;top:0;white-space:nowrap;' +
        'visibility:hidden;pointer-events:none';
      document.body.appendChild(probe);
    }
    return probe;
  }

  function fit(el) {
    if (!el) return;

    /* Clear any previous adjustment first, so we always measure
       against the real CSS size rather than compounding. This is
       also what lets text grow back when there's room again. */
    el.style.fontSize = '';

    var avail = el.clientWidth;
    if (!avail) return;

    var cs = getComputedStyle(el);
    var base = parseFloat(cs.fontSize);
    if (!base) return;

    var p = getProbe();
    p.style.fontFamily = cs.fontFamily;
    p.style.fontWeight = cs.fontWeight;
    p.style.fontStyle = cs.fontStyle;
    p.style.fontSize = base + 'px';
    p.style.letterSpacing = cs.letterSpacing;
    p.innerHTML = el.innerHTML;

    var needs = p.getBoundingClientRect().width;
    if (needs <= avail) return;               // fits: leave it alone

    var scale = Math.max(MIN_SCALE, avail / needs);
    el.style.fontSize = (base * scale).toFixed(2) + 'px';
  }

  function fitAll() {
    var list = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < list.length; i++) fit(list[i]);
  }

  /* Debounced: a redraw replaces 18 rows at once and we only want
     one pass at the end of it. */
  var timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(fitAll, 60);
  }

  /* board.js owns the grid and redraws it whenever the sheet
     changes. Watching the DOM means this needs no hook into
     board.js at all — that file stays untouched. Note we watch
     childList/characterData only, NOT attributes, or setting
     font-size would retrigger us in a loop. */
  function start() {
    var grid = document.getElementById('gbb-grid');
    if (grid) {
      new MutationObserver(schedule).observe(grid, {
        childList: true, subtree: true, characterData: true
      });
    }
    window.addEventListener('resize', schedule);

    /* Webfonts usually arrive after first paint. Without this the
       board would measure Georgia, then swap to Lora and never
       re-measure — exactly the bug, in reverse. */
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(schedule);
    }
    [0, 400, 1200, 3000].forEach(function (ms) { setTimeout(schedule, ms); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  /* For debugging from the Silk console: GBBFit.run() */
  window.GBBFit = { run: fitAll };
})();
