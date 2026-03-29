self.addEventListener('push', (event) => {
  const { title, body, icon, badge, data } = event.data.json();
  event.waitUntil(
    self.registration.showNotification(title, { body, icon, badge, data, tag: data.room })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      const appUrl = 'https://chat.alpinekansascity.com';
      const room = event.notification.data?.room;
      for (const client of windowClients) {
        if (client.url.startsWith(appUrl) && 'focus' in client) {
          client.focus();
          if (room) client.postMessage({ type: 'navigate_room', room });
          return;
        }
      }
      return clients.openWindow(appUrl);
    })
  );
});
