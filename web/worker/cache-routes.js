const isApiOrAdminRequest = ({ url }) => {
  const { pathname } = url;
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/')
  );
};

const isEmojiRequest = ({ url }) => {
  const { pathname } = url;
  return pathname === '/img/emoji' || pathname.startsWith('/img/emoji/');
};

const removeApiAndAdminCacheEntries = async cacheStorage => {
  const cacheNames = await cacheStorage.keys();

  await Promise.all(
    cacheNames.map(async cacheName => {
      const cache = await cacheStorage.open(cacheName);
      const requests = await cache.keys();
      const privateRequests = requests.filter(request =>
        isApiOrAdminRequest({ url: new URL(request.url) }),
      );

      await Promise.all(privateRequests.map(request => cache.delete(request)));
    }),
  );
};

module.exports = {
  isApiOrAdminRequest,
  isEmojiRequest,
  removeApiAndAdminCacheEntries,
};
