import createMiddleware from 'next-intl/middleware';
import { routing } from './lib/navigation';

// Locale routing only. The knowledge-base upload workspace that used to live
// under /admin is now its own app in knowledge/.
export default createMiddleware(routing);

export const config = {
  matcher: ['/((?!api|_next|_vercel|studio|.*\..*).*)'],
};
