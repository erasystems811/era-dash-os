// Real Web Push for the rider app -- this is what actually rings/vibrates
// a rider's phone with the screen off or the app backgrounded, unlike the
// in-page synthesised alarm (App.jsx's playAlarm), which only ever runs
// while that page is open and executing. Delivery of a push event is
// handled by the browser/OS's own push service, which is exactly why a
// service worker (code that can run even when no tab is open) is what has
// to receive it, not the page itself.
// The Notification API gives a website no way to control how long the
// actual notification SOUND plays -- that's the phone's own default
// notification sound, fixed length, chosen by the OS, not something
// `showNotification` can override (there is no `sound` option; browsers
// dropped it years ago). Vibration is the one lever a web page genuinely
// has, so that's what gets stretched to ~20s here to match the ~20s
// foreground alarm (App.jsx's playAlarm) -- 20 pulse/pause cycles of
// 800ms each. A rider who wants a longer/louder audible ring specifically
// while the phone is locked would need to set a longer custom sound for
// this site's notification channel in their own phone's notification
// settings -- a device setting, not something this code can set for them.
const RING_VIBRATE_PATTERN = Array.from({ length: 20 }, () => [500, 300]).flat();

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
      vibrate: RING_VIBRATE_PATTERN,
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
