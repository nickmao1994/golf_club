'use strict';

/* ==========================================================================
   School Golf Club — static web app.

   Design rules this file follows:
   - No backend. Content comes from the JSON files in data/.
   - Location never leaves the device. Yardages are computed here, in the
     browser, from coordinates bundled with the app. Nothing is transmitted,
     which keeps the app clear of obligations around minors' location data.
   - Works offline. GPS is satellite-based and needs no signal; course data is
     cached by the service worker. Only the weather call needs the network.
   ========================================================================== */

const M_TO_YD = 1.09361;
const $ = id => document.getElementById(id);

const state = {
  course: null, holeIndex: 0, position: null, mapView: 'hole', weatherAt: 0,
  // true turns the single-hole map north-up instead of down the fairway.
  mapNorth: false,
  // A map turned by hand: radians, or null to follow mapNorth. mapRot is
  // whatever angle was last drawn, which is where a new drag starts from.
  mapTurn: null, mapRot: 0,
  // When a turn last ended, so the click it produces can be ignored.
  turnedAt: 0,
  // true while 'position' is the example ball rather than a real GPS fix.
  demoFix: false,
  // true while 'position' is a made-up "Locate me" result on the example
  // course. Unlike the example ball it stays where it was put, so it behaves
  // like a fix in every way except being one.
  simFix: false
};

/* -- Helpers ------------------------------------------------------------- */

async function loadJSON(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(path + ': ' + res.status);
  return res.json();
}

function fail(el, label) {
  el.classList.remove('loading');
  el.textContent = label + ' unavailable offline.';
}

function escapeHTML(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, c => map[c]);
}

/** Great-circle distance in yards. Plenty accurate over a few hundred yards. */
function distanceYards(a, b) {
  const R = 6371000;
  const rad = d => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) * M_TO_YD;
}

const fmtDate = iso =>
  new Date(iso + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric'
  });

const fmtTime = iso =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Relative age. "Not updated since Oct 15" reads like a bug when it is still
    Oct 15, so stale status is always expressed as elapsed time. */
function agoText(hours) {
  if (hours < 1) return 'less than an hour ago';
  if (hours < 24) {
    const h = Math.round(hours);
    return h + (h === 1 ? ' hour ago' : ' hours ago');
  }
  const d = Math.round(hours / 24);
  return d + (d === 1 ? ' day ago' : ' days ago');
}

const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
const compass = deg => COMPASS[Math.round(deg / 22.5) % 16];

/* -- Club identity ------------------------------------------------------- */

async function renderClub() {
  const club = await loadJSON('data/club.json');

  $('clubName').textContent = club.clubName;
  $('tagline').textContent = club.tagline || '';
  document.title = club.clubName;

  $('aboutText').innerHTML = (club.about || [])
    .map(p => '<p>' + escapeHTML(p) + '</p>').join('');

  $('contactList').innerHTML = (club.contacts || []).map(c => {
    const who = c.email
      ? '<a href="mailto:' + encodeURIComponent(c.email) + '">' + escapeHTML(c.name) + '</a>'
      : escapeHTML(c.name || 'TBD');
    return '<dt>' + escapeHTML(c.role) + '</dt><dd>' + who + '</dd>';
  }).join('');

  const shots = (club.photos || []).filter(p => p.src);
  if (!shots.length) {
    $('photoCard').classList.add('hidden');
  } else {
    $('photoGrid').innerHTML = shots.map(p =>
      '<figure><img src="' + escapeHTML(p.src) + '" alt="' +
      escapeHTML(p.caption || '') + '" loading="lazy">' +
      (p.caption ? '<figcaption>' + escapeHTML(p.caption) + '</figcaption>' : '') +
      '</figure>').join('');
  }

  return club;
}

/* -- Course status ------------------------------------------------------- */

/* Minimal CSV reader: handles quoted fields, embedded commas and doubled
   quotes, which is all a Google Sheet export produces. A note like
   "Carts path-only, frost delay" arrives quoted and must not split. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* The sheet is two columns — field name, value — so the coach edits a labelled
   cell rather than JSON punctuation. Anything the coach leaves blank comes
   back null and renders as "—" rather than as a confident wrong answer. */
const truthy = v => /^(y|yes|true|open|on|1)$/i.test(String(v).trim());

function statusFromCsv(text) {
  const cell = {};
  parseCsv(text).forEach(r => {
    const key = (r[0] || '').trim();
    if (key) cell[key] = (r[1] || '').trim();
  });

  const num = v => (v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
  const bool = v => (v === undefined || v === '' ? null : truthy(v));

  return {
    staleHours:    num(cell.staleHours) === null ? 18 : num(cell.staleHours),
    updatedAt:     cell.updatedAt || '',
    updatedBy:     cell.updatedBy || '',
    open:          truthy(cell.open),
    cartsAllowed:  bool(cell.cartsAllowed),
    greenHeightMm: num(cell.greenHeightMm),
    roughHeightMm: num(cell.roughHeightMm),
    notes:         cell.notes || ''
  };
}

/* Prefer the sheet when one is configured; fall back to the bundled file if it
   is unreachable. The fallback is usually old, but it arrives with its real
   timestamp, so the staleness guard greys it out instead of passing it off. */
async function loadStatus(club) {
  const csvUrl = (club && club.sources && club.sources.statusCsv) || '';
  if (csvUrl) {
    try {
      const res = await fetch(csvUrl, { cache: 'no-cache' });
      if (!res.ok) throw new Error('status CSV: ' + res.status);
      return statusFromCsv(await res.text());
    } catch (e) {
      /* fall through to the bundled file */
    }
  }
  return loadJSON('data/status.json');
}

async function renderStatus(club) {
  let s;
  try {
    s = await loadStatus(club);
  } catch (e) {
    return fail($('statusCard'), 'Course status');
  }

  // A missing or unreadable timestamp must fail towards "do not trust this".
  // Left as NaN it would compare false against staleHours and quietly present
  // an undated panel as current — the one outcome the staleness guard exists
  // to prevent. Likelier now that a human types the date into a spreadsheet.
  const t = Date.parse(s.updatedAt);
  const dated = !isNaN(t);
  const ageHours = dated ? (Date.now() - t) / 36e5 : Infinity;
  const stale = ageHours > (s.staleHours == null ? 18 : s.staleHours);

  // Stale status is actively misleading, so say so rather than show it plainly.
  $('statusCard').classList.toggle('stale', stale);
  $('statusStamp').textContent = !dated
    ? 'No update date — do not rely on this'
    : stale
      ? 'Last updated ' + agoText(ageHours) + ' — may be out of date'
      : 'Updated ' + fmtTime(s.updatedAt) + (s.updatedBy ? ' by ' + s.updatedBy : '');

  const open = $('statusOpen');
  open.textContent = s.open ? 'Open' : 'Closed';
  open.className = 'status-big ' + (s.open ? 'open' : 'closed');

  const mm = v => (v == null ? '—' : v + ' mm');
  $('greenHeight').textContent = mm(s.greenHeightMm);
  $('roughHeight').textContent = mm(s.roughHeightMm);
  $('cartsAllowed').textContent =
    s.cartsAllowed == null ? '—' : s.cartsAllowed ? 'Allowed' : 'No carts';
  $('statusNotes').textContent = s.notes || '';
}

/* -- Weather (Open-Meteo: free, no API key, CORS-friendly) --------------- */

const WMO = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle',
  55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow',
  75: 'Heavy snow', 77: 'Snow grains', 80: 'Light showers', 81: 'Showers',
  82: 'Violent showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm'
};
const STORM_CODES = [95, 96, 99];

