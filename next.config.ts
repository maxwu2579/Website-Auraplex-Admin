import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Emits .next/standalone with a self-contained server.js + a minimal
  // node_modules subset, so the app runs as a plain Node container.
  output: 'standalone',
  // Next 16.2.7: cacheComponents promoted out of experimental.
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents
  cacheComponents: true,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default config;
