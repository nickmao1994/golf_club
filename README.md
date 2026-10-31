# School Golf Club — web app

A mobile web app (installable PWA) for a school golf club: club info, daily
course status, weather, schedule, match results, and GPS yardages and a
"you are here" map on the home course.

Web-first by design. No App Store review, no `$99/year`, Android students
included, and updates ship the moment you push a file.

## Why it is built this way

Four constraints drove every decision:

1. **No backend.** All content lives in the JSON files under `data/`. There is
   no database, no auth, no server to pay for, and nothing to break at 2am.
2. **Location never leaves the device.** Yardages are computed in the browser
   from coordinates bundled with the app. Because no location is ever
   transmitted, the app sidesteps the consent and compliance burden that comes
   with collecting minors' location data.
3. **Works offline.** Golf courses have cell dead spots. The service worker
   caches the shell and all course data; GPS is satellite-based and needs no
   signal. Only the weather call wants the network, and it falls back to the
   last good response.
4. **Survives its maintainer graduating.** Anyone who can edit a JSON file can
   keep it running. No build step, no toolchain, no framework upgrades.

## Running it locally

Needs a real HTTP server — `file://` blocks service workers and `fetch`.

```bash
python -m http.server 4173
```

Then open `http://localhost:4173`. In Claude Code, `/run` starts the same
server via `.claude/launch.json`.

Two things cannot be checked from a local server and need a test on a real
HTTPS host:

- **The service worker** (offline caching). Some embedded preview browsers
  refuse to register one at all, so a registration failure locally is not
  evidence that `sw.js` is broken.
- **Geolocation**, which needs HTTPS or `localhost` plus a granted permission
  prompt. Test the yardage tab and the mapper on a phone, on the course.

## Deploying

The whole thing is static, so drop the folder on any static host:

- **GitHub Pages** — push the repo, enable Pages on the branch root. Free, and
  gives you edit history on the content files for nothing.
- **Netlify / Cloudflare Pages** — drag the folder into the dashboard.

Any of these serve over HTTPS, which the install-to-home-screen prompt and
geolocation both require.

## Shipping in phases

Everything in this repo is built, but **built is not the same as ready**. Each
feature needs content that only a human can supply, and a feature shown before
its content is real does active harm: a status panel nobody updated teaches
players to stop reading it, and an example yardage teaches them to stop
trusting the numbers. One of those is a dead panel; the other sends someone at
a green with the wrong club.

So visibility is content-gated, in `data/club.json` → `features`:

```json
"features": { "status": true, "weather": true, "yardage": true, "results": true, "scorecard": true }
```

`false` hides that part completely — the gated cards disappear from the Today
view, and a gated tab loses its button as well as its view, so there is no
empty room to wander into. The app opens on the first tab that still has
something behind it. Nothing here is a code switch; flip a flag when that
phase's content lands.

`yardage` and `results` take a third value, `"preview"`. The tab appears and a
card describes what the feature will do, while everything live behind it
stands down. It lets a feature be announced during Phase 1 without putting a
single invented figure in front of anyone.

- **`"yardage": "preview"`** — the card covers satellite GPS, location never
  leaving the phone, and distance only. No numbers, no map, no geolocation
  prompt, and no "example coordinates" banner, because there are no example
  coordinates on screen to explain away. Set to `true` after the course walk.
- **`"results": "preview"`** — the card says results go up after each match
  rather than live during play. It deliberately promises nothing about
  individual names or scores, because the Phase 0 privacy decision has not
  been made; keep it that way until it has. Set to `true` once the scoring
  format is agreed and the first match is in `data/results.json`.

If the team already scores through Golfgenius, iWanamaker or BlueGolf, skip
the preview: put the link in `externalUrl` and set `results` to `true`.

| Flag | Turn on once | Phase |
|---|---|---|
| — | Club intro, photos, schedule and contacts are real in `data/club.json` and `data/schedule.json` | 1 |
| `weather` | `homeCourse` holds the real course coordinates | 2 |
| `status` | A named person has committed to updating `data/status.json` daily | 2 |
| `yardage` | `"preview"` to announce it now; `true` once `data/course.json` has `"mapped": true` from a real walk | 3–4 |
| `results` | `"preview"` to announce it now; `true` once the scoring format is agreed and the first match is in `data/results.json` | 5 |

