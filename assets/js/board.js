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
    pollIntervalMs: 60 * 1000,
    maxFailuresBeforeStaleDot: 5,
    csvUrl: ''
  };

  /* ---------- State ---------- */
  var consecutiveFailures = 0;
  var renderState = new Map();   // tapNumber -> <article>
  var lastSuccessAt = null;

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

  /* ---------- Poll ---------- */
  function poll() {
    return fetchCsv()
      .then(function (csv) {
        var rows = parseCsv(csv);
        render(rows);
        consecutiveFailures = 0;
        lastSuccessAt = new Date();
        setStaleDot(false);
        logStatus('');
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
  window.GBB.refresh = poll;
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
    setInterval(poll, CFG.pollIntervalMs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
