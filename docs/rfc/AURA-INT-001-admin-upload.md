# AURA INT 001 Knowledge Base Admin Upload

## Status

> **Standalone Admin note.** This RFC was written when the feature lived inside the public website repository. The Admin application has since been split into this standalone repository: the public website routes, locale routing (`next-intl`), Sanity, the website catalogue and the website Nomad job are no longer part of it. Statements below about the public site describe the state at proposal time. The upload, storage, authentication and session contracts are unchanged. Products now come from `lib/admin/admin-products.ts`.

Implemented on `codex/aura-int-001-admin-upload`; **pending real-environment validation** (see [Open Questions and Unverified Items](#open-questions-and-unverified-items)).

- Owner: Max
- Reviewer: Friendy Tan
- Priority: P2
- Target repository: `friendy21/Website-Auraplex`

### Revision history

| Revision | Description |
| --- | --- |
| Proposed (`d636806`, branch `docs/aura-int-001-admin-upload`) | Original architecture proposal against `main` at `b259c90`. |
| Final (this revision) | Updated to describe the implementation as built, after the implementation and review rounds. Superseded proposals (upload-ID filename prefix, single `QDRANT_COLLECTION`, Vitest, `unknown` status, three product lines) are removed. |

Operational detail lives in [`docs/deployment/AURA-INT-001-runtime.md`](../deployment/AURA-INT-001-runtime.md); the user workflow is in [`docs/admin-upload-guide.md`](../admin-upload-guide.md). Where this RFC and the runtime notes differ, the runtime notes and the code are authoritative.

## Summary

An authenticated administration page in the existing Website Auraplex Next.js application lets authorised non-technical users upload knowledge-base source files without command-line access or MinIO credentials.

The implementation provides a react-dropzone upload interface, mandatory business-line and product selection, server-side streaming to MinIO, Keycloak group-based access through Auth.js, a recent-uploads status view backed by MinIO and Qdrant, and Admin deletion. It does not change the downstream ingest, chunking, embedding, or Qdrant indexing services.

The highest-risk part remains the end-to-end large-file streaming path through Cloudflare Tunnel, Apache APISIX, Next.js, and MinIO. It has been exercised locally only; **the production 500 MB APISIX/Cloudflare test has not been run.**

## Repository Findings (at proposal time)

The following facts were verified against `main` at commit `b259c90572f7afb42358e63bc8e19159d535d2b5` before implementation:

- The application uses Next.js 16.2.7, React 19, TypeScript, the App Router, and Tailwind CSS v4.
- Public pages live under `app/[locale]` and support `en`, `ms`, and `zh`.
- The root `proxy.ts` applied only `next-intl` routing.
- The production image is a Next.js standalone Node.js image built from the root `Dockerfile`.
- The website runs as one Nomad allocation with host networking, 1 CPU, and 1 GB memory, specified in `deploy/website.nomad.hcl` (the task brief's `nomad-jobs/website.nomad.hcl` does not exist).
- The website is fronted by Apache APISIX and Cloudflare Tunnel.
- The repository uses npm and `package-lock.json`, and had no automated test suite.

## Problem

The knowledge-base ingestion workflow required command-line tooling and MinIO credentials. The intended uploader is non-technical and should not need either, so raw knowledge-base buckets could remain empty even though the downstream ingest pipeline is available.

## Goals

- An authenticated administration page at `/admin/upload` (`/admin` redirects there).
- Keycloak SSO and Keycloak groups instead of a custom user database.
- Drag-and-drop and file selection for the approved file types.
- Mandatory business line and catalogue product before upload.
- Server-derived object keys from the committed product catalogue.
- Streaming through a Route Handler into MinIO without buffering the whole file in memory, with or without `Content-Length`.
- A server-enforced per-file size limit using both declared length and bytes actually received.
- Uploader/Admin permissions, CSRF protection, rate limits, concurrency limits and audit logging.
- Recent upload and ingestion status from MinIO and Qdrant, without inventing results.
- Automated tests, deployment notes, MinIO policy, and a non-technical user guide.

## Non Goals

- Changing the downstream ingest, chunking, embedding, or Qdrant indexing pipeline.
- Whisper deployment or audio/video transcription.
- New ingest capabilities for file types the ingest service does not support.
- Changes to the public `/chat`, `/recommend`, or Machine Finder guardrails.
- A custom user table, password login, or a new Nomad job.
- Exposing MinIO or Qdrant credentials to the browser.

## User Flow

1. The user opens `/admin/upload`. An anonymous user is redirected to Keycloak sign-in; the page is server-gated before the product list or upload workspace renders.
2. The server checks the Keycloak `groups` claim in the ID token.
3. The user selects one of five business lines and a catalogue product.
4. The user drops or browses for files. The UI lists the queued files with their per-file state; the drop zone's `accept` map is derived from the same media routes the server enforces.
5. Each file is uploaded as an independent `PUT` request so progress, failure and retry are per file.
6. The server authenticates, authorises, checks CSRF, takes a concurrency slot, applies rate limits, validates metadata, sniffs the content and streams the file to MinIO.
7. The UI shows the result and refreshes the recent-uploads panel.
8. PDFs stay `pending` until matching Qdrant evidence exists, then show `processed`. Other stored types stay `pending` with "Ingestion support coming" and are never presented as indexed.

## Routing and Page Placement

```text
app/admin/layout.tsx
app/admin/page.tsx                 -> redirects to /admin/upload
app/admin/upload/page.tsx
app/admin/upload/actions.ts        -> logout server action
app/api/admin/csrf/route.ts        -> GET: issue CSRF token
app/api/admin/uploads/route.ts     -> PUT upload, GET recent uploads, DELETE (Admin)
app/api/auth/[...nextauth]/route.ts
```

The admin UI lives outside the locale-prefixed public site and does not render the public shell.

### Proxy exception for `/api/admin/uploads`

`proxy.ts` applies an authentication check for `/admin/:path*`, `/api/admin` and `/api/admin/*`, **except `/api/admin/uploads`**. Whenever Proxy runs, Next.js 16 tees the request body into an in-memory clone capped by `proxyClientMaxBodySize` (default 10 MiB) and truncates the Route Handler's copy at that cap; a local test reproduced this. Raising the cap would buffer whole uploads in memory, so the upload endpoint is excluded from the matcher instead. `/api/auth/*` is also excluded.

### Route Handler security enforcement

The session is authenticated once per request, by shared code in `lib/admin/server/session.ts`:

- **Behind Proxy** (`/admin/*`, `GET /api/admin/csrf`), Proxy validates the Auth.js session, including the idle/absolute lifetime rules and the 60-second Keycloak revalidation, sets the re-issued or cleared session cookie, and hands the authenticated identity to the page or the CSRF route in an encrypted request header. The CSRF route uses that identity and does not read the Auth.js session a second time; it falls back to reading the session itself, with the same rules, only when the handoff is missing or invalid.
- **`PUT`, `GET`, `DELETE /api/admin/uploads`** bypass Proxy on purpose and run the common session wrapper themselves, which performs the same validation and cookie handling.

Every admin handler, on either path:

- authorises Keycloak groups;
- calls `assertAdminNodeRuntime()` and fails closed under the Edge runtime.

`PUT` additionally enforces double-submit CSRF, the concurrency limit, rate limits and all upload validation. `DELETE` requires the Admin group and CSRF. Tests cover anonymous, expired, non-uploader, missing/mismatched CSRF and rate-limited requests with no Proxy involved.

## Authentication and Authorisation

Auth.js v5 (`next-auth` 5 beta) with the Keycloak provider. No custom user table.

| Application role | Keycloak group (default) | Permissions |
| --- | --- | --- |
| Uploader | `auraplex-uploader` (`KEYCLOAK_UPLOADER_ROLE`) | Upload files; view own uploads |
| Admin | `auraplex-admin` (`KEYCLOAK_ADMIN_ROLE`) | Upload files; view all uploads; delete |

Group names are exact, case-insensitive matches against the ID-token `groups` claim. Realm/client roles do not grant access; Keycloak must be configured to place groups in the ID token.

### Sessions

- **30-minute idle and 12-hour absolute lifetime.** The encrypted Auth.js JWT records a fixed `loginAt` and an `activeAt`. Each authenticated admin request re-issues the cookie with a new `activeAt`; `loginAt` never changes. A session is rejected after 30 minutes without such a request, or 12 hours after `loginAt`. Rules live in `lib/admin/server/session-policy.ts` and are applied in the Auth.js `jwt` callback; Proxy, Route Handlers and the admin page read the session through the same loader (`lib/admin/server/session.ts`).
- Activity is recorded when a request starts, so an upload that takes longer than 30 minutes completes, but the next request requires signing in again.
- Expired page requests redirect to sign-in; expired API requests return `401 UNAUTHENTICATED` and clear the cookie. Authenticated users without an allowed group receive `403 FORBIDDEN`.
- These are application sessions on top of the Keycloak SSO session. The local 12-hour limit is an upper bound; Keycloak's confirmed 10-hour SSO Session Max ends the effective session earlier.

### Keycloak revalidation

Confirmed with Friendy: authorization may rely on cached Keycloak groups for at most **60 seconds** (not a Keycloak call on every request). Confirmed Keycloak settings: access token 5 minutes, SSO Session Idle 30 minutes, SSO Session Max 10 hours, online refresh token rotated on use with a lifetime that follows the Keycloak session; a single Node.js instance is acceptable for now.

- **Two separate concepts.** Local activity updates `activeAt` and enforces the idle timeout. Authoritative revalidation contacts Keycloak, replaces the groups and updates `lastValidatedAt`. A request served from still-fresh state never moves `lastValidatedAt`. The 60-second window (`KEYCLOAK_REVALIDATION_WINDOW_SECONDS`) is not derived from the token lifespan, the idle timeout or the absolute lifetime.
- **Token state.** The encrypted Auth.js JWT holds the refresh token, its expiry, the latest ID token (also used for logout), the groups, `keycloakSub`, `lastValidatedAt` and the ordering claims `loginId`, `refreshGeneration` and `browserInstanceId` (see Response ordering below). `token.sub` stays the application session's own id (Auth.js generates a new random one at every sign-in); `keycloakSub` is a separate field that every refreshed ID token must match, and it is the stable identity used for upload ownership, rate limits and audit events. It is read on the server from the encrypted JWT and is not in the browser-visible session JSON. Email is never an ownership key. The access token is not stored. None of this is exposed in the session JSON, API responses, logs or audit events.
- **Order of checks** on every authenticated admin request: local idle/absolute validity, then freshness. When 60 seconds or more have passed, a refresh-token grant must succeed before authorization continues; afterwards the absolute limit is checked again, and `loginAt` is never reset.
- **Refresh-token grant** (`lib/admin/server/keycloak-revalidation.ts`): the token endpoint and JWKS come from OIDC discovery on the configured issuer and must live under it. The fresh ID token is verified for signature, issuer, audience/client binding (`azp` is required and must be the client when there are several audiences), subject, expiry and `iat` (not more than 30 seconds in the future); its groups replace the stored ones (no union). Rotation is mandatory: the response must carry a new refresh token, which replaces the stored one; a response without one is a protocol failure and the spent token is not kept.
- **Fail closed.** `invalid_grant` (revoked, expired, ended session, disabled user) clears the session: `401`. Fresh groups without the required group: `403`. Timeout, network failure, 5xx, or a malformed or untrusted response: `503 IDENTITY_PROVIDER_UNAVAILABLE`, with no privileged operation, no fallback to stale groups and no change to `activeAt` or `lastValidatedAt`; the cookie is kept so the request can be retried. A Keycloak outage therefore blocks admin use within 60 seconds.
- **Concurrency.** A process-local single-flight makes requests with the same refresh state share one Keycloak call, and keeps a successful result eligible for reuse for 10 seconds by requests that still carry the previous cookie. It holds two maps keyed by a digest of the refresh state (in-flight calls and reusable results), each capped at 256 entries, about 512 in total; expired results are never reused but are removed lazily, not at exactly 10 seconds. It uses no Redis or database. **These guarantees hold for one Node.js process only**; more instances need a shared store or sticky routing first.
- **Response ordering.** Overlapping requests of one browser do not finish in the order they started, so a late response could write back a consumed refresh token, remove a newer valid session, or replace a newer login. The session JWT therefore carries a login lineage id (`loginId`, new at every sign-in), a refresh generation (`refreshGeneration`, +1 per rotation) and the id of the browser instance (`browserInstanceId`, an opaque random value from a separate `HttpOnly`, `SameSite=Lax` cookie set at sign-in; not a credential, and not derived from the user). The process-local coordinator remembers the newest generation per login and the current login per browser instance (1024 entries each, dropped after the 12-hour session limit). The `jwt` callback reports why a session ended (idle, absolute, refresh succeeded but a local limit passed, Keycloak refused the current token, Keycloak refused an already superseded token, not revalidatable). When a response is committed: a re-issued cookie from an older generation is not set; the removal that follows a refused, already superseded refresh token is not sent (the request stays 401); and a response of a login the browser has signed out of or replaced neither sets nor removes the cookie. Idle and 12-hour expiry, a refresh that crossed the 12-hour limit, and Keycloak refusing the login's newest token still remove the cookie. Browsers are tracked separately, so two browsers of the same user do not affect each other. One shared rule is applied in three places: after the handler for `/api/admin/uploads`; at handoff for Proxy-covered paths (Proxy does not see the downstream response finish); and on the Auth.js routes, where a wrapper around both GET and POST filters only the session cookie out of the finished Auth.js response (`/api/auth/session`, `/api/auth/signout`) and passes status, body and all other cookies through. A sign-out of the browser's current login removes the cookie; a delayed sign-out of a login the browser has already left does not. Known limitations: this governs server-side commit decisions, not the order in which responses arrive over the network, so a browser can still end up with an older cookie and has to sign in again; the state is process-local for the single Node.js instance (several instances would need shared coordination); a restart or eviction loses the ordering knowledge and the response is then applied as before; a deleted browser-instance cookie breaks the link to the previous login. None of this state is used to accept a request. Details: [runtime notes](../deployment/AURA-INT-001-runtime.md#response-ordering-for-the-session-cookie).
- **One decision per request.** Behind Proxy, the page and the CSRF route use the identity Proxy authenticated (forwarded in an encrypted request header that Proxy always overwrites) rather than reading the session a second time, so a request cannot be accepted by Proxy just inside the window and then fail behind it just outside. When revalidation is due and fails, Proxy itself returns the 503 for both API and page paths and sets no cookie.
- **Centralised.** The check runs in the Auth.js `jwt` callback, so Proxy and the Proxy-bypassed upload handlers get it through the common session loader, and code behind Proxy gets Proxy's result. Sessions issued before this change carry no refresh state or ordering claims and must sign in again.

### Cookies and CSRF

- Auth.js cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` in production; production session and CSRF cookies use the `__Host-` prefix, transient OIDC cookies use `__Secure-`.
- State-changing admin requests use double-submit CSRF: `GET /api/admin/csrf` sets an `HttpOnly`, `SameSite=Strict` cookie scoped to `/api/admin` and returns the token, which the client sends as `X-CSRF-Token`.

### Logout

Logout clears the local Auth.js session. When OIDC discovery of Keycloak's `end_session_endpoint` succeeds (1.5-second timeout) and an ID token is held, the user is redirected through Keycloak with `id_token_hint` to end the SSO session and returned to `/signed-out` on `AUTH_URL`. If discovery is unavailable or the ID token is missing, local logout still completes and redirects to `/signed-out`, but **the upstream Keycloak SSO session is not guaranteed to be terminated**.

## Business Lines, Object Keys and Qdrant Routing

### Business lines and ingest lines

The uploader chooses one of **five business lines**. Storage and search use one of **three ingest lines**:

| BusinessLine | IngestLine | Qdrant collection |
| --- | --- | --- |
| `labelling` | `machines` | `auraplex_machines` |
| `packaging` | `machines` | `auraplex_machines` |
| `automation` | `machines` | `auraplex_machines` |
| `software` | `software` | `auraplex_software` |
| `consulting` | `consulting` | `auraplex_consulting` |

`X-Product-ID` must be a real catalogue product ID belonging to the selected business line; the server resolves `product.slug` from the committed Admin product list (`lib/admin/admin-products.ts`). Software and consulting have no catalogue products yet: the UI shows "no products configured yet" and the server rejects them with `INVALID_PRODUCT`. Placeholder IDs or slugs must not be added.

### Object key

```text
{ingest_line}/{product.slug}/{sanitized_filename}
```

Exactly three segments, built only on the server, e.g. `machines/flexy-applicator/bottom-labelling-machine-brochure.pdf`. The filename is sanitised to lowercase ASCII `[a-z0-9._-]` (at most 255 bytes), rejecting traversal and control characters. **There is no upload-ID prefix in the filename**: the generated upload ID is stored only in object metadata.

The key is deterministic: the same product and sanitised filename map to the same key, so a re-upload replaces the existing MinIO object (see [same-key limitation](#same-key-stale-qdrant-evidence)).

### `source_key`

```text
{bucket}/{key}
```

e.g. `auraplex-raw-pdf/machines/flexy-applicator/bottom-labelling-machine-brochure.pdf`. A single builder (`lib/admin/source-key.ts`) serves upload responses, status lookup and delete.

### Qdrant collection routing

A single resolver (`qdrantCollectionForSourceKey`) derives the collection from the ingest line in the key and serves both status and delete. **There is no `QDRANT_COLLECTION` setting and no default collection.** Unknown or legacy key prefixes (for example earlier test objects under `labelling/...`) fail explicitly: status reports them as `unsupported` and delete rejects them with 400. There is no scan across all collections.

### Object metadata

| Metadata key | Purpose |
| --- | --- |
| `upload-id` | Server-generated UUID for UI correlation and logs |
| `product-line` | Validated business line |
| `product-id` | Catalogue product ID, revalidated by the server |
| `original-filename` | URI-encoded original filename |
| `safe-filename` | Sanitised filename used in the key |
| `mime-type` | Canonical MIME type after sniffing |
| `ingestion-capability` | `supported` or `deferred` |
| `uploaded-by` | URI-encoded Keycloak subject (`keycloakSub`), stable across logins; drives the Uploader view. Objects written before this was fixed hold a per-login Auth.js UUID instead and are not migrated |

## File Types and Ingestion Capability

| File type | Bucket | Ingestion capability |
| --- | --- | --- |
| PDF | `auraplex-raw-pdf` | `supported` |
| DOCX | `auraplex-raw-pdf` | `deferred` (stored only) |
| PNG, JPG/JPEG | `auraplex-raw-image` | `deferred` (stored only) |
| MP4 | `auraplex-raw-video` | `deferred` (stored only; transcription out of scope) |

WebP, WebM and QuickTime from the original proposal are not accepted. The content must match the extension and declared type: the server sniffs the first 4,100 bytes with `file-type` 19.6.0 and replays them into the same stream.

## Upload API

### `PUT /api/admin/uploads`

Raw request body, one file per request (no multipart form parsing).

| Header | Required | Notes |
| --- | --- | --- |
| `Content-Type` | yes | Declared MIME type |
| `Content-Length` | **optional** | Positive integer when present |
| `X-Upload-Filename` | yes | Original filename |
| `X-Product-Line` | yes | One of the five business lines |
| `X-Product-ID` | yes | Catalogue product ID |
| `X-CSRF-Token` | yes | Token from `GET /api/admin/csrf` |

Processing order: session and group check → header validation → CSRF → concurrency slot → rate-limit admission → byte counter and idle timer → MIME sniff → stream to MinIO.

Success (`200`):

```json
{
  "ok": true,
  "uploadId": "0f8e…",
  "bucket": "auraplex-raw-pdf",
  "key": "machines/flexy-applicator/manual.pdf",
  "sourceKey": "auraplex-raw-pdf/machines/flexy-applicator/manual.pdf",
  "size": 1048576,
  "status": "pending"
}
```

`size` is the number of bytes actually received and stored. A success response is never returned for an incomplete object.

Errors use one shape, `{ "ok": false, "code": "…", "error": "…" }`, with no credentials, stack traces or raw upstream bodies. Codes: `MALFORMED_REQUEST`, `INVALID_CONTENT_LENGTH`, `EMPTY_FILE`, `SIZE_MISMATCH`, `INVALID_FILENAME`, `INVALID_PRODUCT`, `PRODUCT_LINE_MISMATCH`, `MISSING_CSRF_TOKEN` (400); `UNAUTHENTICATED` (401); `FORBIDDEN` (403); `REQUEST_TIMEOUT` (408); `FILE_TOO_LARGE` (413); `UNSUPPORTED_MEDIA_TYPE`, `MIME_MISMATCH` (415); `RATE_LIMITED` (429); `PARTIAL_DELETE`, `INTERNAL_ERROR` (500); `UPLOAD_CAPACITY_EXHAUSTED`, `BACKEND_NOT_CONFIGURED` (503).

### `GET /api/admin/uploads`

Returns `{ ok: true, uploads: RecentUpload[], qdrantAvailable }` with up to 50 recent uploads across the three buckets. Uploaders see only objects whose `uploaded-by` matches their Keycloak subject; Admins see all. Legacy objects whose `uploaded-by` is an old per-login UUID match no uploader and are visible to Admins only. Because ownership is in object metadata, the listing checks metadata newest-first in batches of 25 until 50 matching objects are found, so other users' newer uploads cannot hide an uploader's own objects. If Qdrant is not configured, `qdrantAvailable` is `false` and PDFs stay `pending`; a Qdrant query error fails the request rather than reporting a false result.

### `DELETE /api/admin/uploads`

Admin only, CSRF required, JSON body `{ "bucket": "…", "key": "…" }` (at most 2 KB, 3-second body timeout). See [Deletion](#deletion).

## Streaming, Size Limits and Timeouts

- **Size limit.** `ADMIN_UPLOAD_MAX_MB` is the server-enforced runtime limit: default 100 MB, range 1–500. The admin page passes it to the UI, so raising it needs no rebuild. `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB` is an optional build-time, UI-only ceiling. Ingress limits must be verified before raising the limit (see open questions).
- **Optional `Content-Length`.** When present, an oversize declaration is rejected with 413 before storage is contacted, and a received/declared mismatch fails with `SIZE_MISMATCH`. When absent, the byte counter is authoritative: it enforces the limit (413), and a zero-byte body fails with `EMPTY_FILE`.
- **Known length → single-part `PutObject`.** The SDK receives a shielded stream; any body failure aborts the storage call.
- **Unknown length → multipart** via `@aws-sdk/lib-storage` `Upload`, because single-part `PutObject` cannot send an unsized stream to S3/MinIO. 8 MiB parts, 2 concurrent part uploads, so memory is bounded to roughly (2 + 1) × 8 MiB per upload. Bodies smaller than one part are sent as a single sized `PutObject`.
- **Upload concurrency limit.** An in-process guard (`ADMIN_UPLOAD_MAX_CONCURRENT`, default 4, range 1–16) is taken after auth, header validation and CSRF, and before the body is read, rate limits are charged or storage is contacted. When full, the request fails fast with `503 UPLOAD_CAPACITY_EXHAUSTED` (the UI marks it retryable). The slot is released on every outcome. The limit is per Node.js process, not cluster-wide, and is not a queue.
- **No-progress timeout.** There is no total upload duration limit. If no bytes move through an upload for **120 seconds**, it fails with `408 REQUEST_TIMEOUT`, aborts the storage request and frees the slot. Bytes move only when storage consumes them, so a stalled MinIO also counts as no progress.
- **MinIO client timeouts.** 10-second connection timeout and 120-second socket-**inactivity** timeout per S3/MinIO request (not a total-request timeout). This does not bound total background cleanup time: SDK retries each get their own window, and in-flight parts may continue after the HTTP response.

## Multipart Cleanup and MinIO Lifecycle Requirement

- On body failure, validation failure, idle timeout or client disconnect, the upload is aborted immediately; the response and the concurrency slot do not wait for MinIO. lib-storage sends `AbortMultipartUpload` in the background (`leavePartsOnError: false`).
- If `CompleteMultipartUpload` fails, lib-storage does not abort by itself, so the adapter sends a best-effort `AbortMultipartUpload` for that `UploadId` in the background (capped at 30 seconds including SDK retries). The request fails immediately with the original completion error; a failing or hung abort cannot replace or delay it. The final object key is never deleted as cleanup, because an existing object may already be stored under it.
- lib-storage does not cancel part uploads already in flight; up to two 8 MiB parts may remain in memory until they finish or time out.
- The application **cannot guarantee cleanup** if the process crashes or is killed, if `AbortMultipartUpload` fails or times out, or if a request is cancelled while `CompleteMultipartUpload` is already in progress.
- **Required operational control:** a MinIO lifecycle rule on `auraplex-raw-pdf`, `auraplex-raw-image` and `auraplex-raw-video` that aborts incomplete multipart uploads after a period chosen and confirmed by ops (longer than the longest legitimate upload). This repository does not set the value, and **the rule has not been confirmed as deployed**. The in-application aborts are best-effort and do not replace it.

## Status Model

| Status | Evidence |
| --- | --- |
| `pending` | Stored and either ingest-compatible without Qdrant evidence yet, or of a deferred type ("Ingestion support coming") |
| `processed` | Qdrant has at least one point whose `payload.source_key` exactly equals `{bucket}/{key}` in the routed collection (scroll, `limit: 1`, no payload or vectors) |
| `failed` | Only on an explicit upstream failure signal for the exact `source_key`. **No such signal exists today**, so ingestion `failed` is never shown |
| `unsupported` | Unsupported type, or an object key outside the ingest taxonomy (legacy/unknown prefix) |

The proposed `queued` and `unknown` states were not implemented: deferred types show as `pending` with an explicit "Ingestion support coming" label, and backend unavailability is reported through `qdrantAvailable` or an error response instead of a per-item guess. Missing Qdrant evidence is never treated as failure, because it can mean ingestion is still running or the worker is stopped.

The UI's per-file queue states (`ready`, `uploading`, `uploaded`, `failed`, `unsupported`) describe the browser upload, not ingestion.

### Failed ingestion signal

The status model keeps `failed`, but no per-`source_key` failure signal exists in this repository or the documented ingest contract. Friendy/infrastructure must define one (for example a failure record or task state) before it can be wired in. This remains an **open upstream question**.

### Same-key stale Qdrant evidence

Because keys are deterministic, a re-upload replaces the MinIO object, but Qdrant points from the previous file keep the same `source_key` until the ingest worker re-processes it. Status can therefore show `processed` from the old file's evidence, and search can return old content in the meantime. Nothing in the known Qdrant payload (only `source_key`) ties points to a specific upload. This is a **known, unsolved limitation**. A fix needs an upstream payload field, such as the object's ETag or the stored `upload-id`, which is a Friendy/ingest decision. Replacement and versioning policy is a separate business decision.

## Deletion

Deletion is implemented for Admins only.

1. Validate the bucket and the ingest-taxonomy key (`{ingest_line}/{slug}/{file}`, file extension matching the bucket). The product does not have to still exist in today's catalogue, so stored objects remain deletable.
2. **Delete Qdrant first:** remove points whose `source_key` exactly matches `{bucket}/{key}` in the routed collection, with `wait: true`.
3. Delete the MinIO object.

If Qdrant succeeds and MinIO fails, the response is `500 PARTIAL_DELETE` and the object can remain. An outage or timeout after an external call can leave the final state uncertain; operators should investigate before retrying. Each outcome is audited as `delete.accepted`, `delete.partial` or `delete.failed`. The UI requires confirmation before deleting.

## Security Controls

- Server-only secrets injected at runtime; nothing sensitive in `NEXT_PUBLIC_*` or Docker build arguments.
- Least-privilege MinIO policy ([`docs/deployment/minio-admin-upload-policy.json`](../deployment/minio-admin-upload-policy.json)): `s3:ListBucket` on the three raw buckets, and `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload` on their objects. One credential serves upload and Admin deletion. The lifecycle rule is a bucket setting, not part of this policy.
- Session authentication on every admin request (by Proxy for Proxy-covered paths, by the upload handlers' own session wrapper for `/api/admin/uploads`); group authorisation and CSRF checks inside every Route Handler.
- Product and business line validated against the server-side catalogue; every key component sanitised on the server.
- Content sniffing instead of trusting browser headers or extensions.
- **Rate limits** per user and per process: 20 upload admissions per minute, 200 per hour, and 5 GiB per hour of volume. The declared size (or, for unknown length, up to the per-file maximum within the remaining hourly volume) is reserved at admission and settled to the bytes actually received. Limits reset on restart and are not shared across allocations.
- **Audit events:** one JSON line on stdout (`type: "admin_upload_audit"`) with `user`, `action` (`upload.accepted`, `upload.failed`, `delete.accepted`, `delete.partial`, `delete.failed`), `key`, `size` (actual bytes), `ip` and `timestamp`. `cf-connecting-ip` is trusted only when `ADMIN_TRUSTED_PROXY_SECRET` is set and APISIX strips and re-injects the `x-auraplex-proxy-secret` header.
- **Secret scanning:** `.github/workflows/secrets-scan.yml` runs the gitleaks CLI (pinned version and SHA-256) over full history on pull requests, pushes to `main`, `codex/**` and `docs/**`, and manual dispatch.

## Infrastructure and Configuration

The standalone Admin job's deployment identity (job, service, image, port, domain) is set in `deploy/admin.nomad.hcl`; runtime secret injection is not wired there and is not guessed. See `docs/deployment/AURAPLEX-ADMIN-deployment.md`. The job must not reuse the public website's job identity.

Server-only runtime variables:

```text
AUTH_SECRET
AUTH_URL
KEYCLOAK_ISSUER
KEYCLOAK_CLIENT_ID
KEYCLOAK_CLIENT_SECRET
KEYCLOAK_UPLOADER_ROLE        (default auraplex-uploader)
KEYCLOAK_ADMIN_ROLE           (default auraplex-admin)
MINIO_ENDPOINT
MINIO_ACCESS_KEY
MINIO_SECRET_KEY
MINIO_REGION
QDRANT_URL
QDRANT_API_KEY                (optional only if Qdrant permits no-key access)
ADMIN_UPLOAD_MAX_MB           (default 100, range 1-500)
ADMIN_UPLOAD_MAX_CONCURRENT   (default 4, range 1-16)
ADMIN_TRUSTED_PROXY_SECRET    (optional)
```

Optional build-time: `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB` (UI-only ceiling). **`QDRANT_COLLECTION` has been removed** and is no longer read; remove it from deployment templates. The proposal's `AUTH_KEYCLOAK_*` and `AUTH_TRUST_HOST` names were not used.

Route Handlers use Next's Node.js default runtime (Next 16 with Cache Components rejects an explicit `runtime = 'nodejs'` export); each admin handler fails closed under Edge.

## Dependencies

Added: `jose` (declared directly; already installed through `next-auth`, used to verify refreshed ID tokens), `next-auth` 5 (beta), `@aws-sdk/client-s3` 3.1136.0, `@aws-sdk/lib-storage` 3.1136.0 (unknown-length multipart), `@qdrant/js-client-rest` 1.19, `file-type` 19.6.0 (pinned), `react-dropzone` 14.4.1. Installed with npm.

The 2026-09-24 `npm audit` reports 44 advisory entries (2 critical: `next`, transitive `tar`). No dependency remediation was done in this work; see [`AURA-INT-001-dependency-review.md`](../deployment/AURA-INT-001-dependency-review.md). This is not a production security sign-off.

## Testing and Validation

Tests use the built-in `node:test` runner with `tsx` (`npm test`); Vitest was not adopted. The suite has 170 tests across eight files:

| File | Coverage |
| --- | --- |
| `tests/admin-upload.test.ts` | Five business lines → three ingest lines, catalogue product resolution, filename sanitisation, MIME routing and spoofing, object key and `source_key`, size limits, byte counter, sniff-and-replay, optional Content-Length, stable errors |
| `tests/admin-integration.test.ts` | Upload service with and without Content-Length, no premature success, S3 adapter commands and listing, Qdrant routing and exact `source_key` filter, status mapping and visibility, legacy prefixes, Qdrant-first delete and `PARTIAL_DELETE` |
| `tests/admin-security.test.ts` | Group mapping, CSRF, rate limiter, audit fields, trusted-IP handling, Proxy matcher and upload bypass, enforcement without Proxy, cookie flags, Keycloak logout discovery and fallback |
| `tests/admin-session.test.ts` | 30-minute idle / 12-hour absolute limits through the real Auth.js cookie pipeline with an injected clock |
| `tests/admin-revalidation.test.ts` | 60-second Keycloak revalidation against an in-process fake Keycloak: freshness window, group replacement, `invalid_grant`, outage and untrusted responses, mandatory refresh-token rotation, `iat`/`azp` rules, Proxy → handler pipeline across the 60-second mark, upload ownership across logins, single-flight, response ordering with a browser cookie jar (refresh generations, stale removals, old login versus new login, separate browsers, the native Auth.js session and sign-out routes, network arrival order as a documented limitation), local-limit interaction, Proxy/handler consistency, no token exposure |
| `tests/admin-storage.test.ts` | Real AWS SDK against an in-process S3 endpoint: PutObject vs multipart, abort cleanup, body failure, delayed/failing/hung aborts, failed `CompleteMultipartUpload`, stalled client and stalled MinIO |
| `tests/admin-upload-limits.test.ts` | Concurrency guard capacity and release on every outcome; rate-limit reserve/settle |
| `tests/admin-upload-ui.test.tsx` | react-dropzone input and `accept` contract (server-rendered) |

Also required before merge: `npm run typecheck`, `npm run lint`, `npm run build`, `git diff --check`.

A local HTTP run against the standalone production build with a local S3 sink exercised uploads above 10 MiB with and without `Content-Length`, and measured memory under concurrency (4 concurrent unknown-length 100 MiB uploads added about 145 MiB RSS). **Real Keycloak, MinIO, Qdrant, Cloudflare/APISIX, Nomad and ingest behaviour have not been verified.**

## Rollout Plan

1. Merge the implementation after review.
2. Provision runtime variables via the approved Nomad/Vault mechanism; remove `QDRANT_COLLECTION` from templates.
3. Create the MinIO service account with the documented policy, and configure the incomplete-multipart lifecycle rule on all three buckets.
4. Configure the Keycloak client: callback and post-logout URIs, `groups` in the ID token, and SSO session idle/max.
5. Configure `admin.auraplex.info` routing in Cloudflare Tunnel and APISIX with body-size and timeout limits for the configured maximum.
6. Deploy to a controlled environment and complete the staging checklist below, including the 500 MB ingress test, before raising `ADMIN_UPLOAD_MAX_MB` above the default.

### Staging checklist

- Upload representative PDF, DOCX, image and video files; confirm keys, metadata and `source_key`.
- Upload a file at the configured maximum through Cloudflare → APISIX → Node, with and without `Content-Length`; confirm bounded memory and no truncation.
- Reject a file over the maximum.
- Confirm Keycloak login, logout (with and without discovery), idle/absolute expiry and group changes.
- Confirm the ingest worker writes `source_key` as `{bucket}/{key}` into the three collections.
- Confirm audit events contain no credentials.
- Confirm `AbortMultipartUpload` works under the service-account policy.

## Rollback Plan

- Revert the website image to the previous known-good tag.
- Remove or disable the `admin.auraplex.info` route in APISIX/Cloudflare.
- Disable the Keycloak client if required, and revoke the MinIO service-account credentials.
- Leave uploaded objects and indexed Qdrant content unchanged unless a separately reviewed cleanup procedure is approved.

## Open Questions and Unverified Items

Resolved during implementation:

- Business lines: five values mapped to three ingest lines, as above.
- `product_id` is the catalogue ID; the server derives `product.slug`.
- Object key `{ingest_line}/{product.slug}/{filename}` and `source_key` `{bucket}/{key}`; no upload-ID filename prefix.
- Qdrant collections `auraplex_machines`, `auraplex_software`, `auraplex_consulting`.
- DOCX is stored in `auraplex-raw-pdf` as deferred; images and video are stored now as deferred.
- Admin deletion is in scope, Qdrant first; one MinIO credential covers upload and deletion.
- Keycloak session settings and the 60-second revalidation window (see [Keycloak revalidation](#keycloak-revalidation)).

Still open (require Friendy, infrastructure or real-environment evidence):

1. **500 MB ingress path.** Cloudflare Tunnel plan body limit (100 MB on Free/Pro, 200 MB on Business, 500 MB default on Enterprise per Cloudflare's documentation), APISIX `client_max_body_size` and timeouts. **Not yet validated.**
2. **Failed ingestion signal.** No authoritative per-`source_key` failure signal exists; `failed` is not shown until one is defined.
3. **Same-key stale Qdrant evidence.** Needs an upstream payload field (ETag or `upload-id`) and a replacement/versioning decision. **Not solved.**
4. **MinIO lifecycle rule** for incomplete multipart uploads on all three buckets, with an ops-confirmed duration. **Not confirmed as deployed.**
5. Whether the ingest worker's `parse_key()` and payload match the confirmed key and `source_key`, and whether `source_key` has an exact-match payload index in each collection.
6. The MinIO server version accepts lib-storage multipart uploads with the SDK's default CRC32 checksums.
7. Keycloak issuer, client, redirect and post-logout URI registration and `groups` claim mapping; and real-realm confirmation of revalidation (ID token with `groups` in the refresh response, Basic client authentication, session-cookie size through the ingress), which has only been tested against a fake Keycloak.
8. Production memory headroom under the default concurrency of 4.
9. Trusted forwarded-header setup (`ADMIN_TRUSTED_PROXY_SECRET`) and exact production secret paths.
10. Real catalogue products for the software and consulting lines.
11. Ownership of the Cloudflare Tunnel, APISIX, Keycloak, Vault, MinIO and Qdrant changes outside this repository.
12. Triage of the reported dependency advisories before production security sign-off.

## Definition of Done

Met in the repository (locally verified):

- Anonymous, expired and unauthorised access is rejected in every Route Handler, including the Proxy-bypassed upload endpoint.
- Uploader and Admin permissions match the role matrix.
- Approved file types upload with required business line and product; the server builds only approved keys.
- Streaming works with and without `Content-Length`, without whole-file buffering; oversize is rejected even when the declared size is missing or false.
- Content and filename validation, CSRF, rate limits, concurrency limit and idle timeout are enforced server-side.
- Deferred types are never shown as indexed; status does not invent failures.
- Tests, typecheck, lint and production build pass; MinIO policy, Nomad notes, runtime notes and user guide are included.

Outstanding before production:

- Real-environment validation of the items listed under Still open, in particular the 500 MB ingress test and the MinIO lifecycle rule.
- Review and approval of the code PR by Friendy.
