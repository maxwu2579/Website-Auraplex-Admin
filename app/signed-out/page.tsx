import { ADMIN_HOME_PATH } from '@/lib/admin/admin-routes';

export default function SignedOutPage() {
  return (
    <main id="main" className="grid min-h-screen place-items-center px-5 py-10">
      <div className="w-full max-w-2xl border border-[color:var(--color-neutral-700)] bg-[color:var(--color-neutral-800)]/55 p-5 sm:p-6">
        <p className="font-mono text-xs uppercase tracking-[0.22em] text-[color:var(--color-neutral-400)]">
          Auraplex Admin
        </p>
        <h1 className="mt-2 font-display text-4xl font-semibold leading-[1.05]">Signed out</h1>
        {/* A plain link: signing in again starts at the protected page, which
            sends an unauthenticated browser to Keycloak. */}
        <a
          href={ADMIN_HOME_PATH}
          className="mt-6 inline-flex h-12 items-center justify-center bg-[color:var(--color-signal)] px-6 font-mono text-sm uppercase tracking-wider text-[color:var(--color-ink)] hover:bg-[color:var(--color-signal-hi)]"
        >
          Sign in again
        </a>
      </div>
    </main>
  );
}
