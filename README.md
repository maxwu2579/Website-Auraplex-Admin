# Auraplex — v2.0

Industrial-editorial website for Auraplex SDN BHD. Next.js 16, React 19, Tailwind v4, Motion 12, GSAP + Lenis, React Three Fiber, Sanity CMS, trilingual (EN/BM/ZH).

## Quickstart

```bash
pnpm install
cp .env.example .env.local      # fill in keys (all optional for local dev)
pnpm dev
```

Visit http://localhost:3000 — the proxy redirects to `/en`.

> The app runs without any keys: forms, the Machine Finder and the
> spec-sheet gate degrade gracefully when Resend / Vercel KV / Anthropic /
> Sanity aren't configured (see "Runtime data" below).

## Structure

```
app/[locale]/        — App Router pages (en, ms, zh)
actions/             — React Server Actions (forms, AI machine finder)
components/          — primitives, sections, motion, three, forms, layout, providers
lib/                 — catalog, hooks (perf tier), models, sanity, seo, kv, news, animations, utils, i18n
messages/            — i18n JSON (en/ms/zh — kept key-for-key in sync)
sanity/              — Studio schemas (optional CMS)
styles/              — globals.css with @theme tokens + view transitions
public/              — brand/, products/, clients/, exhibitions/, floor/  (models/ optional)
```

## Runtime data

The machine catalogue is the committed source of truth in **`lib/catalog.ts`**
(generated into `lib/catalog.generated.ts` by `pnpm catalog`). Sanity is an
**optional** enhancement — when `NEXT_PUBLIC_SANITY_PROJECT_ID` is unset the
site reads the local catalogue and the CMS-backed features no-op cleanly.

## Stack notes

- **Tailwind v4** — CSS-first config in `styles/globals.css` using `@theme`. OKLCH tokens.
- **next-intl** — `/[locale]` segment with `en | ms | zh`. `proxy.ts` handles routing.
- **View Transitions API** — `viewTransitionName` on product images for the grid → detail shared-element morph.
- **Motion 12** — scroll-into-view reveals (`components/motion/reveal.tsx`, `useInView`), the animated product gallery, and UI micro-interactions. Reduced-motion aware.
- **GSAP + Lenis** — Lenis smooth scroll (`lenis-provider`) and pinned/scrubbed scroll sequences (`scroll-narrative`, `zoom-transition`, `horizontal-scroll`). Disabled under reduced motion.
- **Performance tiers** — `lib/hooks.ts` exposes `getPerfTier()` / `usePerfTier()` (`full | lite | minimal`) from reduced-motion + pointer + CPU/memory/Save-Data hints. Heavy effects (hero particle constellation, configurator post-processing) downgrade or switch off on phones / low-power devices.
- **R3F** — the product configurator at `/products/[slug]/configurator`. It loads `public/models/<slug>.glb` when present and otherwise shows a graceful "3D preview coming soon" placeholder (the CTA is hidden until a model exists). Lazy-loaded, mobile-gated, wrapped in an error boundary.
- **Sanity** — optional CMS for products / case studies / settings. Studio at `/studio`.
- **Resend** — quote / contact / internship / spec-sheet confirmations + internal notifications.
- **Vercel KV** — lead storage and ticker counters.
- **Anthropic Claude** — Machine Finder, streamed via the Vercel AI SDK; parses a recommendation and links to the matching product.

## Assets to drop in (optional)

- `public/models/<slug>.glb` — per-machine 3D models (Draco-compressed). The configurator auto-detects and enables itself per slug. Filenames must match the catalogue slug.
- `public/specs/<slug>.pdf` — real spec sheets (the spec-sheet email currently links to the product page until these exist).
- Real photography for the 7 machines still without images (see `MASTER_PLAN.md` §11).

> OG images are generated dynamically by `/api/og` — there is **no** static
> `og/default.png` to supply. Fonts are configured in `styles/fonts.css`
> (currently Fraunces / JetBrains Mono as licensed stand-ins).

## Knowledge-base upload app

The admin upload workspace for the AI knowledge base (PDF, DOCX, images,
video → MinIO + Qdrant, Keycloak sign-in) is a separate Next.js app in
[`knowledge/`](knowledge/README.md), built and deployed as its own image and
Nomad job. It is no longer part of this website.

## Audit & roadmap

A full audit and phased remediation plan lives in **`MASTER_PLAN.md`**.
Phases 0–2 (crash fixes, form a11y/robustness, cleanup) are complete; the
remaining items are content/business decisions (production domain, the
homepage ticker stats, testimonials/client logos, case studies, legal review).

## Deploy

Self-hosted on HashiCorp Nomad, fronted by Apache APISIX and Cloudflare Tunnel.
See `deploy/website.nomad.hcl` for the job spec. Build the image on the Nomad
host, tag as `auraplex.local/website:v1`, then `nomad job run`.

```bash
docker build -t auraplex-website:latest .
docker tag auraplex-website:latest auraplex.local/website:v1
nomad job run deploy/website.nomad.hcl
```

`next.config.ts` sets `output: 'standalone'`, so the image runs `node server.js`
with a self-contained `node_modules` subset. The build runs `npm run catalog`
(prebuild) and `pagefind` (postbuild), and tolerates missing keys; configure
Sanity + Resend + Anthropic to enable the corresponding features.

`NEXT_PUBLIC_*` values are inlined at build time — set them when building the
image, not only in the Nomad job. Lead persistence (`lib/kv.ts`) is a no-op
stub since the move off Vercel KV; leads are delivered by Resend email.

## Performance budget

- Initial JS (homepage) < 40KB
- LCP (4G) < 1.0s
- INP < 100ms
- Configurator route lazy-loaded (~500KB acceptable)
