# Auraplex Knowledge

Standalone web app for uploading source material — PDFs, Word documents,
photos and videos — into the Auraplex AI knowledge base that powers the
website's FAQ assistant. It was split out of the marketing website in the
repository root (formerly `/admin/upload` there) so it
can be deployed, secured and scaled on its own.

Next.js 16 · React 19 · Tailwind v4 · Auth.js + Keycloak · MinIO · Qdrant.

## Quickstart

```bash
cd knowledge
npm install
cp .env.example .env.local   # Keycloak, MinIO and Qdrant settings
npm run dev                  # http://localhost:3100
```

`/` is a public landing page. **Sign in** goes to `/admin/upload`, which
requires a Keycloak user in the `auraplex-uploader` or `auraplex-admin` group.

## How it works

1. Choose a business line and product, then drop files (PDF, DOCX, PNG,
   JPG/JPEG, MP4; 100 MB each by default).
2. Each file streams through `PUT /api/admin/uploads` into MinIO at
   `<ingest-line>/<product-slug>/<filename>` after content sniffing, CSRF,
   rate-limit and size checks.
3. The ingest pipeline indexes PDFs into Qdrant (`auraplex_machines`,
   `auraplex_software`, `auraplex_consulting`). Recent uploads show
   **processed** once matching Qdrant evidence exists. Other formats are
   stored now and marked pending until ingestion supports them.
4. Admins can delete an upload, which removes the Qdrant records and the
   MinIO object.

User-facing guide: [`docs/admin-upload-guide.md`](docs/admin-upload-guide.md).
Design and security model: [`docs/rfc/AURA-INT-001-admin-upload.md`](docs/rfc/AURA-INT-001-admin-upload.md).

## Structure

```
app/page.tsx            public landing page (also the post-logout target)
app/admin/upload/       upload workspace (server-authenticated page + logout action)
app/api/admin/          csrf + uploads (PUT/GET/DELETE) route handlers
app/api/auth/           Auth.js (Keycloak) routes
proxy.ts                admin gate: session, groups, Keycloak re-verification
lib/admin/              upload contract, validation, domain, product list
lib/admin/server/       auth, session, storage (MinIO), Qdrant, rate limits
components/admin/       upload panel UI
tests/                  node:test suites (npm test)
```

## Products

`lib/admin/upload-products.ts` holds the product list as a snapshot of the
website catalogue. Product ids and slugs are part of the storage and Qdrant
keys, so keep them identical to the website's `lib/catalog.ts` when machines
are added or renamed.

## Scripts

| Command | |
|---|---|
| `npm run dev` | Dev server on port 3100 |
| `npm run build` / `npm start` | Production build / serve |
| `npm test` | Upload, security, session and storage tests |
| `npm run typecheck` / `npm run lint` | Static checks |

## Deploy

Self-hosted on Nomad like the website, as its own job:

```bash
docker build -t auraplex.local/knowledge:v1 knowledge
nomad job run knowledge/deploy/knowledge.nomad.hcl
```

All configuration is read at runtime from the environment (see
`.env.example`); inject secrets via Nomad templates + nomadVar. Give the app
its own hostname (for example `knowledge.auraplex.info`), set `AUTH_URL` to
it, and register `<AUTH_URL>/api/auth/callback/keycloak` and `<AUTH_URL>/`
on the Keycloak client. Runtime details:
[`docs/deployment/AURA-INT-001-runtime.md`](docs/deployment/AURA-INT-001-runtime.md).