With every flag off, the app is exactly the Phase 1 deliverable: club
introduction, photos, schedule and contacts, and nothing that can be wrong.

### Demo mode

The app currently ships with **every feature on and invented content behind
them**, so the whole thing can be shown working before any real content
exists. That is the exact situation the gates were built to prevent, so it is
fenced:

- `data/club.json` → `"demo": true` puts a banner above every tab saying the
  schedule, results, status and yardages are invented.
- Each demo file carries `"_demo": true` and a `_placeholder` note saying to
  delete its contents rather than edit them.

**Turning it off is one edit per file, in this order:** replace the content in
`schedule.json`, `results.json` and `status.json`, then set `demo` to `false`.
Never clear the flag first — a banner that is briefly wrong is recoverable; a
site that silently presents invented match scores as the season's record is
not.

The player names in `results.json` are invented, and are **not** a decision
that student names will be published. That question is still open, and the
Phase 0 privacy answer governs it.

Two things behave "wrong" in the demo on purpose, because they are the guards
working:

- The course status greys out and says "may be out of date" once its
  `updatedAt` passes `staleHours`, which the demo data will do a day after it
  was written.
- The Yardage tab shows its "Course not mapped yet" banner over the example
  course, because `data/course.json` still has `"mapped": false`.

### What Phase 1 still needs

All of it is content, none of it is code. In `data/club.json`:

- `clubName` and `tagline` — one line about the club.
- `about` — the introduction paragraphs. Who the club is for, what a typical
  week looks like, whether beginners are welcome, whether clubs are provided,
  what it costs.
- `contacts` — the coach and captain, with the names and addresses they are
  happy to publish.
- `photos` — add files to the repo and list them with captions. The Photos card
  hides itself while no photo has a `src`, so it never shows an empty grid.
- `homeCourse` — the course name. The coordinates can wait for Phase 2.

And in `data/schedule.json`, the real practices and matches. The schedule
filters out past dates, so the placeholder events will quietly vanish rather
than mislead — which also means the Schedule tab reads "Nothing scheduled yet"
until real ones are added.

The privacy decision from Phase 0 lands here too: whether student names appear
at all. It binds `contacts` and the player names in `data/results.json`.

## Caching: the shell is fast, the content is fresh

[sw.js](sw.js) treats the two halves of the app differently, and the split
matters more than it looks:

- **The shell** (`index.html`, `app.css`, `app.js`, `map.*`, the manifest) is
  **cache-first**. It changes only when someone edits the code, so serving it
  from cache makes the app open instantly and work in a dead spot.
- **Everything under `data/`** is **network-first, falling back to cache**.

That second rule is not an optimisation, it is a correctness fix. Cache-first
returns the stored copy and refreshes in the background, so an edit appears
only on the load *after* the one that fetched it. Applied to content, that
means the coach updates `data/status.json` at 7am, and the student who checks
before leaving sees **yesterday's** status — stamped with yesterday's time,
still inside `staleHours`, and looking entirely authoritative. The staleness
guard cannot catch it, because the data really is only a few hours old; it is
just the wrong day's. Stale weather is a nuisance. A stale "open" that reads
like today's is a wrong answer delivered confidently.

Offline still works: every file in `data/` is precached on install, so a phone
with no signal falls back to the last good copy rather than showing nothing.
Verified by stopping the server and reloading — the app loads, the tabs gate
correctly, and the schedule renders from cache.

### Deploying code changes

**Bump `CACHE` on every deploy that touches a shell file** — not only when the
file list changes. Content files under `data/` need no bump.

Two failure modes make this worth the discipline, both found the hard way:

- **Mixed versions.** Without a bump, each shell file refreshes independently
  on its own second fetch, so a visitor can get new `app.js` against old
  `index.html`. Here that paired a lookup with an element that did not exist
  yet, and the resulting throw took out the whole of `boot()` — no tab
  gating, no schedule. `install()` re-fetches the list as a set, which is what
  keeps the shell on one version.
- **A bump that does nothing.** `cache.addAll` goes through the browser's own
  HTTP cache, so a freshly bumped `CACHE` can be refilled with the very files
  it was bumped to replace. `install()` therefore requests each shell file
  with `{cache: 'reload'}`. Without that, bumping the version silently changes
  nothing and you debug the wrong layer for an hour.

