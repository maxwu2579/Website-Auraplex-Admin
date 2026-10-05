import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Emits .next/standalone with a self-contained server.js, so the app runs as
  // a plain Node container under Nomad.
  output: 'standalone',
  // Keeps session/Keycloak work on the request path (see app/admin/upload/page.tsx).
  cacheComponents: true,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Nothing in this app is meant to be framed.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

export default config;
