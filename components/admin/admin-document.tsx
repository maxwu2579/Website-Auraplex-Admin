import type { ReactNode } from 'react';

/**
 * The Admin HTML document. It has no providers: Admin pages need no locale,
 * theme or motion context from the copied public website.
 */
export function AdminDocument({
  fontClassName,
  children,
}: {
  fontClassName: string;
  children: ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className={fontClassName}>
      <body className="bg-[color:var(--color-ink)] text-[color:var(--color-paper)]">
        {children}
      </body>
    </html>
  );
}
