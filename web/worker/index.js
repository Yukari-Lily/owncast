/* eslint-disable no-restricted-globals */
const { removeApiAndAdminCacheEntries } = require('./cache-routes');

self.addEventListener('activate', event => {
  event.waitUntil(removeApiAndAdminCacheEntries(self.caches));
});

self.addEventListener('push', event => {
  const data = JSON.parse(event.data.text());
  const { title, body, icon, tag } = data;
  const options = {
    title: title || 'Live!',
    body: body || 'This live stream has started.',
    icon: icon || '/logo/external',
    tag,
  };

  event.waitUntil(self.registration.showNotification(options.title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/'));
});
