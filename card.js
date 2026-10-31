'use strict';

/* ==========================================================================
   Scorecard.

   A round lives in this browser and nowhere else. No account, no sync, no
   backend — the same rule the yardages follow, for the same reason: this app
   is used by minors, and data that is never collected needs no consent,
   no retention policy and no breach notification.

   The practical consequence is that the coach collects totals the way they
   always have: the player reads them out. That is a feature, not a shortfall.
   Shared live scoring is a different product with a server behind it.

   Entry point: Scorecard.init({ holes: 9, course: <course.json or null> }).
   ========================================================================== */

var Scorecard = (function () {
  var KEY = 'golfclub.round';
  var MAX_STROKES = 15;        // a sensible ceiling for a stepper
  var MAX_PUTTS = 10;

  var state = null;            // { startedAt, holes, scores: [...] }
  var holeInfo = [];           // par / yardage per hole, when the course is known
  var root = null;

  /* -- Storage ----------------------------------------------------------- */

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;             // private mode, blocked storage, or corrupt JSON
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) { /* the round still works for this session */ }
  }

  function blankRound(holes) {
    var scores = [];
    for (var i = 0; i < holes; i++) {
      scores.push({ strokes: 0, putts: 0, fir: false, gir: false });
    }
    return { startedAt: new Date().toISOString(), holes: holes, scores: scores };
  }

  /* -- Helpers ----------------------------------------------------------- */

  function parOf(i) {
    return holeInfo[i] && holeInfo[i].par ? holeInfo[i].par : null;
  }

  function totals() {
    var t = { strokes: 0, putts: 0, fir: 0, gir: 0, played: 0, par: 0 };
    state.scores.forEach(function (s, i) {
      if (s.strokes > 0) {
        t.played++;
        t.strokes += s.strokes;
        if (parOf(i)) t.par += parOf(i);
      }
      t.putts += s.putts;
      if (s.fir) t.fir++;
      if (s.gir) t.gir++;
    });
    return t;
  }

  function relToPar(t) {
    if (!t.played || !t.par) return '';
    var d = t.strokes - t.par;
    return d === 0 ? 'level par' : (d > 0 ? '+' + d : String(d));
  }

  /* -- Mutations --------------------------------------------------------- */

  function bump(i, field, delta, max) {
    var s = state.scores[i];
    s[field] = Math.max(0, Math.min(max, s[field] + delta));
    // Putts cannot exceed strokes; silently correcting beats a scolding alert.
    if (field === 'strokes' && s.putts > s.strokes) s.putts = s.strokes;
    if (field === 'putts' && s.strokes && s.putts > s.strokes) s.putts = s.strokes;
    save();
    render();
  }

  function toggle(i, field) {
    state.scores[i][field] = !state.scores[i][field];
    save();
    render();
  }

  /* -- Rendering --------------------------------------------------------- */

  function stepper(i, field, value, max, label) {
    return '<div class="step" role="group" aria-label="' + label + ' hole ' + (i + 1) + '">' +
        '<button class="step-btn" data-act="dec" data-i="' + i + '" data-f="' + field +
          '" data-max="' + max + '" aria-label="One fewer ' + label + '">−</button>' +
        '<span class="step-val">' + (value || '–') + '</span>' +
        '<button class="step-btn" data-act="inc" data-i="' + i + '" data-f="' + field +
          '" data-max="' + max + '" aria-label="One more ' + label + '">+</button>' +
      '</div>';
  }

  function holeRow(s, i) {
    var par = parOf(i);
    return '<div class="hole-row">' +
        '<div class="hole-row-top">' +
          '<span class="hole-id">' + (i + 1) +
            (par ? ' <small>Par ' + par + '</small>' : '') + '</span>' +
          stepper(i, 'strokes', s.strokes, MAX_STROKES, 'strokes') +
        '</div>' +
        '<div class="hole-row-bottom">' +
          '<span class="chip-label">Putts</span>' +
          stepper(i, 'putts', s.putts, MAX_PUTTS, 'putts') +
          '<button class="chip' + (s.fir ? ' on' : '') + '" data-act="fir" data-i="' + i +
            '" aria-pressed="' + s.fir + '">Fairway</button>' +
          '<button class="chip' + (s.gir ? ' on' : '') + '" data-act="gir" data-i="' + i +
            '" aria-pressed="' + s.gir + '">Green</button>' +
        '</div>' +
      '</div>';
  }

  function render() {
    var t = totals();
    var rel = relToPar(t);

    root.innerHTML =
      '<div class="card">' +
        '<div class="card-head">' +
          '<h2>This round</h2>' +
          '<span class="stamp">' + t.played + ' of ' + state.holes + ' holes</span>' +
        '</div>' +
        '<div class="card-totals">' +
          '<div class="total-big">' + (t.strokes || '–') +
            (rel ? ' <small>' + rel + '</small>' : '') + '</div>' +
          '<dl class="kv">' +
            '<dt>Putts</dt><dd>' + t.putts + '</dd>' +
            '<dt>Fairways</dt><dd>' + t.fir + ' of ' + state.holes + '</dd>' +
            '<dt>Greens</dt><dd>' + t.gir + ' of ' + state.holes + '</dd>' +
          '</dl>' +
        '</div>' +
        '<div class="card-actions">' +
          '<button class="btn-small" data-act="copy">Copy totals</button>' +
          '<button class="btn-small btn-quiet" data-act="new">New round</button>' +
        '</div>' +
        '<p class="note" id="cardMsg">This card is saved on this phone only. ' +
          'Nothing is sent anywhere, so read your totals to the coach.</p>' +
      '</div>' +
      '<div class="card">' +
        state.scores.map(holeRow).join('') +
      '</div>';
  }

  /* -- Actions ----------------------------------------------------------- */

  function summaryText() {
    var t = totals();
    var per = state.scores
      .map(function (s, i) { return (i + 1) + ':' + (s.strokes || '-'); })
      .join('  ');
    return 'Round ' + new Date(state.startedAt).toLocaleDateString() +
      '\nTotal ' + t.strokes + (relToPar(t) ? ' (' + relToPar(t) + ')' : '') +
      '\nPutts ' + t.putts + ', fairways ' + t.fir + '/' + state.holes +
      ', greens ' + t.gir + '/' + state.holes +
      '\n' + per;
  }

  function say(msg) {
    var el = document.getElementById('cardMsg');
    if (el) el.textContent = msg;
  }

  function copyTotals() {
    var text = summaryText();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(function () { say('Totals copied.'); })
        .catch(function () { say(text); });
    } else {
      say(text);               // no clipboard: show it so it can be read out
    }
  }

  function onClick(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    var i = Number(btn.getAttribute('data-i'));

    if (act === 'inc' || act === 'dec') {
      bump(i, btn.getAttribute('data-f'), act === 'inc' ? 1 : -1,
        Number(btn.getAttribute('data-max')));
    } else if (act === 'fir' || act === 'gir') {
      toggle(i, act);
    } else if (act === 'copy') {
      copyTotals();
    } else if (act === 'new') {
      // Losing a round by mis-tap would be worse than one extra tap.
      if (window.confirm('Start a new round? The current card is erased.')) {
        state = blankRound(state.holes);
        save();
        render();
      }
    }
  }

  /* -- Entry ------------------------------------------------------------- */

  function init(opts) {
    root = document.getElementById('cardBody');
    if (!root) return;

    // Par comes from the course only once it has really been walked. Example
    // coordinates carry example pars, and a card is the last place to show
    // an invented one — "+3" against a made-up par is just a wrong number.
    var course = (opts && opts.course) || null;
    holeInfo = (course && course.mapped === true && course.holes) || [];

    // Hole count: the mapped course if there is one, else whatever is
    // configured. A card must work on an unmapped course and away from home.
    var holes = (opts && opts.holes) || 9;
    if (holeInfo.length) holes = holeInfo.length;

    state = load();
    if (!state || !state.scores || state.scores.length !== holes) {
      state = blankRound(holes);
      save();
    }

    root.addEventListener('click', onClick);
    render();
  }

  return { init: init };
})();
