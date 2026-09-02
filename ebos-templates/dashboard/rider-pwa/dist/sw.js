// Real Web Push for the rider app -- this is what actually rings/vibrates
// a rider's phone with the screen off or the app backgrounded, unlike the
// in-page synthesised alarm (App.jsx's playAlarm), which only ever runs
// while that page is open and executing. Delivery of a push event is
// handled by the browser/OS's own push service, which is exactly why a
// service worker (code that can run even when no tab is open) is what has
// to receive it, not the page itself.
self.addEventListener('push', (event) => {
  let data = { title: 'New delivery offer', body: 'Open the app to see it.' };
  try {
    if (event.data) data = event.data.json();
  } catch {
    // A malformed/empty push payload still deserves a real notification,
    // not a silently dropped one (rule 0.4) -- the fallback text above
    // covers it.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      // A real vibration pattern, not just a sound -- spec B3's own
      // "audible alarm and vibration" for an incoming offer, and vibration
      // is the one part of this a locked/silenced phone can still surface.
      vibrate: [400, 200, 400, 200, 400],
      requireInteraction: true,
      tag: 'delivery-offer',
    })
  );
});

// Tapping the notification should bring the rider straight into the app,
// not leave the notification sitting there while a separate tab opens.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('/rider') && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/rider/');
    })
  );
});