As cheap insurance, `applyFeatures()` tolerates a missing element instead of
throwing, so a version skew degrades the page rather than blanking it.

## Day-to-day maintenance

| File | Holds | Who updates it | How often |
|---|---|---|---|
| `data/status.json` | Open/closed, grass heights, carts, notes — or the fallback, if a sheet is configured | Coach or course contact | Daily, in season |
| `data/schedule.json` | Practices and matches, with optional match lineups | Coach or captain | Weekly |
| `data/results.json` | Match results and cards | Coach or captain | After each match |
| `data/club.json` | Intro text, contacts, photos, course coordinates | Once, then rarely | — |
| `data/course.json` | Hole coordinates and per-hole notes | Mapped once (see below) | — |

### The status sheet

The daily status can come from a Google Sheet instead of `data/status.json`,
so the person updating it edits a labelled cell rather than JSON punctuation.
Google supplies the login, so this needs no backend and no accounts of ours.

1. Make a sheet with two columns, field name and value:

   | field | value |
   |---|---|
   | `updatedAt` | `2026-10-25T07:00:00Z` |
   | `updatedBy` | `Coach` |
   | `open` | `yes` |
   | `cartsAllowed` | `no` |
   | `greenHeightMm` | `3.5` |
   | `roughHeightMm` | `50` |
   | `staleHours` | `18` |
   | `notes` | `Carts path-only, frost delay until 9am` |

   [data/status-example.csv](data/status-example.csv) is exactly this, and is
   what the parser is tested against.

2. **File → Share → Publish to web**, choose that sheet, format **CSV**.
3. Put the published URL in `data/club.json` → `sources.statusCsv`.

`open` and `cartsAllowed` accept yes/no, true/false, on/off or 1/0. A blank
cell becomes "—" rather than a guess. Commas inside a note are fine as long as
the cell is quoted, which Google's export does automatically.

Three things worth knowing before you commit to this:

- **`updatedAt` is the weak point.** A human has to type it, and the whole
  staleness guard hangs off it. If it is missing or unreadable the panel greys
  out and reads "No update date — do not rely on this" rather than passing
  undated information off as current. In Sheets, `Ctrl+;` inserts today's date.
- **A published sheet is world-readable** by anyone with the link. Keep
  student names out of it; course conditions are not sensitive.
- **Students' browsers fetch from Google**, so their IP addresses reach Google
  rather than only your host. Worth a sentence to whoever signs off on
  privacy, given the care taken to keep location on the device.

If the sheet is unreachable, the app falls back to `data/status.json`. That
copy is usually old, but it carries its real timestamp, so it greys out
instead of being passed off as today's.

### The status file is the one real commitment

`data/status.json` is the only part of this app that needs a human every day,
and it is the part most likely to kill it. A status panel showing Tuesday's
information on Friday is worse than no panel at all, so the app **greys itself
out and says so** once `updatedAt` is older than `staleHours` (default 18).

Before shipping, settle who owns this. If nobody will commit to it, delete the
status card and link out to whatever channel the course already posts to —
that is a better product than a stale panel.

## Mapping the course

The hardest dependency in the whole project is hole coordinates. Courses
almost never have them, and commercial course-data APIs cost money and usually
forbid redistribution. Mapping one course yourself takes an afternoon and is
free.

1. Deploy the app (or run the server and open it on your phone over Wi-Fi).
2. Open `tools/map-course.html` on your phone.
3. Walk the course. At each point — tee, green front, centre, back — stand
   still and tap **Record this point**. It averages eight GPS readings and
   discards the worst to cut the error.
4. Tap **Copy JSON** and paste the result over `data/course.json`.

### Seeing it before you walk

Tap **Load demo course** to drop in a generated 9-hole routing. The map fills
in, so you can see what a finished walk looks like and how the tool behaves
without standing on a tee. Tap **Clear demo course** to remove it.

The demo is fenced off from real data: while it is loaded, the export sets
`"mapped": false` and adds `"_demo": true`, so demo coordinates can never be
pasted in and mistaken for a real survey — the app's "not mapped yet" banner
keys off exactly that flag.

### The map while you walk

The mapper draws the same map the app does — both pages load `map.js` and
`map.css` — showing every point recorded so far, you in red, and a ring around
the point you just saved. It redraws on every recording, which is the quickest
way to catch a point saved in the wrong place while you are still standing next
to it. With the demo loaded it is stamped **Demo course — not real
coordinates**, the same fence the export puts on the JSON.

