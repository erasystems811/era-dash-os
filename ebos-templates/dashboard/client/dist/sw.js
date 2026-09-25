// Real Web Push for the staff dashboard -- Chidera, 2026-09-23: "make the
// dashboard pwa so staff can get push notification or something," aimed at
// replacing real WhatsApp staff alerts with a free one once a staff member
// has installed/subscribed. Delivery is handled by the browser/OS's own
// push service, which is why a service worker (code that can run even with
// no tab open) is what receives it, not the page itself -- same reasoning
// as rider-pwa/public/sw.js, adapted for the staff dashboard's own alerts
// (new order, handover/complaint, payment confirmed) instead of a delivery
// offer.
self.addEventListener('push', (event) => {
  let data = { title: 'EBOS', body: 'Open the dashboard to see it.' };
  try {
    if (event.data) data = event.data.json();
  } catch {
    // A malformed/empty push payload still deserves a real notification,
    // not a silently dropped one -- the fallback text above covers it.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      vibrate: [200, 100, 200],
      tag: data.url || 'ebos-alert',
      data: { url: data.url || '/' },
    })
  );
});

// Tapping the notification should bring staff straight into the dashboard
// (and to the specific conversation/order it's about, when the payload
// carries a url), not leave the notification sitting there while a
// separate tab opens.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(targetUrl);
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
