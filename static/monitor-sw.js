/* berth-control monitor service worker.
 * Handles incoming push events from the host-monitor alert pipeline.
 * Lives under /static so it ships with the build untouched by sveltekit's
 * routing.
 *
 * No app code, no secrets. The payload is whatever broadcastNotification
 * sent: { title, body, tag }. */

self.addEventListener('push', (event) => {
  let payload = { title: 'berth-control', body: 'Notification', tag: 'monitor' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    /* fall back to default text payload below */
    if (event.data) payload.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: '/logo.png',
      badge: '/logo.png',
      // Replace the previous notification with the same tag instead of
      // stacking; avoids spamming the user during an alert storm.
      renotify: false
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        // Focus an existing monitor tab if there is one, else open one.
        for (const c of clients) {
          if (c.url.endsWith('/monitor')) return c.focus();
        }
        return self.clients.openWindow('/monitor');
      })
  );
});