Accuracy notes:

- Aim for a fix under 5 m before recording. Above 10 m the tool warns you.
- Progress is saved in the browser, so you can close the tab between nines.
- Re-recording a point replaces it rather than duplicating it.

Until `data/course.json` has `"mapped": true`, the Yardage tab shows a visible
banner saying the numbers are examples. Do not remove that banner before the
real walk — showing invented yardages is how players stop trusting the app.

### Away matches

Yardages only work on courses you have mapped. School golf plays away matches
at many courses, so either map each one, scope the feature to the home course
and say so plainly, or accept that the tab is empty away from home.

## The map

The Yardage tab draws the hole under a **Where you are** card: the tee, the
green with a bar running front-to-back so its depth and angle show, the dashed
line of play, and you with a ring drawn to the accuracy your phone reports. A
big ring means a weak fix and a soft number — the map says that without a word
of explanation.

- **Current hole or whole course.** The button in the card header switches
  between them. The current hole is turned so the tee shot runs **up the
  screen**, the way a yardage book draws it, with a small needle showing where
  north went; the whole-course view stays north-up with the hole you are on
  ringed in red.
- **The hole follows you.** `autoSelectHole()` already picks the nearest hole
  from your fix, so arriving at a tee is usually enough. Stepping holes with
  the arrows redraws the map too.
- **Off the mapped course**, the map leaves your dot out rather than squashing
  the course to a dot, and says so under the map. That is what an away match
  or a desktop browser's network-guessed "fix" looks like.
- **Unmapped course data** is stamped **Example layout** across the map with a
  dashed border, so a screenshot of the example coordinates can never pass for
  the real course. That stamp and the banner above it both key off
  `"mapped": true` in `data/course.json`.

Implementation notes for whoever inherits this:

- `map.js` is the whole renderer, shared by the app and the mapper, with one
  entry point: `GolfMap.render(svgElement, opts)`. It reads the drawing size
  from the element's `viewBox`, so each page picks its own shape.
- It is inline SVG. No tile layer, no map library, no network call — a tile
  layer would be blank in exactly the dead spots where the map matters, and
  every tile request is a location leak.
- `map.css` holds the colours, all of them CSS variables, which is why the map
  follows light and dark mode with no JavaScript. The host page supplies
  `--green`, `--bg`, `--surface`, `--line` and `--text-dim`.
- Location still never leaves the device: the map is drawn from the same
  in-browser coordinates as the yardages.

## Weather

