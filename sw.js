// Krane AI — Service Worker v1.0
// GitHub Pages deploy — notifiche push native abilitate

const CACHE_NAME = 'krane-v5';
const CACHE_ASSETS = ['./', './index.html', './css/style.css', './js/app.js', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Passa sempre le chiamate API GAS senza cache
  if (e.request.url.includes('script.google.com')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// Notifiche push
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: 'Krane AI', body: 'Nuova notifica' };
  e.waitUntil(
    self.registration.showNotification(data.title || 'Krane AI', {
      body: data.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: 'krane-notif',
      renotify: true,
      data: data
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(cls => {
      if (cls.length) return cls[0].focus();
      return clients.openWindow('/krane-app/');
    })
  );
});
