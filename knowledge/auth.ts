import NextAuth from 'next-auth';
import { createAdminAuthConfig } from '@/lib/admin/server/auth-config';

export const { handlers, auth, signIn, signOut } = NextAuth(createAdminAuthConfig());