Uses [Open-Meteo](https://open-meteo.com) — free, no API key, no attribution
requirement, CORS-friendly. Set the course coordinates in
`data/club.json` → `homeCourse` and it works.

It pulls temperature, wind speed and direction, gusts, rain probability, and
sunrise and sunset, and raises a **thunderstorm warning** when storm codes
appear in the current conditions or the next six hours. Sunset is the one a
golfer acts on — it decides whether another nine fits before dark. Lightning is the serious hazard on a golf
course; that alert is deliberate, not decoration.

### Lightning

The storm alert is the one part of this app where being vague could get
someone hurt, so it states the actual protocol rather than "seek shelter":

- **Stop play.** Get inside a building or a hard-topped vehicle, and put the
  clubs down — they are metal.
- **Not safe**, and all commonly believed to be: golf carts, course shelters
  (not grounded), trees, open ground, water, metal fences.
- **Wait 30 minutes from the last thunder**, not from the first. This is the
  part people get wrong, so the app runs the clock for them.

Tapping **Heard thunder?** starts a 30-minute countdown; **Heard it again —
restart** puts a full 30 back on it. The clock stores its *end time* rather
than a remaining duration, so it survives a locked phone, a closed tab, or the
page being reopened — a countdown held in memory would quietly reset itself at
the exact moment it mattered.

Two deliberate choices:

- **The button is always there**, not only when the forecast predicts a storm.
  Thunder is audible long before a forecast catches up, and a student who
  hears it needs the clock then.
- **A running clock is never hidden**, even once the weather refresh comes
  back clear. The forecast failing to predict a storm is not evidence that the
  thunder someone heard was imaginary.

The app does **not** claim to know how far away the lightning is — no free
weather API gives strike distance reliably. It shows the protocol and runs the
clock; a human makes the call. Policy here follows NFHS and state association
guidance (10-mile suspension radius, 30-minute wait, restart on any new
thunder). Check your own district's policy, which may be stricter, and name
the person responsible for watching the weather.

### Keeping it current

The reading is live, but it was fetched once at boot, and a card that ages
silently is the same trap as a stale status panel: a phone left in a bag all
morning would still show dawn's conditions under a stamp that looks current.
So the card **refetches when the page returns to the foreground**, if the last
reading is more than ten minutes old — which is exactly when someone is about
to read it, and costs nothing while the phone sits in a pocket. There is no
polling timer; one would drain the battery over eighteen holes to no purpose.

### The link out

One API reading is not a forecast. It cannot show radar, the next few hours,
or where a storm is tracking — and lightning is the hazard that actually
matters here. So the card ends with **Full forecast and radar →**.

Set `homeCourse.forecastUrl` to choose the service. Left empty, the link is
built from the course coordinates and points at [Windy](https://www.windy.com),
which works anywhere and is strong on wind and rain radar. For a US course,
the National Weather Service page is
`https://forecast.weather.gov/MapClick.php?lat=LAT&lon=LON`; in Canada, use
the Environment Canada page for the nearest city.

The link is also rendered when the API call **fails**, where it is the only
thing left that can help — the card reads "Live weather unavailable" and still
offers the way out.

If you later go native iOS, Apple's WeatherKit is the natural swap.

## Hole notes

Each hole in `data/course.json` can carry a `note`, shown on the Yardage tab
under the distances:

```json
{ "hole": 1, "par": 4, "note": "Bunker left of the landing area. Aim at the right edge — the slope feeds the ball back." }
```

This is the one thing in the app no commercial product can provide: local
knowledge of *this* course. Where the trouble actually is, what the wind does
on the exposed holes, which side to miss on. It costs nothing to carry, needs
no mapping, and is worth more to a player who has never played here than any
yardage.

The mapper does not collect these — write them by hand, one or two sentences,
ideally from whoever has played the course most. A hole with no note hides the
box entirely rather than leaving an empty one, so silence never looks like
"nothing to know here".

## Match-day lineup

A match in `data/schedule.json` can carry a `lineup` — playing order and tee
times — shown on the event in both the Schedule tab and Next up:

```json
"lineup": [
  { "time": "14:00", "player": "A. Chen" },
  { "time": "14:10", "player": "J. Okafor" }
]
```

Worth knowing: no golf app I could find handles high-school lineups well, and
here it is a data-only feature — nothing to build, nothing to maintain.

**It publishes student names on a public page**, so it is governed by the same
Phase 0 privacy decision as the results cards. Leave `lineup` out and the
event renders exactly as before; initials or first names are a middle option.
A match without a lineup is normal, not a gap — the demo's district qualifier
deliberately has none.

## The scorecard

The Card tab keeps a round: strokes, putts, fairway hit and green in
regulation, hole by hole, with running totals.

**It lives in that browser and nowhere else.** No account, no sync, no
backend — the same rule the yardages follow, for the same reason: this app is
used by minors, and data never collected needs no consent, no retention
policy and no breach notification. The practical consequence is that the coach
collects totals the way they always have, by the player reading them out, and
**Copy totals** puts a summary on the clipboard for pasting into the team
chat. Shared live scoring is a different product with a server behind it.

Details worth knowing:

- **It works on any course**, mapped or not, home or away. `scorecard.holes`
  in `data/club.json` sets the length (default 9); once `data/course.json` has
  `"mapped": true` the card follows the real hole count and shows par.
- **Par is only shown for a mapped course.** Example coordinates carry example
  pars, and "+3" against an invented par is just a wrong number.
- **Putts are capped at strokes**, silently corrected rather than argued with.
- **New round asks first.** Losing a card to a mis-tap on the 17th would be
  worse than one extra tap.
- Storage can be unavailable (private mode, blocked site data). The card still
  works for the session; it just will not survive a reload.

`scorecard` is in `features` like everything else, but it needs no content, so
it can be on from day one.

## Rules of golf

The yardage view shows **distance only**. Under Rule 4.3a a distance-measuring
device is permitted for distance, but using slope, wind adjustment, or
club recommendations breaches the rule — general penalty first time,
disqualification the second.

So: if anyone adds elevation-adjusted yardages or club suggestions, it needs a
tournament-mode toggle that disables them. Shipping club advice without one can
get a student disqualified.

## Deliberately not built

- **Live scoring / leaderboards.** The Card tab keeps a private round on the
  player's own phone; what is not built is the *shared* version. It needs a
  backend and accounts. Golf scoring
  also carries real domain complexity — match vs. stroke play, handicaps,
  stableford, top-4-of-5 team scoring. Check whether the team already uses
  Golfgenius, iWanamaker or BlueGolf and link to it via `externalUrl` in
  `data/results.json` instead of rebuilding it.
- **Teammate location sharing.** Turns a club app into a minor-tracking app
  with serious consent requirements. Not worth it.
- **Push notifications.** Needs a backend and, on iOS, home-screen install.
  The existing group chat already does announcements well.
- **A Google Sheet as CMS.** Worth doing if the coach would rather edit a
  spreadsheet than JSON: publish the sheet as CSV and point the fetchers at it.
  The data shapes in `data/` are designed to map onto sheet columns.

## Layout

```
index.html              App shell; five tabs, shown as their content goes live
app.css                 Styles; high contrast and large tap targets for outdoor use
app.js                  All logic: rendering, weather, haversine yardages
card.js                 Scorecard: strokes, putts, fairways, greens; local only
map.js                  Inline-SVG course map, shared by the app and the mapper
map.css                 Map colours; CSS variables, so it follows light/dark
sw.js                   Offline caching (bump CACHE when the shell file list changes)
                        Shell cache-first, data/*.json network-first — see Caching
manifest.webmanifest    Install-to-home-screen metadata
data/*.json             All content
data/status-example.csv The status sheet layout, and the parser's test case
tools/map-course.html   GPS coordinate recorder, demo course, same map
icons/                  Placeholder icons — replace with real artwork
```

`icons/` holds generated placeholders. Swap in real artwork at 192px and 512px
before anyone installs this to a home screen.

## The example course

Until someone walks the real course, `data/course.json` holds a real one
instead: **Pebble Beach Golf Links**, all eighteen holes, with an example ball
sitting in play on whichever hole you are looking at.

This is deliberate. The alternative — made-up coordinates near the school —
produced a Yardage tab that showed three dashes, an empty map and an
instruction to go outside, which demonstrates nothing and reviews badly. A real
course with real geometry shows exactly what the feature does: step through the
holes, watch the distances change, see the map redraw down the line of play.

**None of it pretends to be the club's course.** Four separate things say so,
and all four are driven by `"mapped": false`:

- the **Course not mapped yet** banner, which names the example course and
  credits the data;
- **Example layout** watermarked across the map, with a dashed border;
- the line under the yardages: *Example ball on an example course — not a GPS
  fix*;
- par stays off the scorecard, because example coordinates carry example pars.

### The example ball

`demoPlayer()` in `app.js` puts a ball partway down the hole — 32% for a par 3,
64% for a par 4, 74% for a par 5 — and 14 yards off the centre line, because
nobody's ball is ever exactly on it. Step to another hole and it moves with
you, so every hole demonstrates itself.

The distances from it are not special-cased. They run through the same
`distanceYards()` as a real fix, which is the point: what you see in the demo
is what the student sees on the course.

It carries **no accuracy value**, so the map draws the dot without a ring. An
accuracy ring means a GPS fix, and this is not one. Tap **Locate me** and a
real fix replaces it — `state.demoFix` goes false, the ring appears, the
wording changes, and the example ball never comes back for that session.

### Where the data came from

Hole centre-lines and green outlines are from **OpenStreetMap**, ©
OpenStreetMap contributors, under the
[ODbL](https://www.openstreetmap.org/copyright). The licence asks for that
credit to travel with the data, so it lives in `data/course.json` as
`attribution` and the app prints it under the banner — if you replace the
course with your own survey, delete that field and the line disappears.

Derivation, for anyone who needs to redo it:

- **path** — the whole `golf=hole` way, oriented tee-first;
- **tee** — first node of each `golf=hole` way;
- **centre** — centroid of the matching `golf=green` polygon;
- **front** and **back** — that polygon's nearest and furthest vertices from
  the tee, which is why green depths come out at a realistic 20–37 yards;
- **cardYards** — measured tee to green centre, so it runs a few yards under
  the printed card, which measures from the championship tee along the line of
  play.

Two traps worth knowing if you map another course this way. Hole ways are
*mostly* drawn tee-to-green but not always, and a tee usually sits right beside
the previous hole's green — so "nearest green to either end" assigns the wrong
green. The fix is a global unique assignment: every hole gets its own green,
cheapest matches first, nothing within 60 yards reused. The pars summing to 72
and no duplicate greens is the check that it worked.

### Replacing it

Walk your course with `tools/map-course.html`, paste the exported JSON over the
`holes` array, set `"mapped": true`, and drop the `_example`, `_source` and
`attribution` fields. Also fix `homeCourse.latitude` / `longitude` in
`data/club.json` — they currently point at Pebble Beach so the weather card
matches the example layout, which means the app is forecasting the wrong
coastline until you change them.

## Why the map draws the hole's route

Each hole in `data/course.json` can carry a `path`: the hole's centre-line,
tee first, with a point at every bend. Two points for a straight par 3, five
for the 18th.

Without it the map has only four points — tee, front, centre, back — and the
single-hole view rotates so the tee shot points up and scales to fit. The
arithmetic is different for every hole, but the picture is not: the tee lands
at the bottom of the frame and the green at the top, every time. Eighteen holes
render as the same diagram at eighteen different scale-bar readings, and it
looks like the map is not redrawing when in fact it is.

The `path` is what makes a hole look like itself. The 1st bends right, the 8th
kinks over the cliff inlet, the 18th sweeps left along the sea, the par 3s run
straight. Three things follow from it:

- **The hole's extent includes the bend**, so a hole that swings wide no longer
  draws its corner off the edge of the frame.
- **The view rotates on the tee shot** — `path[1]`, the corner — not on the
  straight line to the green. Lining up on the green turns a dogleg sideways in
  the frame and hides the bend that makes it that hole.
- **A soft corridor band** is drawn under the dashed line of play, so the shape
  reads at a glance. Single-hole view only: at whole-course scale eighteen
  bands overlap into a smear. It is only drawn where there is a real `path`,
  because a band straight from tee to green would be claiming corridor the data
  does not have.

The example ball follows the route too, not the straight line. At 64% of the
straight line the 8th puts it over the cliff, which is a poor advertisement for
a distance feature.

`path` is optional throughout. A hole without one falls back to a straight
tee-to-green line and loses only the band — so a course mapped with
`tools/map-course.html`, which records the four points and not the route, still
works exactly as before.

## Bunkers

124 of them, from the same OpenStreetMap query as the rest, stored per hole in
`data/course.json` as `bunkers`: a list of closed outlines.

**Single-hole view only.** At whole-course scale a hundred and twenty-four
bunkers is a sand-coloured texture over the routing, not information. They draw
on top of the fairway corridor they sit in and under the dashed line of play,
so the route still reads across them.

**Simplified by size.** The vertex budget is the bunker's perimeter over seven,
clamped to 5–12 — a pot bunker gets five points, a waste area twelve. A fixed
budget was the first attempt and it was wrong in both directions: big bunkers
came out as spikes, small ones carried detail invisible at a yard per SVG unit.
Round joins on the stroke soften what the budget still leaves behind. 942
points in all, which is about 7KB of the file.

**Sand has its own colours**, `--map-sand` and `--map-sand-edge` in `map.css`,
warm and pale in light mode and dropped to a muted olive in the dark — at the
light value a hole with ten bunkers glows.

25 of the 149 bunkers in the area were dropped: they belong to The Hay or the
practice ground, and sit more than 70 yards from any hole's centre-line. That
70-yard cap is also what keeps a neighbouring hole's sand off your map.

They are drawn, not measured. There are no carry or layup distances to them —
that was declined earlier, and adding it later is a data question, not a
drawing one: the outlines are already there to measure from.

`bunkers` is optional, like `path`. A hole without it simply draws no sand, so
a course mapped with `tools/map-course.html` is unaffected.

## Picking a hole off the course map

On the whole-course map, tapping a hole's number goes to that hole: the
yardages, the hole map and the example ball all follow, and the view switches
back to the single hole. The toggle is right there to go back, so a mis-tap
costs one tap.

The number itself is 11px, which is not something a thumb can hit. What
actually gets tapped is an invisible disc over the tee and its number —
`.hole-hit`, 35 CSS px across. It is filled `transparent` rather than `none`,
because `none` lets pointer events straight through to whatever is behind.

Two details that are easy to get wrong:

- The hit discs are collected while the holes are drawn and appended **last**,
  after the "you" dot and the scale bar. Appended in place, anything drawn
  afterwards sits on top of one and swallows the tap.
- `map.js` only draws them when the caller passes `pick`, and it has no idea
  what a tap means — it tags each disc `data-hole` and `app.js` delegates one
  click listener on the SVG. That keeps `tools/map-course.html`, which shares
  the renderer, completely unaffected.

**Pointer only, deliberately.** Every hole is already reachable from the
‹ › buttons, so the keyboard path is complete without this; eighteen extra
tab stops inside a map would make that path worse, not better.

## A fix that is not on this course

`fixOffCourse()` in `app.js` suppresses the yardages — all three show
— when the GPS fix is more than 875 yards (the 800 m the map already uses)
from every mapped point on the course.

This was found by testing, not by design. A fix in Manhattan against the Pebble
Beach example layout put **4,524,321** in the big green numerals. The map was
already correct, refusing to draw the dot and saying so; the yardages went on
reporting the number with complete confidence, which is the exact failure this
whole app is built to avoid. It is reachable two ways that matter: an away
match on a course nobody has mapped, and a desktop browser guessing position
from the network.

The accuracy line names which of the two things is wrong, because they need
different responses — "weak fix" on a fix that is simply somewhere else sends
a player hunting for open sky:

- **off the course** → *That fix is not on this course, so no yardages are
  shown.* (On an example layout it says so and points at the mapper instead.)
- **on the course, poor accuracy** → *Weak fix — accurate to about N yds.*

One case is deliberately left alone: a fix that is on the property but far from
the hole you happen to be looking at still shows its real distance, which can
be 1,500 yards or more. That number is correct — you are that far from that
green — and `autoSelectHole()` only moves you within 600 yards, so standing on
the range while hole 5 is showing reads oddly but never lies. Suppressing it
would mean refusing to answer "how far is the 18th from here", which is a fair
question.

## How old the weather actually is

The card used to stamp itself `'Updated ' + now`, which was a lie in two
directions, and the second one is the dangerous one:

- Open-Meteo's readings are **hourly**, so they are already old when they
  arrive — the stamp was up to an hour out before anything went wrong.
- The service worker serves `data/` and the forecast **network-first with a
  cache fallback**, so with no signal the `fetch` *succeeds* and hands back the
  last good response. A fetch resolving proves nothing about the data being
  current, and the card would print hours-old conditions over the word
  "Updated" and the current minute.

That is the same failure the course-status card has always guarded against, and
it matters more here: wind and storm risk are what a decision to keep playing
turns on.

`wxObservedAt()` takes the time from the payload instead. The API is asked for
the course's own timezone, so it answers with that place's wall clock plus
`utc_offset_seconds`. Reading the wall clock as if it were UTC and then undoing
the offset gives real UTC, with neither the phone's clock setting nor the
viewer's timezone involved — which matters when the course on screen is three
time zones from nobody in particular. (The HTTP `Date` header would have been
simpler; Open-Meteo does not expose it to CORS, so it is unreadable.)

Past 90 minutes the card greys out and the stamp becomes *Readings from N hours
ago — may be out of date*, exactly like the status card. 90 rather than 60 so
normal hourly data never cries wolf.

**No timer.** The stamp repaints when the page returns to the foreground and
when the Today tab is opened — both moments a person is about to read it. A
four-hour round is no place for a polling interval, and the age is only
interesting to someone looking at it.

## Why the yardage is large

Standing by the range with hole 5 on screen, the distance reads 1,735. That is
correct — you really are that far from the 5th green — and suppressing it
would mean refusing to answer "how far is that from here", which is a fair
question. What was missing was *why* it is large.

`drawHoleHint()` adds one line under the accuracy note: **You are nearest hole
5.** It appears only when there is a real fix, it is on the course, and the
nearest hole is not the one being shown. The example ball never triggers it,
and neither does an off-course fix, which already has its own message.

That turns a puzzling number into an orientation, and the map's hole numbers
are one tap away from acting on it.
# golf_club
