/* ============================================================
   Garth's Brew Bar — Draft Board renderer (v2.1).
   - Vanilla JS, IIFE, no deps.
   - Targets Fire TV Silk + modern Chromium.
   - Polls the published CSV every 12s, swaps DOM in place
     (no reload, no flash) so the board never blanks for guests.
   - v2 adds: brewery monogram fallback, tier-colored brewery name,
     selection-philosophy scoreboard in footer.
   - v2.0: dropped the per-request cachebust param. See fetchCsv() - that
     param was the cause of the long-running staleness, not Google.
   - v2.1: redraw quorum 5 -> 3 (~24s faster) now the feed is coherent.
   - v2.2: the board can no longer go BACKWARDS. The Taps tab carries a
     "Last Edited" stamp; any snapshot older than the one on screen is
     ignored outright. See "Snapshot ordering" below.
   ============================================================ */

(function () {
  'use strict';

  /* ---------- Config ---------- */
  var CFG = {
    pollIntervalMs: 12 * 1000,
    /* Google serves the published CSV from multiple edge caches that do NOT
       update in lockstep. For several minutes after a Sheet edit, identical
       requests can return old OR new content at random. Rendering every
       response makes rows flicker in and out - verified 2026-08-31.
       So: a CHANGE must be confirmed this many polls in a row before we
       redraw. At the current 12s poll, 3 x 12s = 36s of agreement. A lone
       stale response can never move the board.
       Simulated against a 50/50 flapping feed, 4000 trials:
         3 confirmations -> 9.8% chance of visible flicker
         4               -> 1.3%
         5               -> 0.1%   <- chosen
         6               -> 0.0%   (costs another 30s)
       Every setting converged on the correct final value in 4000/4000.

       UPDATE (v2.1, 2026-11-09): 5 -> 3. The simulation above was run
       against a feed that flapped BECAUSE of the cachebust bug removed in
       v2.0 - so its 9.8% figure for 3 confirmations describes conditions
       that no longer exist. Post-fix evidence: two measured keg changes,
       a beer swap reflected in just under 2 min and a status->Kicked in
       about 3.5 min, and in BOTH cases the board got there by itself -
       which is exactly what it never did before. 5 was buying very little.
       Saves ~24s on every change.

       Garth chose 3 over 2 knowingly: two agreeing reads is thin enough
       that a formula caught mid-recalculation could repeat itself and get
       drawn, and a wrong price on the wall of a Cicerone-led bar costs
       more than 12 seconds does.

       Poll interval left at 12s ON PURPOSE. One variable at a time is the
       discipline that found the cachebust bug after two wrong diagnoses.
       If 36s still feels slow, the remaining ~60-90s is Google's republish
       lag, and the only way at that is the live-read restructure in
       ROOT-CAUSE-stale-board.md. Measure before building it. */
    confirmationsRequired: 3,
    maxFailuresBeforeStaleDot: 5,
    /* Evidence for a candidate is forgotten if it hasn't been seen for
       this long - an edit that got undone shouldn't fire later. */
    candidateTtlMs: 4 * 60 * 1000,
    /* v2.2: header of the Taps-tab column holding the sheet's last-edit
       time, written by =TEXT(NOW(),"yyyy-mm-dd hh:mm:ss"). Only the first
       non-empty cell in the column is read. If the column is missing or
       blank the board behaves exactly as v2.1 did. */
    stampHeader: 'Last Edited',
    csvUrl: ''
  };

  /* ---------- State ---------- */
  var consecutiveFailures = 0;
  var renderState = new Map();   // tapNumber -> <article>
  var lastSuccessAt = null;
  var renderedKey = null;        // content now on screen (stamp excluded)
  var renderedRows = null;       // the same, parsed - for isDegraded()
  var renderedStamp = null;      // newest "Last Edited" seen for that content
  var candidateKey = null;       // a change we've seen but not yet trusted
  var candidateSeen = Object.create(null); // key -> { n, lastSeen, stamp }
  var candidateCount = 0;        // sightings of candidateKey so far
  var olderIgnored = 0;          // v2.2: stale snapshots refused since load
  var lastOlderAt = null;

  /* ---------- Config read ---------- */
  function readConfig() {
    var meta = document.querySelector('meta[name="gbb-csv-url"]');
    if (meta && meta.content) CFG.csvUrl = meta.content.trim();
    try {
      var params = new URLSearchParams(window.location.search);
      var override = params.get('csv');
      if (override) CFG.csvUrl = override;
    } catch (e) { /* older browsers */ }
  }

  /* ---------- Fetch ----------

     v2.0 - REMOVED the per-request `cachebust=<timestamp>` parameter.

     That parameter was mine, it was well-intentioned, and it was the
     cause of the staleness it was written to prevent.

     There are two caches between this board and the spreadsheet, and
     they need OPPOSITE treatment:

       1. The BROWSER's own cache. Defeated by `cache: 'no-store'`
          below. That is the correct and sufficient tool for it.

       2. Google's CDN, which serves the published CSV from many edge
          nodes. This one must NOT be defeated - it must be ASKED TO
          REVALIDATE.

     A unique query string makes every poll a brand-new object as far as
     the CDN is concerned. Nothing is ever warm, nothing ever revalidates
     against the canonical copy, and each request lands on whatever node
     answers first - which may be holding a snapshot from an hour ago.
     That is the cold-node lottery, and it explains the alternating
     3313/3314-byte payloads logged on 2026-10-24.

     `cache: 'no-store'` sends `Cache-Control: no-cache` upstream, which
     asks intermediaries to check with the origin rather than serve blind.
     Requesting the CANONICAL url is what keeps that one object fresh -
     and as a side effect every screen in the bar now warms the cache for
     every other screen, instead of each rolling its own dice.

     Evidence, 2026-11-07: board stale 5+ minutes after a sheet edit; one
     plain GET of this url from outside the bar; board current within one
     poll. Second occurrence of the same pattern.                      */
  function fetchCsv() {
    if (!CFG.csvUrl) {
      return Promise.reject(new Error('CSV URL not configured'));
    }
    return fetch(CFG.csvUrl, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      });
  }

  /* ---------- CSV parse (RFC4180-ish) ---------- */
  function parseCsv(text) {
    var rows = [];
    var row = [];
    var cell = '';
    var inQuote = false;
    var i = 0;
    var len = text.length;
    while (i < len) {
      var c = text.charAt(i);
      if (inQuote) {
        if (c === '"' && text.charAt(i + 1) === '"') { cell += '"'; i += 2; continue; }
        if (c === '"') { inQuote = false; i++; continue; }
        cell += c; i++; continue;
      }
      if (c === '"') { inQuote = true; i++; continue; }
      if (c === ',') { row.push(cell); cell = ''; i++; continue; }
      if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      cell += c; i++;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    if (!rows.length) return [];
    var headers = rows[0].map(function (h) { return h.trim(); });
    return rows.slice(1).map(function (r) {
      var obj = {};
      headers.forEach(function (h, idx) { obj[h] = (r[idx] == null ? '' : r[idx]).trim(); });
      return obj;
    });
  }

  /* ---------- Tier from city ---------- */
  function getTier(city) {
    if (!city) return 'us-craft';
    var c = city.toLowerCase();
    if (c.indexOf('madison') >= 0) return 'madison';
    if (/(,|\s)wi\b/.test(c) || c.indexOf(', wi') >= 0) return 'wisconsin';
    return 'us-craft';
  }

  /* ---------- Monogram from brewery name ---------- */
  /* Examples:
     "Working Draft"        -> "WD"
     "Giant Jones"          -> "GJ"
     "The Drowned Lands"    -> "DL"
     "Phase Three"          -> "P3"  (no — both alpha → "PT")
     "G5"                   -> "G5"
     "2nd Shift"            -> "2S"
     "Cha Cha Tea"          -> "CCT"
     "New Holland"          -> "NH"
  */
  function monogram(brewery) {
    if (!brewery) return '·';
    var b = brewery.trim();
    if (!b) return '·';
    // Drop leading article
    var noArticle = b.replace(/^(the|a|an)\s+/i, '');
    // Already short token (G5, P3, etc.) — use as-is
    if (noArticle.length <= 3 && !/\s/.test(noArticle)) {
      return noArticle.toUpperCase();
    }
    var parts = noArticle.split(/\s+/).filter(Boolean);
    // Single multi-char word: take first 2 letters (e.g., "Oliphant" -> "OL")
    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }
    // Multi-word: first letter of each, capped at 3
    var letters = parts.map(function (p) { return p.charAt(0); }).join('');
    return letters.slice(0, 3).toUpperCase();
  }

  /* ---------- Pours parser ---------- */
  var POUR_RE = /^(.+?)\s+(\$[\d.,]+)\s*$/;
  function parsePours(s) {
    if (!s) return [];
    return s.split('|').map(function (chunk) {
      var trimmed = chunk.trim();
      if (!trimmed) return null;
      var m = trimmed.match(POUR_RE);
      if (!m) return null;
      return { size: m[1].trim(), price: m[2] };
    }).filter(Boolean);
  }

  /* ---------- Escape ---------- */
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function setText(el, txt) {
    if (el && el.textContent !== txt) el.textContent = txt;
  }

  /* ---------- Tap number formatting ---------- */
  function padTapNum(n) {
    var s = String(parseInt(n, 10));
    return s.length === 1 ? '0' + s : s;
  }

  /* ---------- DOM build/update ---------- */
  function createTapElement() {
    var article = document.createElement('article');
    article.className = 'gbb-tap';
    article.innerHTML =
      '<div class="gbb-tap-numwrap"><span class="gbb-tap-num"></span></div>' +
      '<div class="gbb-tap-icon"><span class="gbb-tap-monogram"></span></div>' +
      '<div class="gbb-tap-body">' +
        '<h2 class="gbb-tap-heading">' +
          '<span class="gbb-tap-brewery"></span>' +
          '<span class="gbb-tap-name"></span>' +
        '</h2>' +
        '<p class="gbb-tap-meta"></p>' +
        '<p class="gbb-tap-pours"></p>' +
      '</div>';
    return article;
  }

  function updateTapElement(el, t) {
    var tier = getTier(t.City);
    var status = (t.Status || 'active').toLowerCase();

    // Tier class
    var desired = 'gbb-tier-' + tier;
    if (!el.classList.contains(desired)) {
      el.classList.remove('gbb-tier-madison', 'gbb-tier-wisconsin', 'gbb-tier-us-craft');
      el.classList.add(desired);
    }

    if (el.getAttribute('data-tap') !== t.Tap) el.setAttribute('data-tap', t.Tap);
    if (el.getAttribute('data-status') !== status) el.setAttribute('data-status', status);

    // Tap number
    setText(el.querySelector('.gbb-tap-num'), padTapNum(t.Tap));

    // Icon area: Icon URL on the sheet > brewery logo library > monogram
    // (v2.3: logo library is assets/logos/brewery-logos.js, keyed by the
    //  Brewery column. Missing logo -> '' -> initials, same as before.)
    var iconEl = el.querySelector('.gbb-tap-icon');
    var iconUrl = (t['Icon URL'] || '').trim() ||
      ((window.GBB_LOGOS && window.GBB_LOGOS.resolve(t.Brewery)) || '');
    if (iconUrl) {
      // Need <img>; ensure it exists
      var img = iconEl.querySelector('img');
      if (!img) {
        iconEl.innerHTML = '<img alt="" loading="lazy">';
        img = iconEl.querySelector('img');
      }
      if (img.getAttribute('data-current') !== iconUrl) {
        img.setAttribute('data-current', iconUrl);
        img.onerror = function () {
          // Fallback to monogram on error
          img.onerror = null;
          iconEl.innerHTML = '<span class="gbb-tap-monogram">' + escapeHtml(monogram(t.Brewery)) + '</span>';
        };
        img.src = iconUrl;
      }
    } else {
      // No URL: ensure monogram is rendered
      var mono = iconEl.querySelector('.gbb-tap-monogram');
      if (!mono) {
        iconEl.innerHTML = '<span class="gbb-tap-monogram"></span>';
        mono = iconEl.querySelector('.gbb-tap-monogram');
      }
      setText(mono, monogram(t.Brewery));
    }

    // Heading
    setText(el.querySelector('.gbb-tap-brewery'), t.Brewery || '');
    setText(el.querySelector('.gbb-tap-name'), ' ' + (t['Beer Name'] || ''));

    // Meta line
    var metaParts = [];
    if (t.Style) metaParts.push(t.Style);
    if (t.ABV) metaParts.push(t.ABV + '% ABV');
    if (t.City) metaParts.push(t.City);
    setText(el.querySelector('.gbb-tap-meta'), metaParts.join('  ·  '));

    // Pours
    var poursHtml = parsePours(t.Pours).map(function (p) {
      return '<span class="gbb-pour">' + escapeHtml(p.size) +
             ' <strong>' + escapeHtml(p.price) + '</strong></span>';
    }).join('');
    var poursEl = el.querySelector('.gbb-tap-pours');
    if (poursEl.innerHTML !== poursHtml) poursEl.innerHTML = poursHtml;
  }

  /* ---------- Scoreboard ---------- */
  function updateScoreboard(taps) {
    var counts = { madison: 0, wisconsin: 0, 'us-craft': 0 };
    taps.forEach(function (t) {
      counts[getTier(t.City)] += 1;
    });
    var slots = [
      { key: 'madison',   label: 'Madison',   cls: 'gbb-score-madison' },
      { key: 'wisconsin', label: 'Wisconsin', cls: 'gbb-score-wisconsin' },
      { key: 'us-craft',  label: 'US Craft',  cls: 'gbb-score-us-craft' }
    ];
    var board = document.getElementById('gbb-scoreboard');
    if (!board) return;
    var html = '<span class="gbb-scoreboard-label">Pouring tonight</span>';
    slots.forEach(function (s, i) {
      if (i > 0) html += '<span class="gbb-scoreboard-divider">·</span>';
      html += '<span class="gbb-scoreboard-stat ' + s.cls + '">' +
              '<span class="gbb-scoreboard-num">' + counts[s.key] + '</span>' +
              '<span class="gbb-scoreboard-tier">' + s.label + '</span>' +
              '</span>';
    });
    if (board.innerHTML !== html) board.innerHTML = html;
  }

  /* ---------- Render ---------- */
  function render(rows) {
    var grid = document.getElementById('gbb-grid');
    if (!grid) return;

    var taps = rows.filter(function (r) {
      var active = (r.Active || '').toLowerCase();
      return (active === 'yes' || active === 'true' || active === '1') && (r['Beer Name'] || '');
    }).sort(function (a, b) {
      return parseInt(a.Tap, 10) - parseInt(b.Tap, 10);
    });

    var seen = new Set();
    taps.forEach(function (t, idx) {
      var key = String(t.Tap);
      seen.add(key);
      var el = renderState.get(key);
      if (!el) {
        el = createTapElement();
        renderState.set(key, el);
      }
      updateTapElement(el, t);
      if (grid.children[idx] !== el) {
        grid.insertBefore(el, grid.children[idx] || null);
      }
    });

    renderState.forEach(function (el, key) {
      if (!seen.has(key)) {
        if (el.parentNode) el.parentNode.removeChild(el);
        renderState.delete(key);
      }
    });

    updateScoreboard(taps);
  }

  /* ---------- Status helpers ---------- */
  function setStaleDot(visible) {
    var dot = document.getElementById('gbb-stale-dot');
    if (dot) dot.hidden = !visible;
  }
  function logStatus(msg) {
    var el = document.getElementById('gbb-status');
    if (el) el.textContent = msg || '';
  }

  function pruneCandidates() {
    var cutoff = Date.now() - CFG.candidateTtlMs;
    for (var k in candidateSeen) {
      if (candidateSeen[k].lastSeen < cutoff) delete candidateSeen[k];
    }
  }

  /* ---------- Snapshot ordering (v2.2) ----------

     THE BUG THIS FIXES (18 Nov 2026)

     Garth swapped tap 12 from Working Draft Le Pils to Central Waters
     Honey Blonde. The board picked it up, then a few minutes later put
     Le Pils BACK - while the sheet still said Honey Blonde.

     After every edit Google's edges disagree for a few minutes: some
     serve the new snapshot, some the old one. (Measured that afternoon:
     the feed was still alternating between two versions of tap 12 three
     minutes after an edit.) The quorum above counts sightings of ANY
     snapshot that differs from the screen. It has no idea which one is
     newer. So once the new beer was drawn, the old snapshot was simply
     "a change" - and three sightings of it in four minutes redrew it.
     The quorum stops one stray response from moving the board. It never
     stopped three of them from moving it backwards.

     THE FIX

     The Taps tab now publishes a "Last Edited" stamp
     (=TEXT(NOW(),"yyyy-mm-dd hh:mm:ss")). It recalculates as part of the
     same edit that changes the beer, so a snapshot's stamp says how old
     its content is. The rule:

       older stamp than what's on screen  -> ignored. Never counted.
       same or newer                      -> the v2.1 quorum, unchanged.

     A stale edge can still DELAY a change. It can no longer UNDO one.

     The stamp is left out of the content comparison on purpose. If it
     were in, a Kegs-tab bookkeeping edit (new stamp, same beers) would
     look like a change to the menu, and if Google ever re-rendered the
     stamp on its own every snapshot would look unique and no change
     could ever collect three sightings.

     The format sorts as plain text, so comparison is a string compare.
     Anything blank or malformed is "unknown" and vetoes nothing - a
     missing column puts the board back on exact v2.1 behaviour.        */
  var STAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

  function readStamp(rows) {
    for (var i = 0; i < rows.length; i++) {
      var v = (rows[i][CFG.stampHeader] || '').trim();
      if (v) return STAMP_RE.test(v) ? v : null;
    }
    return null;
  }

  function isOlder(a, b) {   // true only when BOTH are known and a < b
    return !!(a && b && a < b);
  }

  function newest(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return a > b ? a : b;
  }

  function snapshot(csv) {
    var rows = parseCsv(csv);
    var stamp = readStamp(rows);
    var clean = rows.map(function (r) {
      var o = {};
      for (var k in r) { if (k !== CFG.stampHeader) o[k] = r[k]; }
      return o;
    });
    return { rows: clean, key: JSON.stringify(clean), stamp: stamp };
  }

  /* Once something newer is on screen, evidence for older snapshots is
     worthless. Drop it so it can't fire later. */
  function dropOlderCandidates() {
    for (var k in candidateSeen) {
      if (isOlder(candidateSeen[k].stamp, renderedStamp)) delete candidateSeen[k];
    }
  }

  function draw(snap) {
    renderedKey = snap.key;
    renderedRows = snap.rows;
    candidateSeen = Object.create(null);
    candidateKey = null;
    candidateCount = 0;
    render(snap.rows);
  }

  /* Is 'incoming' just 'current' with some fields gone blank?

     Google publishes the sheet from several edges and some snapshots
     catch a VLOOKUP before it has recalculated, so the same row arrives
     with an empty ABV instead of "5". Measured 2026-10-24: twenty
     consecutive fetches, every one carrying the correct beer, payload
     alternating 3313/3314 bytes on exactly that one field.

     Raw-string comparison treated those as two different documents, so
     the confirmation counter reset on every flip and could never reach
     five. Replayed against that exact alternation, the old rule redrew
     ZERO times in 60 polls - the board would have shown the previous
     beer forever while every fetch reported healthy.

     A response that only LOSES information is noise. Ignore it. */
  function isDegraded(incoming, current) {
    if (!incoming || !current || incoming.length !== current.length) return false;
    var sawBlanked = false;
    for (var i = 0; i < current.length; i++) {
      var a = incoming[i], b = current[i];
      if (!a || !b) return false;
      for (var k in b) {
        var nv = a[k] == null ? '' : String(a[k]);
        var ov = b[k] == null ? '' : String(b[k]);
        if (nv === ov) continue;
        if (nv === '' && ov !== '') { sawBlanked = true; continue; }
        return false;
      }
    }
    return sawBlanked;
  }

  /* ---------- Poll ---------- */
  /* force = true bypasses the confirmation window and renders whatever came
     back right now. Used by the "Refresh now" button on admin.html. */
  function poll(force) {
    return fetchCsv()
      .then(function (csv) {
        consecutiveFailures = 0;
        lastSuccessAt = new Date();
        setStaleDot(false);
        logStatus('');

        var snap = snapshot(csv);

        // First successful load, or a forced refresh: draw immediately.
        if (renderedKey === null || force === true) {
          renderedStamp = snap.stamp;
          draw(snap);
          return;
        }

        /* v2.2: older than what's on screen - a lagging edge. Refuse it
           before it can be counted. This is the line that stops the
           board going backwards. */
        if (isOlder(snap.stamp, renderedStamp)) {
          olderIgnored += 1;
          lastOlderAt = new Date();
          pruneCandidates();
          return;
        }

        /* Same content as the screen. Note we do NOT clear the tally:
           wiping evidence every time an edge serves the old copy is half
           of what let a real change stall indefinitely. A newer stamp on
           the same content (a Kegs-tab edit, say) still raises the bar
           that older snapshots have to clear. */
        if (snap.key === renderedKey) {
          var bumped = newest(renderedStamp, snap.stamp);
          if (bumped !== renderedStamp) {
            renderedStamp = bumped;
            dropOlderCandidates();
          }
          pruneCandidates();
          return;
        }

        // A snapshot that only lost a field to a lagging formula: ignore.
        if (isDegraded(snap.rows, renderedRows)) {
          return;
        }

        /* Count TOTAL sightings rather than a run of consecutive ones, so
           an alternating feed converges instead of resetting to 1. */
        var rec = candidateSeen[snap.key];
        if (!rec) { rec = candidateSeen[snap.key] = { n: 0, lastSeen: 0, stamp: null }; }
        rec.n += 1;
        rec.lastSeen = Date.now();
        rec.stamp = newest(rec.stamp, snap.stamp);
        pruneCandidates();

        candidateKey = snap.key;
        candidateCount = rec.n;

        if (rec.n >= CFG.confirmationsRequired) {
          renderedStamp = newest(renderedStamp, rec.stamp);
          draw(snap);
        }
        // else: hold. One stale response still cannot move the board.
      })
      .catch(function (err) {
        consecutiveFailures += 1;
        if (window.console && console.warn) {
          console.warn('[gbb] poll failed (#' + consecutiveFailures + '):', err && err.message);
        }
        if (consecutiveFailures >= CFG.maxFailuresBeforeStaleDot) {
          setStaleDot(true);
        }
      });
  }

  /* ---------- Expose ---------- */
  window.GBB = window.GBB || {};
  window.GBB.refresh = function () { return poll(true); };  // admin button: show me now
  window.GBB.getPendingChange = function () {
    return candidateKey ? { confirmations: candidateCount, needed: CFG.confirmationsRequired } : null;
  };
  /* v2.2 - from the Silk console: GBB.status() */
  window.GBB.status = function () {
    return {
      version: '2.2',
      sheetLastEdited: renderedStamp,      // stamp of what's on screen
      olderSnapshotsIgnored: olderIgnored, // stale edges refused since load
      lastOlderIgnoredAt: lastOlderAt,
      pendingChange: window.GBB.getPendingChange(),
      lastSuccessAt: lastSuccessAt
    };
  };
  window.GBB.getLastSuccessAt = function () { return lastSuccessAt; };
  window.GBB.config = CFG;
  window.GBB.monogram = monogram;

  /* ---------- Init ---------- */
  function init() {
    readConfig();
    if (!CFG.csvUrl) {
      logStatus('CSV source not configured. See README.');
      console.error('[gbb] No CSV URL set. Edit <meta name="gbb-csv-url" content="..."> in index.html.');
      return;
    }
    poll();
    // Wrapped, not passed directly: setInterval must never supply an argument
    // that could be read as `force` and bypass the confirmation window.
    setInterval(function () { poll(); }, CFG.pollIntervalMs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
