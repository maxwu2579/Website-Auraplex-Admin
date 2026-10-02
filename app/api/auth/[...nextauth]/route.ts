import type { NextRequest } from 'next/server';
import { handlers } from '@/auth';
import { withBrowserInstance } from '@/lib/admin/server/browser-instance';

// Both methods go through the same wrapper. Sign-in completes in this route
// (the OIDC callback), so this is where a new login is tied to the browser it
// came from; and Auth.js writes the session cookie here itself (session,
// sign-out), so this is where those writes get the common commit rule.
export const GET = (request: NextRequest) => withBrowserInstance(request, handlers.GET);
export const POST = (request: NextRequest) => withBrowserInstance(request, handlers.POST);