/** Sunset is the one a golfer acts on: it decides whether nine more holes fit. */
function sunRow(daily) {
  if (!daily || !daily.sunrise || !daily.sunset) return '';
  return '<div class="wx-row">' +
      '<span>Sunrise <b>' + fmtTime(daily.sunrise[0]) + '</b></span>' +
      '<span>Sunset <b>' + fmtTime(daily.sunset[0]) + '</b></span>' +
    '</div>';
}

/* One API reading is not a forecast: no radar, no next few hours, no sense of
   where a storm is tracking. The card links out for that — and the link is the
   one part still worth having when our own fetch fails. Set homeCourse
   .forecastUrl to choose the service; otherwise it is built from the course
   coordinates. */
function forecastLink(course) {
  const url = course.forecastUrl ||
    (course.latitude == null ? ''
      : 'https://www.windy.com/?' + course.latitude + ',' + course.longitude + ',11');
  if (!url) return '';
  return '<a class="wx-link" href="' + escapeHTML(url) +
    '" target="_blank" rel="noopener noreferrer">Full forecast and radar →</a>';
}

async function renderWeather(club) {
  const body = $('weatherBody');
  const course = club.homeCourse || {};

  if (course.latitude == null) {
    body.classList.remove('loading');
    body.textContent = 'Set the course coordinates in data/club.json.';
    return;
  }

  const url = 'https://api.open-meteo.com/v1/forecast' +
    '?latitude=' + course.latitude + '&longitude=' + course.longitude +
    '&current=temperature_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
    '&hourly=precipitation_probability,weather_code&daily=sunrise,sunset&forecast_days=1' +
    '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto';

  let wx;
  try {
    const res = await fetch(url);
    wx = await res.json();
  } catch (e) {
    // Offline, the link out is the only thing left that can help.
    body.classList.remove('loading');
    body.innerHTML = '<div class="wx-fail">Live weather unavailable.</div>' +
      forecastLink(course);
    return;
  }

  const now = wx.current;
  const nextHours = (wx.hourly && wx.hourly.precipitation_probability || [0]).slice(0, 6);
  const rainChance = Math.max.apply(null, [0].concat(nextHours));

  body.classList.remove('loading');
  body.innerHTML =
    '<div class="wx-now">' +
      '<span class="wx-temp">' + Math.round(now.temperature_2m) + '&deg;</span>' +
      '<span class="wx-desc">' + escapeHTML(WMO[now.weather_code] || '—') + '</span>' +
    '</div>' +
    '<div class="wx-row">' +
      '<span>Wind <b>' + Math.round(now.wind_speed_10m) + ' mph ' +
        compass(now.wind_direction_10m) + '</b></span>' +
      '<span>Gusts <b>' + Math.round(now.wind_gusts_10m) + ' mph</b></span>' +
      '<span>Rain <b>' + rainChance + '%</b></span>' +
    '</div>' +
    sunRow(wx.daily) +
    forecastLink(course);

  const observed = wxObservedAt(wx);
  state.weatherAt = isNaN(observed) ? Date.now() : observed;
  paintWeatherStamp();

  const hourCodes = (wx.hourly && wx.hourly.weather_code || []).slice(0, 6);
  const stormy = STORM_CODES.indexOf(now.weather_code) !== -1 ||
    hourCodes.some(c => STORM_CODES.indexOf(c) !== -1);
  // Never hide a running wait. The forecast failing to predict a storm does
  // not mean the thunder someone actually heard was imaginary — and this call
  // resolves after initThunder(), so a plain toggle would erase the clock.
  $('stormAlert').classList.toggle('hidden', !stormy && !thunderEnd);
}

/* -- Lightning ----------------------------------------------------------- */

/* The 30-minute wait is the part people get wrong: they count from the first
   strike, not the last. So the clock is explicit, and restarting it is one
   tap. It survives a locked phone or a closed tab by storing the end time
   rather than a remaining duration — a countdown held in memory would quietly
   reset itself at the exact moment it matters. */
const THUNDER_KEY = 'golfclub.thunderUntil';
const THUNDER_WAIT_MS = 30 * 60 * 1000;

function thunderUntil(value) {
  try {
    if (value === undefined) return Number(localStorage.getItem(THUNDER_KEY)) || 0;
    localStorage.setItem(THUNDER_KEY, String(value));
  } catch (e) { /* private mode or blocked storage: the clock still ticks */ }
  return value || 0;
}

let thunderEnd = 0;

function paintThunderClock() {
  const el = $('thunderClock');
  if (!el) return;

  if (!thunderEnd) {
    el.textContent = 'Wait 30 minutes from the last thunder.';
    el.classList.remove('clear');
    return;
  }

  const left = thunderEnd - Date.now();
  if (left > 0) {
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    el.textContent = 'Resume no earlier than ' + m + ':' + (s < 10 ? '0' : '') + s;
    el.classList.remove('clear');
  } else {
    el.textContent = '30 minutes clear — resume only if nothing further was heard.';
    el.classList.add('clear');
  }
}

