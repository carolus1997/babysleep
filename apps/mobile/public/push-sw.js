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
    data: { url: data.url || './?feed=ask' },
    // Los botones dependen de que el sistema los muestre; si no, basta con tocar el aviso.
    actions: [
      { action: 'breast', title: 'Pecho' },
      { action: 'bottle', title: 'Biberón' },
    ],
  };
  event.waitUntil(self.registration.showNotification(data.title || 'Toca toma', options));
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
          c.postMessage({ type: 'feed-intent', feed: new URL(target).searchParams.get('feed') });
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
