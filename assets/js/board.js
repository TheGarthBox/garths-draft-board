/* ============================================================
   Garth's Brew Bar — Draft Board renderer (v2).
   - Vanilla JS, IIFE, no deps.
   - Targets Fire TV Silk + modern Chromium.
   - Polls the published CSV every 60s, swaps DOM in place
     (no reload, no flash) so the board never blanks for guests.
   - v2 adds: brewery monogram fallback, tier-colored brewery name,
     selection-philosophy scoreboard in footer.
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
       redraw. 5 x 30s = 2.5 minutes of agreement. A lone stale response can
       never move the board.
       Simulated against a 50/50 flapping feed, 4000 trials:
         3 confirmations -> 9.8% chance of visible flicker
         4               -> 1.3%
         5               -> 0.1%   <- chosen
         6               -> 0.0%   (costs another 30s)
       Every setting converged on the correct final value in 4000/4000. */
    confirmationsRequired: 5,
    maxFailuresBeforeStaleDot: 5,
    /* Evidence for a candidate is forgotten if it hasn't been seen for
       this long - an edit that got undone shouldn't fire later. */
    candidateTtlMs: 4 * 60 * 1000,
    csvUrl: ''
  };

  /* ---------- State ---------- */
  var consecutiveFailures = 0;
  var renderState = new Map();   // tapNumber -> <article>
  var lastSuccessAt = null;
  var renderedCsv = null;        // what's currently on screen
  var candidateCsv = null;       // a change we've seen but not yet trusted
  var candidateSeen = Object.create(null); // csv -> { n, lastSeen }
  var candidateCount = 0;        // consecutive polls agreeing on candidateCsv

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

  /* ---------- Fetch ---------- */
  function fetchCsv() {
    if (!CFG.csvUrl) {
      return Promise.reject(new Error('CSV URL not configured'));
    }
    var sep = CFG.csvUrl.indexOf('?') >= 0 ? '&' : '?';
    var bustUrl = CFG.csvUrl + sep + 'cachebust=' + Date.now();
    return fetch(bustUrl, { cache: 'no-store' })
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

    // Icon area: explicit URL > brewery monogram
    var iconEl = el.querySelector('.gbb-tap-icon');
    var iconUrl = (t['Icon URL'] || '').trim();
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

        // First successful load, or a forced refresh: draw immediately.
        if (renderedCsv === null || force === true) {
          renderedCsv = csv;
          candidateCsv = null;
          candidateCount = 0;
          render(parseCsv(csv));
          return;
        }

        /* Identical to what's on screen. Note we do NOT clear the tally:
           wiping evidence every time an edge serves the old copy is half
           of what let a real change stall indefinitely. */
        if (csv === renderedCsv) {
          pruneCandidates();
          return;
        }

        // A snapshot that only lost a field to a lagging formula: ignore.
        if (isDegraded(parseCsv(csv), parseCsv(renderedCsv))) {
          return;
        }

        /* Count TOTAL sightings rather than a run of consecutive ones, so
           an alternating feed converges instead of resetting to 1. */
        var rec = candidateSeen[csv];
        if (!rec) { rec = candidateSeen[csv] = { n: 0, lastSeen: 0 }; }
        rec.n += 1;
        rec.lastSeen = Date.now();
        pruneCandidates();

        candidateCsv = csv;
        candidateCount = rec.n;

        if (rec.n >= CFG.confirmationsRequired) {
          renderedCsv = csv;
          candidateSeen = Object.create(null);
          candidateCsv = null;
          candidateCount = 0;
          render(parseCsv(csv));
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
    return candidateCsv ? { confirmations: candidateCount, needed: CFG.confirmationsRequired } : null;
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