function restartThunderClock() {
  thunderEnd = Date.now() + THUNDER_WAIT_MS;
  thunderUntil(thunderEnd);
  $('stormAlert').classList.remove('hidden');
  paintThunderClock();
}

function initThunder() {
  thunderEnd = thunderUntil();

  // A clock from an hour ago is finished, not running: do not re-alarm on it.
  if (thunderEnd && Date.now() - thunderEnd > THUNDER_WAIT_MS) {
    thunderEnd = 0;
    thunderUntil(0);
  } else if (thunderEnd) {
    $('stormAlert').classList.remove('hidden');
  }

  $('btnThunder').addEventListener('click', restartThunderClock);
  $('btnThunderAgain').addEventListener('click', restartThunderClock);

  paintThunderClock();
  setInterval(paintThunderClock, 1000);
}

/** When the readings are actually for, as real UTC.

    Open-Meteo is asked for the course's own timezone, so it answers with that
    place's wall clock plus the offset to get back to UTC. Reading the wall
    clock as if it were UTC and then undoing the offset means neither the
    phone's clock setting nor the viewer's timezone comes into it — which
    matters here, where the course on screen is three time zones from nobody
    in particular. */
function wxObservedAt(wx) {
  const t = wx && wx.current && wx.current.time;
  if (!t) return NaN;
  const wall = Date.parse(t + 'Z');
  if (isNaN(wall)) return NaN;
  return wall - (wx.utc_offset_seconds || 0) * 1000;
}

/* Stamping the card with the time it was drawn was a lie in two directions.
   The readings are hourly, so they are already old when they arrive; and the
   service worker hands back the last good response when there is no signal,
   so a fetch succeeding proves nothing about the data being current. Either
   way the card could show conditions from hours ago over the word "Updated"
   and the current minute — and wind and storm risk are exactly what a
   decision to keep playing turns on. */
const WEATHER_STALE_MS = 90 * 60 * 1000;

function paintWeatherStamp() {
  const stamp = $('weatherStamp');
  if (!stamp || !state.weatherAt) return;

  const ageHours = (Date.now() - state.weatherAt) / 36e5;
  const stale = Date.now() - state.weatherAt > WEATHER_STALE_MS;

  const card = $('weatherCard');
  if (card) card.classList.toggle('stale', stale);

  stamp.textContent = stale
    ? 'Readings from ' + agoText(ageHours) + ' — may be out of date'
    : 'Updated ' + fmtTime(new Date(state.weatherAt).toISOString());
}

/* Fetched once at boot, the card ages silently: a phone left in a bag all
   morning still shows dawn's conditions, stamped as if current. Refresh when
   the page comes back to the foreground, which is exactly when someone is
   about to read it — and costs nothing while it sits in a pocket. Opening
   the tab counts too. Both are moments a person is about to look; neither is
   a timer, which on a four-hour round would cost battery for nothing. */
const WEATHER_MAX_AGE = 10 * 60 * 1000;

function initWeatherRefresh(club) {
  const look = () => {
    // The age has moved on whether or not a refresh is due, so the stamp is
    // repainted first: a card that cannot refresh must still admit its age.
    paintWeatherStamp();
    if (Date.now() - state.weatherAt < WEATHER_MAX_AGE) return;
    renderWeather(club);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') look();
  });

  const todayTab = document.querySelector('.tab[data-view="today"]');
  if (todayTab) todayTab.addEventListener('click', look);
}

/* -- Schedule ------------------------------------------------------------ */

/* Playing order and tee times. Omitted entirely when a match has no lineup —
   the privacy decision about publishing student names governs this exactly as
   it governs the results cards. */
function lineupTable(lineup) {
  if (!lineup || !lineup.length) return '';
  return '<div class="item-sub lineup-head">Playing order</div>' +
    '<table class="card-table">' +
    lineup.map(p =>
      '<tr><td>' + escapeHTML(p.player || '') + '</td>' +
      '<td>' + escapeHTML(p.time || '') + '</td></tr>').join('') +
    '</table>';
}

function eventCard(e) {
  return '<div class="item">' +
    '<div class="item-head">' +
      '<span class="item-title">' +
        '<span class="pill ' + (e.type === 'match' ? 'match' : '') + '">' +
          escapeHTML(e.type) + '</span> ' + escapeHTML(e.title) +
      '</span>' +
      '<span class="item-date">' + fmtDate(e.date) + ' &middot; ' + escapeHTML(e.time) + '</span>' +
    '</div>' +
    '<div class="item-sub">' + escapeHTML(e.location || '') + '</div>' +
    (e.bring ? '<div class="item-sub">Bring: ' + escapeHTML(e.bring) + '</div>' : '') +
    lineupTable(e.lineup) +
    '</div>';
}

async function renderSchedule() {
  const list = $('scheduleList');
  const next = $('nextEvent');

  let data;
  try {
    data = await loadJSON('data/schedule.json');
  } catch (e) {
    fail(list, 'Schedule');
    return fail(next, 'Schedule');
  }

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = (data.events || [])
    .filter(e => e.date >= today)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  list.classList.remove('loading');
  next.classList.remove('loading');

  if (!upcoming.length) {
    list.innerHTML = '<div class="item">Nothing scheduled yet.</div>';
    next.textContent = 'Nothing scheduled yet.';
    return;
  }

  list.innerHTML = upcoming.map(eventCard).join('');
  next.innerHTML = eventCard(upcoming[0])
    .replace('class="item"', 'class="item" style="margin:0;border:0;padding:0;background:none"');
}

/* -- Results ------------------------------------------------------------- */

