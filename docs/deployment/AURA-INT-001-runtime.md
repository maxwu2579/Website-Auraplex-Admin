# AURA-INT-001 Runtime and Deployment Notes

## Verified locally versus production

Local automated tests (`npm test`) cover upload validation, the business-line → ingest-line mapping, the object-key and `source_key` contracts, Qdrant collection routing, optional Content-Length with actual byte accounting, complete stream replay after MIME inspection, server-side group/CSRF/rate-limit checks without Proxy, stable error responses, status mapping, deletion order and partial failure. They also cover:

- `tests/admin-session.test.ts` — the 30-minute idle and 12-hour absolute session limits, run through the real Auth.js session pipeline (encrypted session cookies, the app's `jwt` callback, re-issued cookies) with an injected clock, including the Proxy-bypassed upload handler and a Proxy/route-handler consistency matrix.
- `tests/admin-storage.test.ts` — the real AWS SDK against an in-process S3 endpoint: single-part, multipart, abort cleanup, body failure, a delayed or failing `AbortMultipartUpload`, a failed `CompleteMultipartUpload` (with successful, failing and hung abort), stalled clients and a stalled MinIO part upload.
- `tests/admin-upload-limits.test.ts` — the per-process concurrency guard (capacity, release after success and every failure mode) and rate-limit reserve → settle behaviour.
- `tests/admin-upload-ui.test.tsx` — the react-dropzone input/accept contract (server-rendered).

A local HTTP run against the standalone production server (`node .next/standalone/server.js`, throwaway credentials, local S3 sink) exercised uploads above 10 MiB with and without Content-Length. **Real Keycloak, MinIO, Qdrant, Cloudflare/APISIX, Nomad and ingest behavior have not been verified, and the production 500 MB APISIX/Cloudflare Tunnel test has not been run.** Do not infer production readiness from local runs.

The 2026-09-24 `npm audit` and `npm audit --omit=dev` checks each report 44 dependency advisories (2 critical, 20 high, 17 moderate, 5 low). The critical entries are `next` and transitive `tar`. Apart from adding `@aws-sdk/lib-storage` (matched to the installed `@aws-sdk/client-s3` 3.1136.0) and `react-dropzone` 14.4.1, no dependency upgrades were made; see [the dependency review](AURA-INT-001-dependency-review.md). Triage and remediate before production security sign-off.

## Routes and security boundaries

- `/admin/upload` is server-gated before the product list or upload workspace renders.
- `proxy.ts` runs for `/admin/:path*`, `/api/admin` and `/api/admin/*` **except** `/api/admin/uploads`. Whenever Proxy runs, Next.js 16 tees the request body into an in-memory clone capped by `proxyClientMaxBodySize` (default 10 MiB) and truncates the Route Handler's copy at that cap. A local HTTP test reproduced this (Next logged `Request body exceeded 10MB for /api/admin/uploads`, and the handler saw only 10 MiB). Raising the cap would buffer whole uploads in memory, so the upload endpoint is excluded from the matcher instead.
- Excluding Proxy removes only a first-line check. `GET /api/admin/csrf`, `PUT /api/admin/uploads`, `GET /api/admin/uploads` and `DELETE /api/admin/uploads` each independently authenticate the Auth.js session (including the expiry rules below) and authorize Keycloak ID-token `groups`; `PUT` also enforces double-submit CSRF, rate limits, the concurrency limit and validation, and `DELETE` requires the Admin group plus CSRF. Tests cover anonymous, expired, non-uploader, missing/mismatched CSRF and rate-limited uploads with no Proxy involved.
- Group names are exact, case-insensitive matches to `KEYCLOAK_UPLOADER_ROLE` and `KEYCLOAK_ADMIN_ROLE`, defaulting to `auraplex-uploader` and `auraplex-admin`. Realm/client roles do not grant access. Configure Keycloak to place groups in the ID token.
- Logout uses OIDC discovery's `end_session_endpoint` with a server-held `id_token_hint`, clears the Auth.js session, then redirects through Keycloak back to the configured `AUTH_URL` origin. Discovery has a 1.5-second timeout; if unavailable or the ID token is missing, local Auth.js logout still completes and redirects to `/en`. In that fallback the upstream Keycloak SSO session is **not confirmed terminated**. Verify post-logout URI registration in the real client.
- Auth.js session/CSRF cookies use `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` in production. The production session and CSRF cookies use `__Host-`; transient OIDC cookies use `__Secure-`. Local HTTP development uses unprefixed names and `Secure=false`. The ID token is stored only in the encrypted, HttpOnly Auth.js JWT. The admin double-submit CSRF cookie is `HttpOnly`, `SameSite=Strict`, production `Secure`, and scoped to `/api/admin`.

## Session lifetime (30-minute idle, 12-hour absolute)

- At Keycloak sign-in the encrypted Auth.js JWT records a fixed `loginAt` and an `activeAt` time. Every authenticated admin request (admin page loads, the CSRF route, and all three `/api/admin/uploads` handlers) re-issues the session cookie with a new `activeAt`; `loginAt` is never changed.
- A session is rejected once **30 minutes** pass without such a request, or **12 hours** after `loginAt` regardless of activity. Sessions issued before this change carry no timestamps and are rejected once, forcing a fresh sign-in. The rules live in `lib/admin/server/session-policy.ts` and are applied in the Auth.js `jwt` callback.
- Proxy, the route handlers and the admin page all read the session through the same Auth.js session action (`lib/admin/server/session.ts`), so they apply identical rules. `/api/admin/uploads` bypasses Proxy and validates the session in its own handler. The no-argument `auth()` helper discards the re-issued cookie, so the loader uses Auth.js's API-route form and forwards only the session cookie.
- Expired page requests redirect to Keycloak sign-in; expired API requests return 401 `UNAUTHENTICATED`, and the expired cookie is cleared. The admin UI tells the user to reload and sign in again.
- Auth.js `session.maxAge` is set to the idle timeout, so each re-issued JWT and cookie also expire 30 minutes after the last activity; the 12-hour limit comes from `loginAt`.
- Activity is recorded when a request **starts**. If a single file upload takes longer than 30 minutes (500 MB needs a sustained ~2.3 Mbit/s or more to finish sooner), that upload still completes, but the next request requires signing in again.
- These are application sessions. If the Keycloak realm's SSO session outlives them, re-authentication may complete without a password prompt. Align the Keycloak client/realm **SSO Session Idle** and **SSO Session Max** with 30 minutes / 12 hours if the requirement applies to the SSO session too (see open questions).
- JWT sessions cannot be revoked server-side. A copied session cookie stays usable until it expires under the rules above.

## Runtime configuration

Inject `AUTH_SECRET`, `AUTH_URL`, `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_UPLOADER_ROLE`, `KEYCLOAK_ADMIN_ROLE`, `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_REGION`, `QDRANT_URL` and `QDRANT_API_KEY` at server runtime via the approved Nomad/Vault mechanism. **`QDRANT_COLLECTION` has been removed** and is no longer read; remove it from deployment templates. `QDRANT_API_KEY` is optional only when the actual Qdrant service permits no-key access. Never commit real credentials.

- `ADMIN_UPLOAD_MAX_MB` is the server-enforced runtime value (default **100 MB**, valid range 1–500). The authenticated server page passes it to the UI, so raising it does not require rebuilding the JavaScript bundle. Optional `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB` is a build-time **UI-only ceiling**; leave it unset to let the UI follow the runtime limit. Verify APISIX, Cloudflare Tunnel and MinIO size and timeout limits before raising it in production.
- `ADMIN_UPLOAD_MAX_CONCURRENT` (default **4**, range 1–16) caps concurrent uploads **per Node.js process** (see below).

`ADMIN_TRUSTED_PROXY_SECRET` is optional and unset by default. Only set it when the trusted APISIX ingress strips any client-supplied `x-auraplex-proxy-secret` and injects the matching secret itself, with no direct public path to the application. Only then does audit logging prefer `cf-connecting-ip`; otherwise it ignores that header. The Nomad `NEXT_PUBLIC_SITE_URL` matches the Dockerfile's `https://www.auraplex.info` default, but live DNS, TLS, canonical redirects and Keycloak `AUTH_URL`/allowed redirect registration still require operational confirmation. Since `NEXT_PUBLIC_SITE_URL` is build-time, the Docker image must also be built for the intended host.

Next.js 16 with this repository's Cache Components configuration rejects an explicit route-segment `runtime = 'nodejs'` export. Route Handlers use Next's Node default; each admin handler calls `assertAdminNodeRuntime()` and fails closed if launched under Edge. The Nomad standalone deployment runs `node server.js`.

## Business lines, object keys and Qdrant routing

The uploader picks one of **five business lines** (`labelling`, `packaging`, `automation`, `software`, `consulting`) and a product. Storage and search use one of **three ingest lines**, each with one of **three Qdrant collections**:

| Business line | Ingest line | Qdrant collection |
| --- | --- | --- |
| labelling, packaging, automation | `machines` | `auraplex_machines` |
| software | `software` | `auraplex_software` |
| consulting | `consulting` | `auraplex_consulting` |

- Object key: `{ingest_line}/{product.slug}/{sanitized_filename}` — exactly three segments, e.g. `machines/flexy-applicator/bottom-labelling-machine-brochure.pdf`. `product.slug` (not the numeric product ID) is the second segment.
- Qdrant `payload.source_key`: `{bucket}/{key}`, e.g. `auraplex-raw-pdf/machines/flexy-applicator/bottom-labelling-machine-brochure.pdf`. One builder (`lib/admin/source-key.ts`) serves upload responses, status lookup and delete.
- One resolver (`qdrantCollectionForSourceKey`) serves both status and delete. Unknown or legacy prefixes (for example keys written earlier under `labelling/...`) fail explicitly: there is no default collection and no scan of all collections. The status list reports such objects as **unsupported**, and delete rejects them with 400; clean up any pre-contract test objects manually.
- Physical-machine products still validate a real catalogue `product_id`. Software and consulting have no catalogue products yet: the UI shows both lines as "no products configured yet" and the server rejects them with `INVALID_PRODUCT`. Add real products in `lib/admin/upload-products.ts` when they exist; never add placeholder IDs or slugs.

## Upload streaming, sizes and limits

Path: `request stream → byte counter (+ idle timer) → MIME inspection → replay of inspected bytes → Node Readable → S3`. The whole file is never collected in application memory.

- **Content-Length is optional.** When present it must be a positive integer; oversize declarations are rejected with 413 before any storage call, and a received/declared mismatch fails as `SIZE_MISMATCH`. When absent (chunked requests), the counted stream is authoritative: it enforces the runtime maximum (413), and a completed zero-byte body fails as `EMPTY_FILE`.
- **Known length** keeps the single-part `PutObject`. **Unknown length** uses `@aws-sdk/lib-storage` `Upload`, because single-part `PutObject` cannot send an unsized stream: the installed SDK fails before sending (`x-amz-decoded-content-length` is required by its aws-chunked checksum framing), and with checksums disabled it would send an unsized chunked PUT, which S3/MinIO reject. `Upload` uses 8 MiB parts with 2 concurrent part uploads. Bodies smaller than one part are sent as a single sized `PutObject`. Failed or cancelled multipart uploads send `AbortMultipartUpload` (`leavePartsOnError: false`).
- A failure while the body streams (oversize, size mismatch, rate-limit volume, MIME rejection, idle timeout, client disconnect or storage error) returns the corresponding HTTP error instead of leaving the client hanging. The SDK receives a shielded stream for `PutObject`, and every body failure aborts the storage call through its signal.

### Per-process upload concurrency

`PUT /api/admin/uploads` takes a slot from an in-process guard after authentication, header validation and CSRF, and **before** the body is read, the rate limit is charged or storage is contacted. When all slots are in use it returns **503 `UPLOAD_CAPACITY_EXHAUSTED`** ("retry shortly"; the UI marks the file retryable). The slot is released in `finally` on every outcome; tests cover success, storage failure, oversize, size mismatch, MIME rejection, client disconnect/abort and idle timeout.

The default of **4** is sized for the 1 GiB Nomad task. Measured locally (Node 24, 100 MiB bodies, local S3 sink): 4 concurrent unknown-length uploads added ~145 MiB RSS (~36 MiB each), 8 added ~260 MiB, and 4 known-length uploads added ~10 MiB. This is a **per-process limit, not a distributed or cluster-wide one**: with N allocations, up to N × the limit uploads can run. It is not a queue; excess requests fail fast.

### Slow, stalled and abandoned uploads

- There is **no total upload duration limit** in the application; a slow but progressing 500 MB upload is not cut off.
- Node's HTTP server does not time out a stalled request body once Next.js has dispatched the handler (verified locally on Node 24: a body stalled with the connection open was never timed out, while a slow but steady one was not affected by `requestTimeout`). So the byte counter has a **no-progress timeout of 120 seconds**: if no bytes move through the upload for 120 s it fails with **408 `REQUEST_TIMEOUT`**, aborts the storage request and frees the slot. Bytes move only when storage consumes them, so a MinIO that stops accepting parts also counts as no progress.
- The MinIO client uses a 10 s connection timeout and a **120 s socket-inactivity** timeout (`socketTimeout`, not a total-request timeout), so a MinIO that stops answering, e.g. to `CompleteMultipartUpload` after the body finished, cannot hold an upload forever.
- The 120 s value applies **per inactive S3/MinIO request**. It is not an upper bound on how long background cleanup can hold resources after a failure or cancellation: the AWS SDK's retries each get their own inactivity window, and in-flight part uploads and the background `AbortMultipartUpload` run on after the HTTP response has been sent. The HTTP response and the upload slot do not wait for any of them.
- A client disconnect aborts through the request signal as before.
- Ingress timeouts (APISIX, Cloudflare Tunnel) still apply in front of the application and must allow the largest configured upload; see validation below.

### Multipart failure and cleanup

- On any body failure or cancellation the upload is aborted immediately, so the HTTP response and the concurrency slot never wait for MinIO cleanup. lib-storage still sends `AbortMultipartUpload` in the background. Tests cover a delayed abort (response still immediate) and a failing abort (the original error is still returned, nothing is thrown uncaught).
- If `CompleteMultipartUpload` fails after all parts were uploaded, lib-storage does not abort on its own, so the adapter sends a best-effort `AbortMultipartUpload` for that `UploadId` in the background (capped at 30 s including SDK retries). The request fails immediately with the **original completion error** (500 `INTERNAL_ERROR`); a failing or hung abort cannot replace or delay it, and the slot is released. The final object key is never deleted as cleanup, because an existing object may already be stored under it. Tests cover a successful, failing and hung abort after a completion failure.
- lib-storage does not cancel part uploads already in flight. After a failure, up to two in-flight 8 MiB parts can stay in memory until they finish or the socket timeout fails them (120 s of inactivity per attempt, so SDK retries can extend this); this only matters when MinIO itself is stalled.
- No success response is ever returned for an incomplete object.
- The application **cannot guarantee cleanup** if the process crashes or is killed mid-upload, if `AbortMultipartUpload` itself fails or times out, or if a request is cancelled while `CompleteMultipartUpload` is already in progress. **Required:** configure a MinIO lifecycle rule on `auraplex-raw-pdf`, `auraplex-raw-image` and `auraplex-raw-video` that aborts incomplete multipart uploads (`AbortIncompleteMultipartUpload`) after a period **chosen and confirmed by ops**. It must be longer than the longest legitimate upload; this repository does not set a value. The in-application aborts are best-effort and do not replace this rule.

### Rate limits

Rate limiting counts **one admission per upload** (20/minute, 200/hour) separately from **byte volume** (5 GiB/hour). The declared size is reserved at admission; an unknown-length upload reserves up to the per-file maximum (bounded by the remaining hourly volume), which the byte counter enforces as 429. Concurrent uploads by one user therefore cannot jointly exceed the remaining volume. Every upload then settles to the bytes actually received, including failed uploads, releasing any unused reservation. Audit events and the success response report actual received bytes.

Known limitations: bytes are recorded at the **admission time** of the upload, so a long upload's volume leaves the rolling hour one hour after it started, not after it finished. The limiter (like the concurrency guard) is per process, not global across allocations, and resets on restart. The chunk that crosses a reservation is counted before the 429, so volume can exceed the quota by at most one network chunk.

## Storage, status and deletion

Accepted formats are PDF, DOCX, PNG, JPG/JPEG and MP4. PDF and DOCX use `auraplex-raw-pdf`, PNG and JPG/JPEG use `auraplex-raw-image`, and MP4 uses `auraplex-raw-video`. Non-PDF files are stored but not ingested here and stay **pending** with **Ingestion support coming**. PDF stays **pending** until matching `source_key` evidence is observed in Qdrant. Unsupported is reserved for unsupported types and for objects outside the ingest taxonomy.

**Failed status:** missing Qdrant evidence is never reported as failed, because it can simply mean ingestion is still running or the worker is stopped. `failed` stays in the status model but is only shown for an explicit upstream failure signal. No such signal exists in this repository or the documented ingest contract (the RFC lists it as an open question), so the UI does not currently show `failed` for ingestion. Friendy/infrastructure must define a per-`source_key` failure signal (for example a failure record or task state) before it can be wired in.

**Same key, stale evidence:** the same product and sanitized filename map to the same object key, so a re-upload replaces the MinIO object. Qdrant points for the previous file keep the same `source_key` until the ingest worker re-processes it, so status can show **processed** based on the old file's evidence, and search can return old content in the meantime. The status check reads no payload, and nothing currently known about the Qdrant payload (only `source_key`) can tie points to a specific upload, so this is a **known limitation**. A fix would need an upstream payload field such as the object's ETag or `upload-id` metadata (which the upload already stores on the object); that is a Friendy/ingest decision. Replacement/versioning is a separate business decision.

Recent uploads: uploaders see only their own objects; admins see all. Ownership is stored in object metadata, so the listing checks metadata newest-first in batches of 25 until 50 matching objects are found, rather than filtering after a global newest-50 cut. The cost grows with the number of other users' objects checked; a metadata index is a separate follow-up if bucket sizes grow large.

Admin delete validates the bucket and the ingest-taxonomy key (it does not require the product to still exist in today's catalogue), deletes Qdrant points by exact `{bucket}/{key}` `source_key` with `wait: true` in the routed collection, then deletes the MinIO object. After Qdrant succeeds but MinIO fails, the response is `PARTIAL_DELETE` and the object can remain. An outage/timeout after an external operation can also make the final state uncertain; investigate before retrying.

MinIO permissions (`docs/deployment/minio-admin-upload-policy.json`) include `s3:AbortMultipartUpload`. `PutObject` covers create/upload-part/complete. The incomplete-multipart lifecycle rule above is a separate bucket setting, not part of the service-account policy.

## Secret scanning

`.github/workflows/secrets-scan.yml` runs gitleaks on pull requests, on pushes to `main`, `codex/**` and `docs/**`, and on manual dispatch. It downloads the gitleaks CLI v8.30.1, verifies its SHA-256, scans the full git history with `--redact`, and fails the job on any finding. It uses no repository secrets (the `gitleaks-action` wrapper was not used because it requires a license key on organization accounts). A local run of the same version on 2026-09-28 found no leaks in the branch history (141 commits) or in the uncommitted working tree.

## Still requires real-environment validation

- **The production 500 MB test has not been run.** The Node → APISIX → Cloudflare Tunnel path must forward bodies up to the configured maximum, with and without Content-Length, without buffering or truncating them. Confirm the Cloudflare plan's request-body limit (Cloudflare documents 100 MB on Free/Pro, 200 MB on Business and 500 MB by default on Enterprise), and APISIX `client_max_body_size` and send/read timeouts.
- The MinIO server version accepts lib-storage multipart uploads with the SDK's default CRC32 checksums, and `AbortMultipartUpload` works under the service-account policy.
- The incomplete-multipart lifecycle rule exists on all three buckets, with an ops-confirmed duration.
- Real memory headroom of the production Next.js process under the default concurrency of 4.
- The ingest worker's `parse_key()` and Qdrant payload use the confirmed key and `{bucket}/{key}` `source_key`, and the three collections exist.
- Keycloak redirect and logout registration, SSO session idle/max settings, trusted forwarded headers, and the exact production secret paths.
