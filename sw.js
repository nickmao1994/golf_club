// Offline shell. Golf courses have cell dead spots; everything except the live
// weather call is served from cache so the app still works on the back nine.
// Bump this on every deploy that touches a shell file, not just when the list
// below changes. install() re-fetches the whole list as a set, which is what
// keeps index.html, app.css and app.js on the same version; without a bump
// they refresh independently and a visitor can get new JS against old HTML.
const CACHE = 'golfclub-v36';
const SHELL = [
  './', './index.html', './app.css', './app.js', './manifest.webmanifest',
  './map.css', './map.js', './card.js',
  './data/club.json', './data/status.json', './data/schedule.json',
  './data/results.json', './data/course.json'
];

self.addEventListener('install', e => {
  // {cache:'reload'} bypasses the browser's own HTTP cache. Without it addAll
  // can refill a freshly bumped CACHE from the very copies it was bumped to
  // replace — a version bump that silently changes nothing.
  const fresh = SHELL.map(u => new Request(u, { cache: 'reload' }));
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Content under data/. It changes without the app changing. */
const isContent = url =>
  url.origin === location.origin && /\/data\/[^/]+\.(json|csv)$/.test(url.pathname);

/** Try the network, keep what comes back, fall back to the last good copy. */
function networkFirst(request) {
  return fetch(request)
    .then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(request, copy));
      return res;
    })
    .catch(() => caches.match(request));
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Cross-origin weather, and our own content files: network first, falling
  // back to the last good response so a dead spot shows stale data rather
  // than nothing.
  //
  // Content must not be cache-first. Served from cache, an edit only appears
  // on the load *after* the one that fetched it, so the coach updates the
  // status at 7am and the student who checks before leaving sees yesterday's
  // — stamped with yesterday's time, inside the staleness window, and looking
  // entirely authoritative. Stale weather is a nuisance; a stale "open" that
  // reads like today's is a wrong answer given confidently.
  if (url.origin !== location.origin || isContent(url)) {
    e.respondWith(networkFirst(e.request));
    return;
  }

  // Own files: cache first for instant load, refresh in the background.
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