async function renderResults() {
  const list = $('resultsList');

  let data;
  try {
    data = await loadJSON('data/results.json');
  } catch (e) {
    return fail(list, 'Results');
  }

  list.classList.remove('loading');

  const matches = (data.matches || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  const link = data.externalUrl
    ? '<div class="item"><a href="' + escapeHTML(data.externalUrl) +
      '">Full season scoring &rarr;</a></div>'
    : '';

  if (!matches.length) {
    list.innerHTML = link || '<div class="item">No results posted yet.</div>';
    return;
  }

  list.innerHTML = link + matches.map(m => {
    const cards = (m.cards || []).map(c =>
      '<tr class="' + (c.counted === false ? 'dropped' : '') + '">' +
        '<td>' + escapeHTML(c.player) + '</td><td>' + c.score + '</td>' +
      '</tr>').join('');

    const score = m.teamScore != null
      ? ' &middot; ' + m.teamScore + '&ndash;' + m.opponentScore
      : '';

    return '<div class="item">' +
      '<div class="item-head">' +
        '<span class="item-title">' +
          '<span class="pill ' + (m.result === 'W' ? '' : 'loss') + '">' +
            escapeHTML(m.result || '—') + '</span> vs. ' + escapeHTML(m.opponent) +
        '</span>' +
        '<span class="item-date">' + fmtDate(m.date) + '</span>' +
      '</div>' +
      '<div class="item-sub">' + escapeHTML(m.course || '') + score + '</div>' +
      '<div class="item-sub">' + escapeHTML(m.format || '') + '</div>' +
      (cards ? '<table class="card-table">' + cards + '</table>' : '') +
      '</div>';
  }).join('');
}

/* -- Yardage ------------------------------------------------------------- */

/* Where a ball in play would plausibly sit: short of the green by about a
   par's worth of golf, and off the centre line, because nobody's ball is ever
   exactly on it. Used only while the course is an example one — it saves
   making anyone stand on a fairway in California to see what the screen does,
   and it is called an example ball everywhere it appears. */
const DEMO_ALONG = { 3: 0.32, 4: 0.64, 5: 0.74 };
const DEMO_OFFSET_YD = 14;

function demoPlayer(h) {
  if (!h || !h.tee || !h.center) return null;

  // Walk the hole's own route, not the straight line to the green. On a
  // dogleg those are very different places: 64% along the straight line of
  // the 8th puts the ball over the cliff, which is a poor advertisement for
  // the feature.
  const route = (h.path && h.path.length > 1)
    ? h.path.concat([h.center])
    : [h.tee, h.center];

  const legs = [];
  let total = 0;
  for (let i = 1; i < route.length; i++) {
    const d = distanceYards(route[i - 1], route[i]);
    legs.push(d);
    total += d;
  }
  if (!total) return { lat: h.tee.lat, lon: h.tee.lon };

  let want = total * (DEMO_ALONG[h.par] || 0.64);
  let i = 0;
  while (i < legs.length - 1 && want > legs[i]) { want -= legs[i]; i++; }

  const a = route[i], b = route[i + 1];
  const t = legs[i] ? want / legs[i] : 0;
  const lat = a.lat + t * (b.lat - a.lat);
  const lon = a.lon + t * (b.lon - a.lon);

  // Step sideways off the line, square to the leg the ball is on. A degree of
  // longitude is shorter than a degree of latitude everywhere but the equator,
  // so the east-west part is scaled before the right-angle turn and unscaled
  // after it; skip that and the offset comes out skewed and the ball drifts
  // up the fairway instead of across it.
  const k = Math.cos((lat * Math.PI) / 180);
  const dy = b.lat - a.lat;
  const dx = (b.lon - a.lon) * k;
  const len = Math.hypot(dx, dy);
  if (!len) return { lat: lat, lon: lon };

  const dLat = DEMO_OFFSET_YD / M_TO_YD / 111320; // yards -> metres -> degrees
  return {
    lat: lat - (dx / len) * dLat,
    lon: lon + (dy / len) * dLat / k
  };
}

/** Puts the example ball on whichever hole is showing. No accuracy value: an
    accuracy ring means a fix, and this is not one. */
function setDemoPlayer() {
  const holes = (state.course && state.course.holes) || [];
  const p = demoPlayer(holes[state.holeIndex]);
  if (!p) return;
  state.position = p;
  state.demoFix = true;
}

async function initYardage() {
  try {
    state.course = await loadJSON('data/course.json');
  } catch (e) {
    $('accuracy').textContent = 'Course data unavailable.';
    $('mapCard').classList.add('hidden');
    return;
  }
  // Never let example coordinates masquerade as real yardages.
  const example = state.course.mapped !== true;
  $('unmappedBanner').classList.toggle('hidden', !example);

  if (example) {
    if (state.course.courseName) $('exampleCourseName').textContent = state.course.courseName;
    // OpenStreetMap's licence asks for the credit to travel with the data.
    $('courseCredit').textContent = state.course.attribution || '';
    // Put a ball in play rather than three dashes and an instruction. The
    // distances from it are worked the same way as anyone's would be.
    setDemoPlayer();
    $('accuracy').textContent =
      'Example ball on an example course — not a GPS fix. '
      + 'Tap “Locate me” to measure from where you are.';
  } else if (state.course.attribution) {
    // The credit has to outlive the banner it used to sit in: the licence
    // asks for it to travel with the data, and the data is still the data.
    const credit = $('courseSource');
    credit.textContent = 'Hole coordinates: ' + state.course.attribution + '.';
    credit.classList.remove('hidden');
  }

  drawHole();
}

function drawHole() {
  const holes = state.course && state.course.holes;
  const h = holes && holes[state.holeIndex];
  if (!h) return;

  // Step to another hole and the example ball moves to it, so every hole
  // demonstrates itself. A real fix is never overwritten.
  if (state.demoFix) setDemoPlayer();

  // Each hole gets its own orientation. Carrying a hand-turn across would
  // leave the next hole skewed by an angle that meant something on the last.
  state.mapTurn = null;

  $('holeNum').textContent = 'Hole ' + h.hole;
  $('holeMeta').textContent = [
    h.par ? 'Par ' + h.par : '',
    h.cardYards ? h.cardYards + ' yds on the card' : ''
  ].filter(Boolean).join(' · ');

  // Local knowledge beats a yardage on a hole you have never played, and it
  // costs nothing to carry. Hidden entirely when a hole has none, so an empty
  // line never implies there is nothing to know.
  const note = $('holeNote');
  note.textContent = h.note || '';
  note.classList.toggle('hidden', !h.note);

  drawYardages();
  drawHoleHint();
  drawMap();
}

/* The map refuses to draw a fix more than this from anything it has mapped —
   an away course, or a desktop browser guessing from the network. The yardages
   have to refuse too. 4,524,321 set in the big green numerals is not a large
   distance, it is a wrong answer given with total confidence, and this whole
   app is built on not doing that. */
const OFF_COURSE_YD = 875; // the 800 m the map already uses

function fixOffCourse(p) {
  const holes = (state.course && state.course.holes) || [];
  if (!p || !holes.length) return false;

  let best = Infinity;
  holes.forEach(h => {
    ['tee', 'front', 'center', 'back'].forEach(k => {
      if (h[k]) best = Math.min(best, distanceYards(p, h[k]));
    });
  });
  return best > OFF_COURSE_YD;
}

function drawYardages() {
  const holes = state.course && state.course.holes;
  const h = holes && holes[state.holeIndex];
  const p = state.position;
  const off = fixOffCourse(p);

  const show = (el, target) => {
    $(el).textContent = p && target && !off ? Math.round(distanceYards(p, target)) : '—';
  };

  show('ydFront', h && h.front);
  show('ydCenter', h && h.center);
  show('ydBack', h && h.back);
}

/* -- Map ----------------------------------------------------------------- */

/** Draws the hole through the shared renderer in map.js. The numbers above
    say how far; the map says which way — which is what a student standing on
    an unfamiliar tee actually needs. Nothing here leaves the device: the
    position is drawn from the same in-browser coordinates as the yardages. */
function drawMap() {
  const svg = $('holeMap');
  // If map.js is ever dropped, the yardages must still work.
  if (!svg || typeof GolfMap === 'undefined') return;

  const holes = (state.course && state.course.holes) || [];
  const whole = state.mapView === 'course';
  const hole = holes[state.holeIndex];
  const example = !(state.course && state.course.mapped === true);

  const out = GolfMap.render(svg, {
    holes: whole ? holes : (hole ? [hole] : []),
    me: state.position,
    // In the pulled-back view, ring the hole you are on so it stands out.
    highlight: whole && hole ? (hole.tee || hole.center) : null,
    labels: whole ? 'hole' : 'detail',
    pick: whole,
    // One hole reads best facing down the fairway; the whole course reads
    // best north-up, the way the clubhouse signboard draws it.
    // A map turned by hand outranks both modes until it is let go of.
    rotate: state.mapTurn != null
      ? state.mapTurn
      : (whole || state.mapNorth ? null : 'play'),
    aim: !whole,
    // Second line of defence behind the banner: an example layout says so on
    // its face, so a screenshot of it can never pass for the real course.
    watermark: example ? 'Example layout' : null,
    empty: 'This hole has no coordinates yet.'
  });

  // Remember what was actually drawn: a drag starts from the angle on screen,
  // not from the mode that produced it.
  if (out && typeof out.rot === 'number') state.mapRot = out.rot;

  // The map is a picture; without this it says nothing to a screen reader.
  const said = [
    whole ? 'Course map, all mapped holes' : 'Map of hole ' + (hole ? hole.hole : '—'),
    example ? 'example layout, not the real course' : null,
    state.position && !out.meOffMap ? 'your position is shown' : 'your position is not shown'
  ].filter(Boolean);
  svg.setAttribute('aria-label', said.join('; ') + '.');

  const note = [];
  if (example) note.push('Example layout — not this course.');
  if (whole) note.push('Tap a number to go to that hole.');
  if (state.mapTurn != null) note.push('Turned by hand.');
  else if (!whole) {
    note.push(state.mapNorth
      ? 'North is up the screen.'
      : 'Up the screen is the line to the green.');
  }
  if (state.demoFix) note.push('The marker is an example ball, not you.');
  else if (state.simFix) note.push('Simulated position, not yours.');
  else if (!state.position) note.push('Tap “Locate me” to put yourself on the map.');
  else if (out.meOffMap) note.push('Your fix is well away from the mapped holes, so it is not drawn.');
  else if (!whole) note.push('The ring around you is how good the fix is.');
  $('mapNote').textContent = note.join(' ');
}

/* Which way up the hole map is drawn. Down the fairway is the default and
   the better one for playing a hole — it is how the hole looks from the tee.
   North-up is for the player who is orienting rather than aiming: matching the
   map to a signboard, a printed card, or the course as they already know it.
   Neither is right for everyone, so it is a choice rather than a decision, and
   it is remembered — a preference you have to re-make on every hole is not a
   preference. */
const NORTH_KEY = 'golfclub.mapNorth';

function setMapNorth(north) {
  state.mapNorth = !!north;
  // Asking for an orientation by name means letting go of the one by hand.
  state.mapTurn = null;
  try {
    localStorage.setItem(NORTH_KEY, north ? '1' : '0');
  } catch (e) {
    // Private mode, or storage turned off. The choice still holds for now.
  }

  const btn = $('btnMapRotate');
  if (!btn) return;
  btn.textContent = north ? 'Fairway up' : 'North up';
  btn.setAttribute('aria-pressed', north ? 'true' : 'false');
}

function loadMapNorth() {
  let saved = false;
  try { saved = localStorage.getItem(NORTH_KEY) === '1'; } catch (e) {}
  setMapNorth(saved);
}

/** The toggle's two states in one place, now that a tap on the map sets it
    as well as the button does. Redrawing is left to the caller: picking a hole
    changes more than the map. */
function setMapView(whole) {
  state.mapView = whole ? 'course' : 'hole';
  state.mapTurn = null;

  // Eighteen holes run in every direction, so there is no fairway to face:
  // the course view is north-up and the choice does not apply.
  const rotBtn = $('btnMapRotate');
  if (rotBtn) rotBtn.classList.toggle('hidden', whole);

  const btn = $('btnMapView');
  if (!btn) return;
  btn.textContent = whole ? 'This hole' : 'Whole course';
  btn.setAttribute('aria-pressed', whole ? 'true' : 'false');
}

/* Turning the map by hand.

   Held and dragged, the map follows the finger, so it can be lined up with
   what the player is actually looking at. Three things make that workable on
   a phone rather than merely possible:

   It takes a HOLD to start. A map is a big target in the middle of a
   scrolling page, and a drag that rotated immediately would eat every attempt
   to scroll past it. Waiting for a still finger means a scroll never becomes
   a rotation by accident — and it is what "hold on the map and rotate"
   describes.

   It is abandoned the moment the finger moves first. If the touch travels
   before the hold lands, it was a scroll, and the timer is dropped.

   It suppresses the tap that would otherwise follow. The whole-course map
   turns hole numbers into buttons; without this, letting go after a turn
   would also jump to whichever hole was under the thumb. */
const TURN_HOLD_MS = 350;
const TURN_SLOP_PX = 10;   // movement before the hold that means "scrolling"

function initMapTurn() {
  const svg = $('holeMap');
  if (!svg || !window.PointerEvent) return;

  let timer = null, turning = false, moved = false;
  let startAng = 0, startRot = 0, downX = 0, downY = 0;

  // Screen angle from the middle of the map, counter-clockwise, which is the
  // sense the projection turns in. Measured in client pixels: the SVG scales
  // to the card, so its own units would be the wrong ruler.
  const angleAt = e => {
    const r = svg.getBoundingClientRect();
    return Math.atan2(-(e.clientY - (r.top + r.height / 2)),
                        e.clientX - (r.left + r.width / 2));
  };

  const stop = () => {
    clearTimeout(timer);
    timer = null;
    if (turning) svg.classList.remove('turning');
    turning = false;
  };

  svg.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button > 0) return;
    moved = false;
    downX = e.clientX;
    downY = e.clientY;

    timer = setTimeout(() => {
      turning = true;
      moved = false;
      startAng = angleAt(e);
      startRot = state.mapRot;
      svg.classList.add('turning');
      try { svg.setPointerCapture(e.pointerId); } catch (err) {}
    }, TURN_HOLD_MS);
  });

  svg.addEventListener('pointermove', e => {
    if (!turning) {
      // Still waiting on the hold: any real travel means this was a scroll.
      if (timer && Math.hypot(e.clientX - downX, e.clientY - downY) > TURN_SLOP_PX) {
        clearTimeout(timer);
        timer = null;
      }
      return;
    }
    moved = true;
    e.preventDefault();
    state.mapTurn = startRot + (angleAt(e) - startAng);
    drawMap();
  });

  ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => {
    svg.addEventListener(type, () => {
      // A turn ends in a click the map must not act on. Recorded as a time
      // rather than armed as a one-shot listener: a gesture that ends off the
      // element never produces that click, and the listener would have sat
      // there waiting to swallow the next real tap instead.
      if (turning && moved) state.turnedAt = Date.now();
      stop();
    });
  });
}

