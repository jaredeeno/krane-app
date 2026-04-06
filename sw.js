// Krane AI — Service Worker v2.0 (FCM Push)
// GitHub Pages deploy — push notifications via Firebase Cloud Messaging

importScripts('https://www.gstatic.com/firebasejs/10.14.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.0/firebase-messaging-compat.js');

// Firebase config — iniettata dal frontend via message
let _fbInitialized = false;

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'FIREBASE_CONFIG' && !_fbInitialized) {
    firebase.initializeApp(e.data.config);
    _fbInitialized = true;

    const messaging = firebase.messaging();
    messaging.onBackgroundMessage(payload => {
      const n = payload.notification || {};
      self.registration.showNotification(n.title || 'Krane AI', {
        body: n.body || 'Nuova notifica',
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag: 'krane-push',
        renotify: true,
        data: payload.data || {}
      });
    });
  }
});

const CACHE_NAME = 'krane-v7';
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
  if (e.request.url.includes('script.google.com')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// Push diretto (fallback se Firebase non inizializzato)
self.addEventListener('push', e => {
  if (_fbInitialized) return; // Firebase gestisce gia
  const data = e.data ? e.data.json() : { title: 'Krane AI', body: 'Nuova notifica' };
  e.waitUntil(
    self.registration.showNotification(data.title || 'Krane AI', {
      body: data.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: 'krane-push',
      renotify: true
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
