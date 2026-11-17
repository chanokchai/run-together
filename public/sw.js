const CACHE_PREFIX = 'run-together-pwa-shell-';
const CACHE_NAME = 'run-together-pwa-shell-v2';
const SHELL_ASSETS = [
  '/offline',
  '/offline.css?v=issue-9-pwa-2',
  '/offline.js?v=issue-9-pwa-2',
  '/pwa-client.js?v=issue-9-pwa-2',
  '/manifest.webmanifest',
  '/icons/run-together-192.png',
  '/icons/run-together-512.png',
];
const SHELL_ASSET_KEYS = new Set(SHELL_ASSETS);
const OFFLINE_DATABASE = 'run-together-offline-v1';

function notifyClients(generation) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    for (const client of windows) client.postMessage({ type: 'snapshot-cleared', generation });
  });
}

function clearSnapshotAfterAuthorizationLoss() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('state')) database.createObjectStore('state', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('snapshots')) database.createObjectStore('snapshots');
      request.transaction.objectStore('state').put({ id: 'control', generation: 0, roomId: null });
    };
    request.onerror = () => reject(request.error ?? new Error('Offline state could not be opened.'));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(['state', 'snapshots'], 'readwrite');
      const controlStore = transaction.objectStore('state');
      const controlRequest = controlStore.get('control');
      let generation;
      controlRequest.onsuccess = () => {
        const control = controlRequest.result ?? { id: 'control', generation: 0, roomId: null };
        generation = control.generation + 1;
        controlStore.put({ id: 'control', generation, roomId: null });
        transaction.objectStore('snapshots').delete('latest');
      };
      controlRequest.onerror = () => transaction.abort();
      transaction.oncomplete = () => {
        database.close();
        void notifyClients(generation).catch(() => {}).finally(resolve);
      };
      transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('Offline state could not be cleared.')); };
      transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('Offline state clearing was aborted.')); };
    };
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const path of SHELL_ASSETS) {
      const response = await fetch(new Request(new URL(path, self.location.origin), {
        cache: 'reload',
        credentials: 'omit',
      }));
      if (!response.ok) throw new Error(`Could not cache offline shell asset: ${path}`);
      await cache.put(path, response);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'snapshot-cleared' || !Number.isSafeInteger(event.data.generation)) return;
  event.waitUntil((async () => {
    await notifyClients(event.data.generation);
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.method !== 'GET' && request.method !== 'HEAD' && self.navigator.onLine === false) {
    event.respondWith(new Response(JSON.stringify({ code: 'OFFLINE_READ_ONLY', message: 'Offline changes are not sent or queued.' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    }));
    return;
  }

  const assetKey = `${url.pathname}${url.search}`;
  if (request.method === 'GET' && SHELL_ASSET_KEYS.has(assetKey)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(assetKey);
      if (cached) return cached;
      if (self.navigator.onLine === false) return new Response('', { status: 504, headers: { 'cache-control': 'no-store' } });
      return fetch(request);
    })());
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      if (self.navigator.onLine === false) {
        return (await cache.match('/offline'))
          ?? new Response('Offline shell unavailable. Reconnect and reopen Run Together.', { status: 503, headers: { 'cache-control': 'no-store' } });
      }
      try {
        const response = await fetch(request);
        if ([401, 403, 404].includes(response.status)) await clearSnapshotAfterAuthorizationLoss().catch(() => {});
        return response;
      } catch {
        return (await cache.match('/offline'))
          ?? new Response('Offline shell unavailable. Reconnect and reopen Run Together.', { status: 503, headers: { 'cache-control': 'no-store' } });
      }
    })());
  }
});