/** Tap a hole number on the whole-course map to go to that hole.

    Pointer only, deliberately. Every hole is already reachable from the
    ‹ › buttons, and eighteen extra tab stops inside a map would make the
    keyboard path through this screen worse rather than better. */
function initMapPick() {
  const svg = $('holeMap');
  if (!svg) return;

  svg.addEventListener('click', e => {
    // Letting go after turning the map lands a click on whatever was under
    // the thumb. That is not a choice of hole.
    if (Date.now() - state.turnedAt < 400) return;

    const hit = e.target.closest && e.target.closest('[data-hole]');
    if (!hit) return;

    const want = Number(hit.getAttribute('data-hole'));
    const holes = (state.course && state.course.holes) || [];
    let i = -1;
    holes.forEach((h, k) => { if (h.hole === want) i = k; });
    if (i < 0) return;

    state.holeIndex = i;
    // You asked for a hole, so show it. The toggle is right there to go back.
    setMapView(false);
    drawHole();
  });
}

/** Yards from p to the straight segment a-b. The points are projected onto
    a flat plane centred on p, which is accurate to well under a yard over the
    few hundred yards of one hole. */
function yardsToSegment(p, a, b) {
  const k = Math.cos((p.lat * Math.PI) / 180);
  const toXY = q => ({
    x: (q.lon - p.lon) * k * 111320 * M_TO_YD,
    y: (q.lat - p.lat) * 111320 * M_TO_YD
  });
  const A = toXY(a), B = toXY(b);
  const dx = B.x - A.x, dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  // t is where the closest point falls along a-b, clamped to the segment.
  const t = len2 ? Math.max(0, Math.min(1, -(A.x * dx + A.y * dy) / len2)) : 0;
  return Math.hypot(A.x + t * dx, A.y + t * dy);
}

