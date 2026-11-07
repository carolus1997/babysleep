/* Avisos de la app (web push). Lo carga el service worker principal con importScripts.
   Este archivo no tiene acceso a los datos de la app: solo muestra el aviso y abre la app. */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {};
  }
  const options = {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.tag || 'feed-reminder',
    renotify: true,
    data: { url: data.url || './?feed=ask', kind: data.kind || 'feed' },
  };
  // Los botones de «Pecho / Biberón» solo tienen sentido en el aviso de toma. Dependen de que el sistema los muestre; si no, basta con tocar el aviso.
  if (!data.kind || data.kind === 'feed') {
    options.actions = [
      { action: 'breast', title: 'Pecho' },
      { action: 'bottle', title: 'Biberón' },
    ];
  }
  event.waitUntil(self.registration.showNotification(data.title || 'BabySleep', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.action; // '' si se toca el aviso en sí
  const base = (event.notification.data && event.notification.data.url) || './?feed=ask';
  const target = new URL(action === 'breast' || action === 'bottle' ? './?feed=' + action : base, self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
          await c.focus();
          const q = new URL(target).searchParams;
          if (q.get('go')) c.postMessage({ type: 'go', go: q.get('go') });
          else c.postMessage({ type: 'feed-intent', feed: q.get('feed') });
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
