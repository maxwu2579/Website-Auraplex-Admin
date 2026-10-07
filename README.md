# Auraplex Admin

Restricted internal workspace for uploading knowledge-base source material
(PDF, DOCX, PNG, JPG/JPEG, MP4) for Auraplex products. Staff sign in with
Keycloak, pick a business line and a product, and upload files. Files are
stored in MinIO; the workspace also shows each upload's processing status
from Qdrant and lets Admins delete an upload from both systems.

This is a standalone application. It is not the public Auraplex website and
contains no public marketing pages. The only routes reachable without signing
in are `/`, which redirects to the protected workspace, `/signed-out`, which
is intentionally public so that logout has somewhere to land, and the
`/api/health` liveness check.

## Stack

- **Next.js 16** (App Router, standalone output) · **React 19** · **TypeScript**
- **Tailwind CSS v4** (`styles/admin.css`)
- **Auth.js (next-auth v5)** with **Keycloak** (OIDC)
- **MinIO** via the AWS S3 SDK · **Qdrant** REST client
- Tests on the Node.js test runner (`node --test` through `tsx`)

Node.js 22 and npm are required (the Dockerfile uses `node:22-slim`).

## Local setup

```bash
npm ci
cp .env.example .env.local   # then fill in the values
npm run dev                  # http://localhost:3000
```

Without Keycloak configured, `/signed-out` renders but `/admin/upload` cannot
complete sign-in. Without MinIO configured, uploads return
`BACKEND_NOT_CONFIGURED` (503).

## Routes

| Route | Access | Purpose |
| --- | --- | --- |
| `/` | public | Redirects to `/admin/upload` |
| `/admin` | protected | Redirects to `/admin/upload` |
| `/admin/upload` | protected (uploader or admin group) | Upload workspace |
| `/signed-out` | public | Shown after logout, with a link to sign in again |
| `/api/admin/csrf` | protected | Issues the double-submit CSRF token |
| `/api/admin/uploads` | protected (`PUT`, `GET`, `DELETE`) | Upload, list and delete |
| `/api/auth/*` | Auth.js | Sign-in, callback, session, sign-out |
| `/api/health` | public | Liveness check: `{"status":"ok","service":"auraplex-admin"}` |

`/api/health` reports only that the server process is answering. It reads no
session and does not contact Keycloak, MinIO or Qdrant.

`proxy.ts` guards `/admin/*` and `/api/admin/*` **except `/api/admin/uploads`**.
That endpoint is deliberately excluded so large request bodies are streamed
rather than buffered by Proxy; its Route Handler authenticates the session,
checks groups, CSRF and rate limits itself. Do not add it to the matcher.

## Project layout

```
app/admin/            Admin layout, /admin redirect, upload page, logout action
app/api/admin/        CSRF and upload Route Handlers
app/api/auth/         Auth.js route
app/signed-out/       Public signed-out page
app/page.tsx          Root redirect
auth.ts               Auth.js instance
proxy.ts              Admin authentication guard
components/admin/     Upload workspace UI and the Admin HTML document
components/primitives/button.tsx
lib/admin/            Domain model, product list, validation, contracts
lib/admin/server/     Session, Keycloak, storage, Qdrant, limits, audit
styles/admin.css      The only stylesheet
tests/                Automated tests
docs/                 User guide, runtime/deployment notes, RFC, MinIO policy
deploy/               Production Nomad job draft (must not be submitted)
```

## Products and storage contract

Products are committed static data in `lib/admin/admin-products.ts` (30
machines: 25 labelling, 2 packaging, 3 automation). Product IDs and slugs are
part of the storage contract and must not be regenerated or renamed. Software
and consulting are selectable business lines with no products yet, so nothing
can be uploaded to them; add real records only, never placeholders.

| Business line | Ingest line | Qdrant collection |
| --- | --- | --- |
| labelling, packaging, automation | `machines` | `auraplex_machines` |
| software | `software` | `auraplex_software` |
| consulting | `consulting` | `auraplex_consulting` |

- Object key: `{ingest_line}/{product.slug}/{sanitized_filename}`
- Qdrant `source_key`: `{bucket}/{key}`
- Buckets: `auraplex-raw-pdf`, `auraplex-raw-image`, `auraplex-raw-video`

## Keycloak requirements

- An OIDC client for this application (`KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`,
  `KEYCLOAK_CLIENT_SECRET`).
- The client must issue **refresh tokens** and put **`groups` in the ID
  token**. Access is granted by group membership only: the uploader and admin
  groups default to `auraplex-uploader` and `auraplex-admin`
  (`KEYCLOAK_UPLOADER_ROLE`, `KEYCLOAK_ADMIN_ROLE`).
- The application sends the redirect URI
  `<AUTH_URL>/api/auth/callback/keycloak` and the post-logout redirect URI
  `<AUTH_URL>/signed-out`. Their registration on the Keycloak client is
  **blocked** pending a decision; see the deployment document.

Sessions end after 30 minutes without activity and 12 hours after sign-in.
Every session is re-verified with Keycloak once its last verification is 60
seconds old; if Keycloak cannot be reached at that point the request is
refused (503) rather than trusted.