/** The hole whose line of play (tee, along the path, to the green centre) is
    nearest, and how far that is.

    Measuring to the line rather than to the tee and the green alone matters
    in the middle of a fairway. Halfway down the 3rd at Blair the 6th tee is
    nearer than either end of the 3rd, so the tee-and-green measure picked the
    6th and showed yardages to the wrong green. */
function nearestHole(pos) {
  const holes = (state.course && state.course.holes) || [];
  let best = null;

  holes.forEach((h, i) => {
    const d = holeLineYards(pos, h);
    if (d < Infinity && (!best || d < best.d)) best = { d: d, i: i };
  });
  return best;
}

/** Yards from pos to one hole's line of play, or Infinity if the hole has no
    coordinates. */
function holeLineYards(pos, h) {
  if (!h) return Infinity;
  const route = (h.path && h.path.length ? h.path : [h.tee])
    .concat([h.center])
    .filter(Boolean);
  let d = Infinity;
  if (route.length === 1) d = distanceYards(pos, route[0]);
  for (let j = 1; j < route.length; j++) {
    d = Math.min(d, yardsToSegment(pos, route[j - 1], route[j]));
  }
  return d;
}

/* A player within KEEP_HOLE_YD of the line of the hole already on screen
   keeps that hole, even when another hole's line is nearer. At Blair the 6th
   tee is 28 yards from the 3rd's line, so a ball 25 yards right of the 3rd
   fairway is nearer the 6th; a player who has the 3rd on screen is playing
   the 3rd. The one exception is standing on another hole's tee
   (within ON_TEE_YD of it): a player on a tee is about to play that hole.
   When the hole is kept, drawHoleHint still says which hole is nearer. */
const KEEP_HOLE_YD = 30;
const ON_TEE_YD = 15;

