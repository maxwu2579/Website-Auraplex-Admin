import Link from 'next/link';
import { ArrowRight, Database, FileText, Film, Image as ImageIcon, ShieldCheck } from 'lucide-react';

// Public landing page. It reads no session and holds no product or upload
// data: everything behind "Sign in" is gated by proxy.ts and Keycloak. This
// is also where Keycloak returns the browser after sign-out.
export default function HomePage() {
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <div className="mb-8 grid h-12 w-12 place-items-center border border-[color:var(--color-signal)] text-[color:var(--color-signal)]">
        <Database aria-hidden="true" className="h-6 w-6" />
      </div>
      <p className="mb-4 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-signal)]">
        <ShieldCheck aria-hidden="true" className="h-4 w-4" />
        Restricted workspace
      </p>
      <h1 className="font-display text-4xl font-semibold leading-[1.05] sm:text-6xl">Auraplex Knowledge</h1>
      <p className="mt-5 max-w-xl text-base leading-7 text-[color:var(--color-neutral-300)]">
        Upload manuals, spec sheets, photos and videos that feed the Auraplex AI assistant. Files are stored
        per product and indexed into the knowledge base.
      </p>
      <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs uppercase tracking-wider text-[color:var(--color-neutral-400)]">
        <li className="flex items-center gap-2"><FileText aria-hidden="true" className="h-4 w-4" />PDF · DOCX</li>
        <li className="flex items-center gap-2"><ImageIcon aria-hidden="true" className="h-4 w-4" />PNG · JPG</li>
        <li className="flex items-center gap-2"><Film aria-hidden="true" className="h-4 w-4" />MP4</li>
      </ul>
      <Link
        href="/admin/upload"
        className="mt-10 inline-flex h-12 w-fit items-center gap-2 bg-[color:var(--color-signal)] px-6 font-mono text-sm uppercase tracking-wider text-[color:var(--color-ink)] transition-colors hover:bg-[color:var(--color-signal-bright)]"
      >
        Sign in with Keycloak
        <ArrowRight aria-hidden="true" className="h-4 w-4" />
      </Link>
      <p className="mt-6 text-xs text-[color:var(--color-neutral-500)]">
        Access requires the auraplex-uploader or auraplex-admin group.
      </p>
    </main>
  );
}