## MinIO and Qdrant requirements

- **MinIO**: `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, optional
  `MINIO_REGION`. The three buckets above must exist. The access key needs
  the permissions in `docs/deployment/minio-admin-upload-policy.json`.
- **Qdrant**: `QDRANT_URL` and, if the deployment requires one,
  `QDRANT_API_KEY`. Used for status lookup and delete only. Collections are
  fixed per ingest line; there is no collection setting.

## Environment configuration

All variables are listed with comments in `.env.example`. Every one is
server-only and read at runtime, except the optional
`NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB`, a build-time UI-only ceiling.

| Variable | Needed for |
| --- | --- |
| `AUTH_SECRET`, `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` | Required for authentication. |
| `AUTH_URL` | Public origin of this application. Needed for Keycloak logout; set it in every environment behind an ingress. |
| `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | Required for upload and storage. |
| `QDRANT_URL` | Required for processing status and delete; uploads work without it. |
| `QDRANT_API_KEY` | Conditional: only if Qdrant requires a key. |
| `KEYCLOAK_UPLOADER_ROLE`, `KEYCLOAK_ADMIN_ROLE`, `MINIO_REGION` | Optional; defaulted. |
| `ADMIN_UPLOAD_MAX_MB` | Optional. Server-enforced per-file cap, 1–500, default 100. |
| `ADMIN_UPLOAD_MAX_CONCURRENT` | Optional. Concurrent uploads per process, 1–16, default 4. |
| `ADMIN_TRUSTED_PROXY_SECRET` | Conditional; see the runtime notes before setting. |

No variable is validated at startup: the server starts, and `/api/health`
answers, even with none of them set.

## Testing

```bash
npm test
npm run typecheck
npm run lint
```

The tests run against in-process fakes (a fake Keycloak, an in-process S3
endpoint); none contacts a real Keycloak, MinIO or Qdrant.

## Build

```bash
npm run build                       # next build, standalone output
docker build -t auraplex-admin .    # container image
```

The build needs no secrets and runs no extra generation steps.

### Running the standalone server

`next build` writes a self-contained server to `.next/standalone`, but that
folder does **not** include the static assets: `.next/static` (JavaScript,
CSS, fonts) and `public/`. Started as it is, `server.js` serves pages with no
styles or scripts.

The Docker image is the preferred way to run the standalone build, because
the `Dockerfile` copies both folders into place. To run it without Docker,
copy them yourself after every build:

```bash
npm run build
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
node .next/standalone/server.js
```

In PowerShell, the two copy steps are:

```powershell
Copy-Item -Recurse .next\static .next\standalone\.next\static
Copy-Item -Recurse public .next\standalone\public
```

Provide the runtime variables in the server's environment. For day-to-day
development use `npm run dev` instead.

## Deployment prerequisites

Nothing is deployed: there has been no production deployment and no staging
deployment. The confirmed values, the open items and the production smoke
tests are in `docs/deployment/AURAPLEX-ADMIN-deployment.md`.

- **Confirmed by Friendy and wired** into `deploy/admin.nomad.hcl`, a draft
  of the production job: the production hostname
  `admin-auraplex.auraplex.info` (as `AUTH_URL`), the Keycloak issuer and
  client ID, and the Nomad job, service, internal port, datacenter, node,
  image and resources, as a single instance.
- **Confirmed but only documented:** the staging hostname
  `admin-auraplex-staging.auraplex.info`. No staging job exists.

The draft is not production-ready and must not be submitted to Nomad. Nothing
in the file prevents Nomad from accepting it, and the health check would pass
even without the secrets.

Still open before a first deployment:

- **Blocked:** which callback and logout URIs are registered on the Keycloak
  client. The supplied URIs differ from the ones the application uses.
- Runtime secret injection. The Keycloak client secret comes from Vault
  (`kv/auraplex/admin-upload/keycloak_client_secret`); the Nomad wiring and
  the other secrets and service addresses are not in place.
- The host port and network mapping. Only the internal port, 3000, is
  confirmed.
- The final upload size cap, and confirmation that the ingress allows request
  bodies of that size without buffering them.
- A real Docker build and container smoke test; none has been run.
- The end-to-end checks listed as unverified in
  `docs/deployment/AURA-INT-001-runtime.md`: real Keycloak, MinIO, Qdrant and
  ingress behaviour have only been tested against local fakes.
- Triage of the open `npm audit` findings
  (`docs/deployment/AURA-INT-001-dependency-review.md`).

## Documentation

- `docs/admin-upload-guide.md` — user guide
- `docs/deployment/AURAPLEX-ADMIN-deployment.md` — deployment readiness,
  confirmed values, open items and smoke tests
- `docs/deployment/AURA-INT-001-runtime.md` — runtime and security behaviour
- `docs/deployment/AURA-INT-001-dependency-review.md` — dependency audit
- `docs/deployment/minio-admin-upload-policy.json` — MinIO access policy
- `docs/rfc/AURA-INT-001-admin-upload.md` — original design