/** Pick the hole the player is on — saves tapping through the holes. */
function autoSelectHole(pos) {
  const holes = (state.course && state.course.holes) || [];
  const best = nearestHole(pos);
  if (!best || best.d >= 600) return;

  let onTee = -1;
  holes.forEach((h, i) => {
    if (h.tee && distanceYards(pos, h.tee) <= ON_TEE_YD) onTee = i;
  });
  if (onTee >= 0) { state.holeIndex = onTee; return; }

  if (holeLineYards(pos, holes[state.holeIndex]) <= KEEP_HOLE_YD) return;
  state.holeIndex = best.i;
}

/** Explain a big number instead of hiding it.

    Standing on the range with hole 5 on screen, the yardage reads 1,735. It is
    not wrong — that really is the distance to the 5th green — and suppressing
    it would mean refusing to answer "how far is that from here", which is a
    fair question. What was missing is why it is large. Saying which hole you
    are actually next to turns a puzzling number into an orientation, and the
    map's hole numbers are one tap away. */
function drawHoleHint() {
  const el = $('holeHint');
  if (!el) return;

  const holes = (state.course && state.course.holes) || [];
  const p = state.position;
  let msg = '';

  if (p && !state.demoFix && !fixOffCourse(p)) {
    const best = nearestHole(p);
    if (best && best.i !== state.holeIndex && holes[best.i]) {
      msg = 'You are nearest hole ' + holes[best.i].hole + '.';
    }
  }

  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

/** A believable spot somewhere on the course: a random hole, a random point
    along it, and up to 25 yards either side of the line of play.

    This exists because of how the demo reads. An example course is somewhere
    almost nobody opening the published site is standing, so a real fix
    correctly answers "that is not on this course" and leaves three dashes —
    which looks broken rather than careful. Inventing a position on a course
    that is not yours costs nothing: the banner, the watermark on the map and
    the line under the yardages all say what it is.

    Unreached while data/course.json is the club's own course, and kept for
    whoever puts an example one back. */
function randomCoursePosition() {
  const holes = (state.course && state.course.holes) || [];
  if (!holes.length) return null;

  const pick = Math.floor(Math.random() * holes.length);
  const h = holes[pick];
  const route = (h.path && h.path.length > 1)
    ? h.path.concat([h.center])
    : (h.tee && h.center ? [h.tee, h.center] : null);
  if (!route) return null;

  const legs = [];
  let total = 0;
  for (let i = 1; i < route.length; i++) {
    const d = distanceYards(route[i - 1], route[i]);
    legs.push(d);
    total += d;
  }
  if (!total) return null;

  // Along the hole, short of the green. Level with it or past it, 'front' and
  // 'back' inverted — they are fixed points measured from the tee, so a ball
  // beside the green is genuinely nearer the back of it, which reads as a bug.
  let want = total * (0.15 + Math.random() * 0.7);
  let i = 0;
  while (i < legs.length - 1 && want > legs[i]) { want -= legs[i]; i++; }

  const a = route[i], b = route[i + 1];
  const t = legs[i] ? want / legs[i] : 0;
  const lat = a.lat + t * (b.lat - a.lat);
  const lon = a.lon + t * (b.lon - a.lon);

  // Off the line by up to a wayward drive, either side — nobody is ever on it.
  const k = Math.cos((lat * Math.PI) / 180);
  const dy = b.lat - a.lat;
  const dx = (b.lon - a.lon) * k;
  const len = Math.hypot(dx, dy) || 1;
  const off = ((Math.random() * 2) - 1) * 25 / M_TO_YD / 111320;

  return {
    holeIndex: pick,
    pos: {
      lat: lat - (dx / len) * off,
      lon: lon + (dy / len) * off / k,
      // A plausible phone fix, so the accuracy ring shows the real thing.
      accuracy: 4 + Math.random() * 5
    }
  };
}

function locate() {
  const out = $('accuracy');

  // Only ever on an example course. The moment data/course.json says
  // "mapped": true this button is real GPS again, with real errors, because
  // by then the number on this screen is one a player clubs off.
  if (state.course && state.course.mapped !== true) {
    const made = randomCoursePosition();
    if (made) {
      state.position = made.pos;
      state.demoFix = false;
      state.simFix = true;
      // Show the hole the ball was actually put on. autoSelectHole only
      // switches within 600 yards, and a ball in the middle of a long par 5
      // is further than that from both its own tee and its own green — so
      // the view would stay on whatever hole was up, reporting 662 yards to
      // a green the player is nowhere near.
      state.holeIndex = made.holeIndex;
      drawHole();
      out.className = 'accuracy';
      out.textContent = 'Simulated position on the example course — not where '
        + 'you are. Tap again for another.';
      return;
    }
  }

  if (!navigator.geolocation) {
    out.textContent = 'This browser has no location support.';
    return;
  }

  out.className = 'accuracy';
  out.textContent = 'Getting a fix…';

  // One-shot rather than a continuous watch: a round is 4-5 hours and
  // continuous GPS would flatten the battery.
  navigator.geolocation.getCurrentPosition(
    pos => {
      // Accuracy is kept so the map can draw the ring to scale.
      state.position = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      };
      state.demoFix = false;
      state.simFix = false;
      autoSelectHole(state.position);
      drawHole();

      const yd = Math.round(pos.coords.accuracy * M_TO_YD);
      const poor = yd > 11; // ~10 m; beyond this the number is not trustworthy.

      // Say which of the two things is wrong. "Weak fix" on a fix that is
      // simply somewhere else sends a player hunting for open sky.
      if (fixOffCourse(state.position)) {
        out.className = 'accuracy poor';
        out.textContent = state.course && state.course.mapped === true
          ? 'That fix is not on this course, so no yardages are shown.'
          : 'That fix is not on the course shown here, which is an example one. '
            + 'Map your own course to get yardages where you are.';
      } else {
        out.className = 'accuracy' + (poor ? ' poor' : '');
        out.textContent = poor
          ? 'Weak fix — accurate to about ' + yd + ' yds. Stand in the open and try again.'
          : 'Accurate to about ' + yd + ' yds.';
      }
    },
    err => {
      out.className = 'accuracy poor';
      out.textContent = err.code === err.PERMISSION_DENIED
        ? 'Location permission denied. Enable it in your browser settings.'
        : 'Could not get a location fix. Try again in the open.';
    },
    // maximumAge 0: each tap asks for a new fix. With 10 s the browser could
    // hand back the previous fix, so a player who walked to the ball and
    // tapped again, or who was told "Weak fix ... try again", got the same
    // position and the same numbers a second time.
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

/* -- Phase gating -------------------------------------------------------- */

/* The app ships in phases, and a feature visible before its content is real is
   worse than one that is missing: an unattended status panel and an example
   yardage both teach players to distrust the whole app. Each flag in
   data/club.json → features turns its part on; anything absent stays off, so
   Phase 1 deploys as the static content alone. */
const GATED_CARDS = { status: 'statusCard', weather: 'weatherCard' };

/* Yardage and results have three states, because "built" and "ready" are
   different things: off hides it outright, "preview" shows the tab and says
   what is coming with nothing behind it, true is the real feature. Preview
   exists so a feature can be announced without inventing data to fill the
   space — the whole point of the gate is that a wrong yardage is worse than
   no yardage, and a made-up score worse than no score. */
const modeOf = (flags, f) =>
  flags[f] === true ? 'full' : flags[f] === 'preview' ? 'preview' : 'off';

/* Tolerate a missing element rather than throwing. The shell is cached
   file-by-file, so a deploy can briefly pair new app.js with old index.html;
   an unguarded lookup turns that skew into a blank app instead of a slightly
   wrong one. */
const hide = id => { const el = $(id); if (el) el.classList.add('hidden'); };
const show = id => { const el = $(id); if (el) el.classList.remove('hidden'); };

function applyFeatures(club) {
  const flags = club.features || {};
  const on = f => flags[f] === true;

  // Turning every feature on against invented content is the one thing the
  // gates exist to prevent. The banner is what makes it safe: it says so on
  // screen, above every tab, for as long as the demo data is in place.
  if (club.demo === true) show('demoBanner');

  Object.keys(GATED_CARDS).forEach(f => {
    if (!on(f)) hide(GATED_CARDS[f]);
  });

  // A tab with nothing behind it loses its button as well as its view.
  const hideTab = view => {
    const tab = document.querySelector('.tab[data-view="' + view + '"]');
    if (tab) tab.classList.add('hidden');
    hide('view-' + view);
  };

  const results = modeOf(flags, 'results');
  if (results === 'off') {
    hideTab('results');
  } else if (results === 'preview') {
    show('resultsPreviewCard');
    hide('resultsList');
  }

  const yardage = modeOf(flags, 'yardage');
  if (yardage === 'off') {
    hideTab('yardage');
  } else if (yardage === 'preview') {
    // Announce the feature; show nothing that could be wrong. The live parts
    // stand down, example coordinates included, so there is no banner to
    // explain them away.
    show('yardagePreviewCard');
    ['unmappedBanner', 'mapCard'].forEach(hide);
    const gps = document.querySelector('.gps-card');
    if (gps) gps.classList.add('hidden');
  }

  // Today holds the status, the weather, and a copy of the next scheduled
  // event. With the first two gated off it would only repeat the Schedule
  // tab, so it stands down until it has something of today's to say.
  if (!on('scorecard')) hideTab('card');

  if (!on('status') && !on('weather')) hideTab('today');

  return { status: on('status'), weather: on('weather'), yardage, results,
           scorecard: on('scorecard') };
}

/* -- Tabs ---------------------------------------------------------------- */

/** Wires the tab bar and returns the function that switches to a given tab. */
function initTabs() {
  const tabs = Array.from(document.querySelectorAll('.tab'));

  const activate = tab => {
    tabs.forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.view').forEach(v =>
      v.classList.toggle('hidden', v.id !== 'view-' + tab.dataset.view));
    window.scrollTo(0, 0);
  };

  tabs.forEach(tab => tab.addEventListener('click', () => activate(tab)));
  return activate;
}

/* -- Boot ---------------------------------------------------------------- */

(async function boot() {
  const activateTab = initTabs();

  $('btnLocate').addEventListener('click', locate);

  const step = delta => {
    const holes = state.course && state.course.holes;
    const n = (holes && holes.length) || 0;
    if (!n) return;
    state.holeIndex = (state.holeIndex + delta + n) % n;
    drawHole();
  };
  $('holePrev').addEventListener('click', () => step(-1));
  $('holeNext').addEventListener('click', () => step(1));

  // Current hole for playing it; whole course for working out where you are.
  $('btnMapView').addEventListener('click', () => {
    setMapView(state.mapView !== 'course');
    drawMap();
  });

  $('btnMapRotate').addEventListener('click', () => {
    setMapNorth(!state.mapNorth);
    drawMap();
  });
  loadMapNorth();

  initMapPick();
  initMapTurn();

  // Club data first: it carries the feature flags that decide what renders.
  let club = null;
  try {
    club = await renderClub();
  } catch (e) {
    $('aboutText').textContent = 'Club information unavailable.';
  }

  const live = applyFeatures(club || {});

  // Land on the most useful live tab: today's information when there is any,
  // otherwise the introduction a first-time visitor actually needs.
  const landOn = ['today', 'about', 'schedule', 'yardage', 'results']
    .map(v => document.querySelector('.tab[data-view="' + v + '"]:not(.hidden)'))
    .find(Boolean);
  if (landOn) activateTab(landOn);

  if (live.scorecard) {
    const cfg = (club && club.scorecard) || {};
    let course = null;
    try { course = await loadJSON('data/course.json'); } catch (e) { /* card works without it */ }
    Scorecard.init({ holes: cfg.holes || 9, course: course });
  }

  renderSchedule();
  if (live.status) renderStatus(club);
  if (live.results === 'full') renderResults();
  if (live.yardage === 'full') initYardage();
  if (live.weather && club) {
    renderWeather(club);
    initWeatherRefresh(club);
    initThunder();
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // Whether this page is already being served by a worker. A page with no
    // controller is a first visit: control arriving then is not an update.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;

    /* The shell is served cache-first, so a reload that finds a new worker
       still runs the files it already loaded. The new worker installs,
       skipWaiting()s and claims the page — but app.js has executed by then,
       and nothing short of another load replaces it. That is two reloads to
       see a change, and nobody reloads a golf app twice: they conclude it is
       broken, which is exactly what happened.

       So when control changes hands, load once more. Guarded against a first
       visit, where it would be a pointless extra fetch, and against itself. */
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });

    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
