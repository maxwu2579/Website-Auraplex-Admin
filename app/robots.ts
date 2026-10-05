import type { MetadataRoute } from 'next';

// The Admin application is not a public site: nothing is to be indexed.
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: '*', disallow: '/' }] };
}
