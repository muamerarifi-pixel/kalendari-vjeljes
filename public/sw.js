// Kalendari i Vjeljes — service worker
// Rrjeti i pari: sa herë që ka internet merret versioni më i ri;
// pa internet (ose kur rrjeti vonon më shumë se 4 sekonda) përdoret kopja e ruajtur.
// Kur ndryshon aplikacionin, ndrysho VERSION këtu: telefonat e marrin vetë ndryshimin.
const VERSION = '1.1-2026-10-24';
const CACHE = 'vjelja-' + VERSION;
const TIMEOUT_MS = 4000;

const ASSETS = [
  './',
  './crops.json',
  './manifest.webmanifest',
  './icons/badge-96.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './fonts/alegreya-latin-500-normal.woff2',
  './fonts/alegreya-latin-ext-500-normal.woff2',
  './fonts/alegreya-latin-700-normal.woff2',
  './fonts/alegreya-latin-ext-700-normal.woff2',
  './fonts/alegreya-sans-latin-400-normal.woff2',
  './fonts/alegreya-sans-latin-ext-400-normal.woff2',
  './fonts/alegreya-sans-latin-400-italic.woff2',
  './fonts/alegreya-sans-latin-ext-400-italic.woff2',
  './fonts/alegreya-sans-latin-500-normal.woff2',
  './fonts/alegreya-sans-latin-ext-500-normal.woff2',
  './fonts/alegreya-sans-latin-700-normal.woff2',
  './fonts/alegreya-sans-latin-ext-700-normal.woff2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(ASSETS.map((u) =>
        fetch(new Request(u, { cache: 'reload' }))
          .then(clean)
          .then((res) => { if (!res.ok) throw new Error('Nuk u ruajt: ' + u); return cache.put(u, res); })
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('vjelja-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

const HOME_URL = new URL('./', self.registration.scope).href;

// Disa hoste ridrejtojnë /index.html → /. Një përgjigje e ridrejtuar nuk mund t'i jepet faqes,
// prandaj e kopjojmë si përgjigje të thjeshtë.
async function clean(res) {
  if (!res || !res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await clean(await fetch(request));
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const isPage = request.mode === 'navigate';
  const net = fetch(isPage ? request.url : request, isPage ? { cache: 'no-cache', credentials: 'same-origin' } : { cache: 'no-cache' })
    .then(clean)
    .then((res) => {
      if (res && res.ok) {
        cache.put(request, res.clone());
        if (isPage) cache.put(HOME_URL, res.clone());
      }
      return res;
    });
  net.catch(() => {});

  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS));
  try {
    const res = await Promise.race([net, timeout]);
    if (res && res.ok) return res;
    throw new Error('bad response');
  } catch (err) {
    const hit = (await cache.match(request, { ignoreSearch: true })) ||
      (isPage ? await cache.match(HOME_URL) : undefined);
    if (hit) return hit;
    return net;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // njoftimet: gjithmonë drejt serverit
  if (url.pathname.includes('/fonts/') || url.pathname.includes('/icons/')) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});

// ---------- Njoftimet ----------
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Kalendari i Vjeljes';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'Ka diçka të re për t’u vjelë.',
    icon: './icons/icon-192.png',
    badge: './icons/badge-96.png',
    tag: data.tag || 'vjelja',
    lang: 'sq',
    data: { url: data.url || './' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        if (w.url !== target && 'navigate' in w) { try { await w.navigate(target); } catch (e) {} }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

// Kur shfletuesi e ndërron abonimin, e ri-regjistrojmë me të njëjtat zgjedhje.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const old = event.oldSubscription;
    const key = old && old.options ? old.options.applicationServerKey : null;
    let sub = event.newSubscription;
    if (!sub && key) sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    if (!sub) return;
    await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: sub.toJSON(), oldEndpoint: old ? old.endpoint : '' })
    });
  })());
});
