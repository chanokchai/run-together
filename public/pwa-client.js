(() => {
  const DB_NAME = 'run-together-offline-v1';
  const DB_VERSION = 1;
  const CHANNEL_NAME = 'run-together-offline-v1';
  let databasePromise;
  let currentGeneration = null;
  let captureBlocked = false;
  const originalFetch = window.fetch.bind(window);

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const state = database.objectStoreNames.contains('state')
          ? request.transaction.objectStore('state')
          : database.createObjectStore('state', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('snapshots')) database.createObjectStore('snapshots');
        state.put({ id: 'control', generation: 0, roomId: null });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error('Offline storage is unavailable.'));
      request.onblocked = () => reject(new Error('Offline storage upgrade is blocked.'));
    });
    return databasePromise;
  }

  function readControl(database) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('state', 'readonly');
      const request = transaction.objectStore('state').get('control');
      request.onsuccess = () => resolve(request.result ?? { id: 'control', generation: 0, roomId: null });
      request.onerror = () => reject(request.error ?? new Error('Offline state could not be read.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Offline state read was aborted.'));
    });
  }

  function dispatchClear(generation) {
    currentGeneration = Math.max(currentGeneration ?? 0, generation);
    window.dispatchEvent(new CustomEvent('run-together:snapshot-cleared', { detail: { generation } }));
  }

  function announceClear(generation) {
    dispatchClear(generation);
    try { channel?.postMessage({ type: 'snapshot-cleared', generation }); } catch {}
    try { navigator.serviceWorker?.controller?.postMessage({ type: 'snapshot-cleared', generation }); } catch {}
  }

  async function changeScope(roomId) {
    if (!('indexedDB' in window)) return null;
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['state', 'snapshots'], 'readwrite');
      const state = transaction.objectStore('state');
      const snapshots = transaction.objectStore('snapshots');
      const controlRequest = state.get('control');
      const snapshotRequest = snapshots.get('latest');
      let control;
      let snapshot;
      let hasControl = false;
      let hasSnapshot = false;
      let generation;
      let cleared = false;
      const commitScope = () => {
        if (!hasControl || !hasSnapshot) return;
        const existingControl = control ?? { id: 'control', generation: 0, roomId: null };
        generation = existingControl.generation + 1;
        state.put({ id: 'control', generation, roomId });
        if (snapshot && (!sanitizeSnapshot(snapshot) || snapshot.room.id !== roomId)) {
          snapshots.delete('latest');
          cleared = true;
        }
      };
      controlRequest.onsuccess = () => {
        control = controlRequest.result;
        hasControl = true;
        commitScope();
      };
      snapshotRequest.onsuccess = () => {
        snapshot = snapshotRequest.result;
        hasSnapshot = true;
        commitScope();
      };
      controlRequest.onerror = () => { transaction.abort(); };
      snapshotRequest.onerror = () => { transaction.abort(); };
      transaction.oncomplete = () => {
        currentGeneration = generation;
        captureBlocked = captureBlocked || navigator.onLine === false;
        if (cleared) announceClear(generation);
        resolve(generation);
      };
      transaction.onerror = () => reject(transaction.error ?? new Error('Offline room scope could not be changed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Offline room scope change was aborted.'));
    });
  }

  async function clearSnapshot(_reason = 'clear') {
    captureBlocked = true;
    if (!('indexedDB' in window)) return null;
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['state', 'snapshots'], 'readwrite');
      const state = transaction.objectStore('state');
      const controlRequest = state.get('control');
      let generation;
      controlRequest.onsuccess = () => {
        const control = controlRequest.result ?? { id: 'control', generation: 0, roomId: null };
        generation = control.generation + 1;
        state.put({ id: 'control', generation, roomId: null });
        transaction.objectStore('snapshots').delete('latest');
      };
      controlRequest.onerror = () => { transaction.abort(); };
      transaction.oncomplete = () => { currentGeneration = generation; announceClear(generation); resolve(generation); };
      transaction.onerror = () => reject(transaction.error ?? new Error('Offline data could not be cleared.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Offline data clearing was aborted.'));
    });
  }

  function sanitizeSnapshot(value) {
    if (!value || value.schemaVersion !== 1 || typeof value.savedAt !== 'string'
      || !value.room || typeof value.room.id !== 'string' || !Number.isSafeInteger(value.room.displayNumber)
      || typeof value.room.title !== 'string' || typeof value.room.venue !== 'string' || typeof value.room.time !== 'string'
      || !value.week || typeof value.week.monday !== 'string' || typeof value.week.sunday !== 'string'
      || !Number.isSafeInteger(value.week.isoWeek) || !Number.isSafeInteger(value.week.isoWeekYear)
      || !Array.isArray(value.days) || value.days.length !== 7 || !Array.isArray(value.events)) return null;
    const days = [];
    for (const day of value.days) {
      if (!day || typeof day.date !== 'string' || !Number.isSafeInteger(day.voteCount) || day.voteCount < 0
        || !Array.isArray(day.voterNames) || !day.voterNames.every((name) => typeof name === 'string')) return null;
      days.push({ date: day.date, voteCount: day.voteCount, voterNames: [...day.voterNames] });
    }
    const events = [];
    for (const event of value.events) {
      if (!event || typeof event.date !== 'string' || !['proposed', 'scheduled'].includes(event.status)) return null;
      events.push({ date: event.date, status: event.status });
    }
    return {
      schemaVersion: 1,
      savedAt: value.savedAt,
      room: { id: value.room.id, displayNumber: value.room.displayNumber, title: value.room.title, venue: value.room.venue, time: value.room.time },
      week: { monday: value.week.monday, sunday: value.week.sunday, isoWeek: value.week.isoWeek, isoWeekYear: value.week.isoWeekYear },
      days,
      events,
    };
  }

  async function saveSnapshot(value, expectedGeneration) {
    const snapshot = sanitizeSnapshot(value);
    if (!snapshot || captureBlocked || navigator.onLine === false || !Number.isSafeInteger(expectedGeneration)) return false;
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['state', 'snapshots'], 'readwrite');
      const controlRequest = transaction.objectStore('state').get('control');
      let saved = false;
      controlRequest.onsuccess = () => {
        const control = controlRequest.result;
        if (control?.generation === expectedGeneration && control.roomId === snapshot.room.id
          && !captureBlocked && navigator.onLine !== false) {
          transaction.objectStore('snapshots').put(snapshot, 'latest');
          saved = true;
        }
      };
      controlRequest.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve(saved);
      transaction.onerror = () => reject(transaction.error ?? new Error('Offline snapshot could not be saved.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Offline snapshot save was aborted.'));
    });
  }

  async function getLatestSnapshot() {
    if (!('indexedDB' in window)) return null;
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('snapshots', 'readonly');
      const request = transaction.objectStore('snapshots').get('latest');
      request.onsuccess = () => resolve(sanitizeSnapshot(request.result));
      request.onerror = () => reject(request.error ?? new Error('Offline snapshot could not be read.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Offline snapshot read was aborted.'));
    });
  }

  async function generation() {
    if (!('indexedDB' in window)) return null;
    const control = await readControl(await openDatabase());
    currentGeneration = control.generation;
    return control.generation;
  }

  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;
  if (channel) channel.onmessage = ({ data }) => {
    if (data?.type === 'snapshot-cleared' && Number.isSafeInteger(data.generation)) dispatchClear(data.generation);
  };
  navigator.serviceWorker?.addEventListener('message', ({ data }) => {
    if (data?.type === 'snapshot-cleared' && Number.isSafeInteger(data.generation)) dispatchClear(data.generation);
  });

  window.runTogetherPwa = Object.freeze({
    beginRoomScope: changeScope,
    clearSnapshot,
    getLatestSnapshot,
    generation,
    pauseCapture() {
      captureBlocked = true;
    },
    resumeOnline() {
      if (navigator.onLine === false) return false;
      captureBlocked = false;
      delete document.documentElement.dataset.pwaOffline;
      document.querySelector('#pwa-offline-notice')?.remove();
      document.querySelectorAll('#protected-content').forEach((element) => { element.inert = false; });
      return true;
    },
    saveSnapshot,
  });

  function isMutation(input, init) {
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  }

  window.fetch = async (input, init) => {
    const mutation = isMutation(input, init);
    const requestUrl = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if (mutation && !navigator.onLine) {
      window.dispatchEvent(new CustomEvent('run-together:offline-write-blocked', { detail: { path: requestUrl.pathname } }));
      const error = new Error('Offline changes are read-only and were not sent or queued.');
      error.name = 'OfflineMutationBlockedError';
      throw error;
    }
    if (mutation && (requestUrl.pathname === '/api/auth/login' || requestUrl.pathname === '/api/auth/register')) {
      await clearSnapshot('identity-change');
    }
    let response;
    try {
      response = await originalFetch(input, init);
    } catch (error) {
      if (mutation && requestUrl.pathname === '/api/auth/logout') await clearSnapshot('logout-network-failure');
      throw error;
    }
    if (requestUrl.pathname.startsWith('/api/') && [401, 403, 404].includes(response.status)) {
      await clearSnapshot('authorization-loss');
    }
    return response;
  };

  function showOfflineNotice() {
    if (document.documentElement.dataset.offlineShell === 'true') return;
    document.documentElement.dataset.pwaOffline = 'true';
    document.querySelectorAll('#rooms-content').forEach((element) => { element.hidden = true; });
    document.querySelectorAll('#protected-content').forEach((element) => {
      if (element.dataset.roomId) element.inert = true;
      else element.hidden = true;
    });
    let banner = document.querySelector('#pwa-offline-notice');
    if (!banner) {
      banner = document.createElement('p');
      banner.id = 'pwa-offline-notice';
      banner.setAttribute('role', 'status');
      banner.textContent = 'Offline / ออฟไลน์ — read-only. Open the saved week to view stale data. / ดูได้อย่างเดียว เปิดสัปดาห์ที่บันทึกไว้เพื่อดูข้อมูลเก่า';
      const roomId = document.querySelector('#protected-content')?.dataset.roomId;
      const link = document.createElement('a');
      link.href = `/offline?scope=${roomId ? encodeURIComponent(roomId) : 'none'}`;
      link.dataset.preserveOfflineSnapshot = 'true';
      link.textContent = 'Open saved week / เปิดสัปดาห์ที่บันทึกไว้';
      link.style.cssText = 'display:block;margin-top:.35rem;color:#145da0';
      banner.append(link);
      banner.style.cssText = 'position:sticky;top:0;z-index:9999;margin:0;padding:.8rem 1rem;background:#fef3c7;color:#422006;border:2px solid #854d0e;font-weight:800';
      document.body.prepend(banner);
    }
  }

  function enterOfflineMode() {
    captureBlocked = true;
    showOfflineNotice();
  }

  window.addEventListener('offline', enterOfflineMode);
  window.addEventListener('online', () => {
    captureBlocked = true;
    if (document.documentElement.dataset.offlineShell === 'true') return;
    if (document.querySelector('#protected-content')?.dataset.roomId) window.dispatchEvent(new Event('run-together:online'));
    else location.reload();
  });
  window.addEventListener('pageshow', () => {
    if (navigator.onLine === false) enterOfflineMode();
    else if (document.documentElement.dataset.offlineShell !== 'true') {
      if (/^\/vote\/[0-9a-f-]+$/i.test(location.pathname)) captureBlocked = true;
      else {
        captureBlocked = false;
        void clearSnapshot('non-room-page').catch(() => {});
      }
    }
  });

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('a[href]');
    const roomId = document.querySelector('#protected-content')?.dataset.roomId;
    if (!link || !roomId || link.target && link.target !== '_self') return;
    if (link.dataset.preserveOfflineSnapshot === 'true') return;
    const destination = new URL(link.href, location.href);
    const currentPath = `/vote/${roomId}`;
    if (destination.origin !== location.origin || destination.pathname === currentPath) return;
    event.preventDefault();
    void clearSnapshot('room-navigation').finally(() => { location.assign(destination.href); });
  }, true);

  document.addEventListener('DOMContentLoaded', () => {
    if (document.documentElement.dataset.offlineShell !== 'true' && (location.pathname === '/' || location.pathname === '/register')) {
      void clearSnapshot('identity-page').catch(() => {});
    }
    if (navigator.onLine === false) enterOfflineMode();
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('/sw.js?v=issue-9-pwa-1', { scope: '/', updateViaCache: 'none' }).catch(() => {});
    }
  }, { once: true });
})();
