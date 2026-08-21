const withLess = require('next-with-less');
const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true',
});
const { PHASE_DEVELOPMENT_SERVER } = require('next/constants');
const runtimeCaching = require('next-pwa/cache');
const createPWA = require('next-pwa');
const { isApiOrAdminRequest, isEmojiRequest } = require('./worker/cache-routes');

const withPWA = createPWA({
  dest: 'public',
  customWorkerDir: 'worker',
  runtimeCaching: [
    // NetworkOnly exclusions MUST precede `...runtimeCaching`: workbox uses
    // the first matching route, and next-pwa's defaults end with a same-origin
    // catch-all ("others", NetworkFirst) that would otherwise intercept and
    // cache these URLs. The HLS playlist/segments and the live thumbnail are
    // polled continuously (with cachebust query strings) while a stream is
    // live; caching every cachebusted URL bloats CacheStorage and steadily
    // burns CPU in the browser/storage process. Match on `pathname` so the
    // cachebust query string does not defeat the rule.
    {
      urlPattern: ({ url }) => /\.(?:ts|m3u8)$/i.test(url.pathname),
      handler: 'NetworkOnly',
    },
    {
      urlPattern: ({ url }) => url.pathname === '/thumbnail.jpg',
      handler: 'NetworkOnly',
    },
    {
      urlPattern: isApiOrAdminRequest,
      handler: 'NetworkOnly',
    },
    {
      urlPattern: isEmojiRequest,
      handler: 'StaleWhileRevalidate',
      options: {
        cacheName: 'emoji-images',
        expiration: {
          maxEntries: 1200,
        },
      },
    },
    ...runtimeCaching,
  ],
  register: true,
  skipWaiting: true,
  disableDevLogs: true,
  publicExcludes: ['!img/platformlogos/**/*', '!styles/admin/**/*'],
  buildExcludes: [/chunks\/pages\/admin.*/, '!**/admin/**/*'],
  sourcemap: process.env.NODE_ENV === 'development',
  disable: process.env.NODE_ENV === 'development',
});

async function rewrites() {
  return [
    {
      source: '/api/:path*',
      destination: 'http://localhost:8080/api/:path*', // Proxy to Backend to work around CORS.
    },
    {
      source: '/hls/:path*',
      destination: 'http://localhost:8080/hls/:path*', // Proxy to Backend to work around CORS.
    },
    {
      source: '/img/:path*',
      destination: 'http://localhost:8080/img/:path*', // Proxy to Backend to work around CORS.
    },
    {
      source: '/logo',
      destination: 'http://localhost:8080/logo', // Proxy to Backend to work around CORS.
    },
    {
      source: '/thumbnail.jpg',
      destination: 'http://localhost:8080/thumbnail.jpg', // Proxy to Backend to work around CORS.
    },
    {
      source: '/customjavascript',
      destination: 'http://localhost:8080/customjavascript', // Proxy to Backend to work around CORS.
    },
  ];
}

module.exports = async phase => {
  /**
   * @type {import('next').NextConfig}
   */
  let nextConfig = withPWA(
    withBundleAnalyzer(
      withLess({
        productionBrowserSourceMaps: process.env.SOURCE_MAPS === 'true',
        trailingSlash: true,
        reactStrictMode: true,
        images: {
          unoptimized: true,
        },
        swcMinify: true,
        transpilePackages: [
          'antd',
          '@ant-design',
          'rc-util',
          'rc-pagination',
          'rc-picker',
          'rc-notification',
          'rc-tooltip',
          'rc-tree',
          'rc-table',
        ],
        webpack(config) {
          config.module.rules.push({
            test: /\.svg$/i,
            issuer: /\.[jt]sx?$/,
            use: ['@svgr/webpack'],
          });

          return config;
        },
        pageExtensions: ['tsx'],
      }),
    ),
  );

  if (phase === PHASE_DEVELOPMENT_SERVER) {
    nextConfig = {
      ...nextConfig,
      rewrites,
    };
  } else {
    nextConfig = {
      ...nextConfig,
      output: 'export',
    };
  }
  return nextConfig;
};
