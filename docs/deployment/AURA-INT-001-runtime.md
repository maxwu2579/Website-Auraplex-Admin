# AURA-INT-001 Runtime and Deployment Notes

## Verified locally versus production

Local automated tests (`npm test`) cover upload validation, the business-line → ingest-line mapping, the object-key and `source_key` contracts, Qdrant collection routing, optional Content-Length with actual byte accounting, complete stream replay after MIME inspection, server-side group/CSRF/rate-limit checks without Proxy, stable error responses, status mapping, deletion order and partial failure. They also cover:

- `tests/admin-session.test.ts` — the 30-minute idle and 12-hour absolute session limits, run through the real Auth.js session pipeline (encrypted session cookies, the app's `jwt` callback, re-issued cookies) with an injected clock, including the Proxy-bypassed upload handler and a Proxy/route-handler consistency matrix.
- `tests/admin-revalidation.test.ts` — the 60-second Keycloak revalidation against an in-process fake Keycloak (discovery, JWKS, rotating refresh-token endpoint) reached through an injected `fetch`: freshness window, group replacement, `invalid_grant`, outage/5xx/malformed/forged responses, mandatory refresh-token rotation, ID-token `iat` and multiple-audience `azp` rules, the Proxy → handler pipeline across the 60-second mark, upload ownership across logins, concurrent single-flight, response ordering with a simulated browser cookie jar that applies every `Set-Cookie` and removal in completion order (a slow response finishing after a newer refresh, a late `invalid_grant` for a consumed refresh token, three generations out of order, removed groups, `loginAt`, freshness, legitimate removals on idle/12-hour expiry and Keycloak revocation, an old login's late response after a new sign-in or sign-out, two browsers of one user, the native Auth.js `/api/auth/session` and `/api/auth/signout` routes through the real handlers and route wrapper, a probe showing that network arrival order is outside this protection, bounded coordinator state), interaction with the idle/absolute limits, Proxy/handler consistency, and that provider tokens stay out of the session JSON and logs. No test contacts a real Keycloak.
- `tests/admin-storage.test.ts` — the real AWS SDK against an in-process S3 endpoint: single-part, multipart, abort cleanup, body failure, a delayed or failing `AbortMultipartUpload`, a failed `CompleteMultipartUpload` (with successful, failing and hung abort), stalled clients and a stalled MinIO part upload.
- `tests/admin-upload-limits.test.ts` — the per-process concurrency guard (capacity, release after success and every failure mode) and rate-limit reserve → settle behaviour.
- `tests/admin-upload-ui.test.tsx` — the react-dropzone input/accept contract (server-rendered).

A local HTTP run against the standalone production server (`node .next/standalone/server.js`, throwaway credentials, local S3 sink) exercised uploads above 10 MiB with and without Content-Length. **Real Keycloak, MinIO, Qdrant, Cloudflare/APISIX, Nomad and ingest behavior have not been verified, and the production 500 MB APISIX/Cloudflare Tunnel test has not been run.** Do not infer production readiness from local runs.

The 2026-09-24 `npm audit` and `npm audit --omit=dev` checks each report 44 dependency advisories (2 critical, 20 high, 17 moderate, 5 low). The critical entries are `next` and transitive `tar`. Apart from adding `@aws-sdk/lib-storage` (matched to the installed `@aws-sdk/client-s3` 3.1136.0), `react-dropzone` 14.4.1 and a direct declaration of `jose` (already installed at 6.2.12 through `next-auth`; used to verify refreshed ID tokens), no dependency upgrades were made; see [the dependency review](AURA-INT-001-dependency-review.md). Triage and remediate before production security sign-off.

## Routes and security boundaries

- `/admin/upload` is server-gated before the product list or upload workspace renders.
- `proxy.ts` runs for `/admin/:path*`, `/api/admin` and `/api/admin/*` **except** `/api/admin/uploads`. Whenever Proxy runs, Next.js 16 tees the request body into an in-memory clone capped by `proxyClientMaxBodySize` (default 10 MiB) and truncates the Route Handler's copy at that cap. A local HTTP test reproduced this (Next logged `Request body exceeded 10MB for /api/admin/uploads`, and the handler saw only 10 MiB). Raising the cap would buffer whole uploads in memory, so the upload endpoint is excluded from the matcher instead.
- Session authentication happens once per request, in one of two places that share the same code (`lib/admin/server/session.ts`):
  - **Proxy-covered paths** (`/admin/*`, `GET /api/admin/csrf`): Proxy reads the Auth.js session, applies the expiry rules below and the 60-second Keycloak revalidation, and sets the re-issued or cleared session cookie. It hands the authenticated identity to the page or the CSRF route in an encrypted request header. The CSRF route does **not** read the Auth.js session again; it takes that identity and checks the uploader group itself. Only if the handoff is absent or does not decrypt (Proxy did not run) does it read the session in place, with the same rules.
  - **`/api/admin/uploads`** (`PUT`, `GET`, `DELETE`) is intentionally excluded from Proxy and runs the common session wrapper (`withAdminRequestSession`) itself: the same session read, revalidation and cookie handling, with no Proxy involved.
- Every handler authorizes Keycloak ID-token `groups` itself, whichever of the two authenticated the request. `PUT` also enforces double-submit CSRF, rate limits, the concurrency limit and validation, and `DELETE` requires the Admin group plus CSRF. Tests cover anonymous, expired, non-uploader, missing/mismatched CSRF and rate-limited uploads with no Proxy involved.
- Group names are exact, case-insensitive matches to `KEYCLOAK_UPLOADER_ROLE` and `KEYCLOAK_ADMIN_ROLE`, defaulting to `auraplex-uploader` and `auraplex-admin`. Realm/client roles do not grant access. Configure Keycloak to place groups in the ID token.
- Logout uses OIDC discovery's `end_session_endpoint` with a server-held `id_token_hint`, clears the Auth.js session, then redirects through Keycloak back to `/signed-out` on the configured `AUTH_URL` origin (register `<AUTH_URL>/signed-out` as a valid post-logout redirect URI on the client). Discovery has a 1.5-second timeout; if unavailable or the ID token is missing, local Auth.js logout still completes and redirects to `/signed-out`. In that fallback the upstream Keycloak SSO session is **not confirmed terminated**. Verify post-logout URI registration in the real client.
- Auth.js session/CSRF cookies use `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` in production. The production session and CSRF cookies use `__Host-`; transient OIDC cookies use `__Secure-`. Local HTTP development uses unprefixed names and `Secure=false`. The ID token and the Keycloak refresh token are stored only in the encrypted, HttpOnly Auth.js JWT; neither appears in the session JSON, API responses, logs or audit events. The admin double-submit CSRF cookie is `HttpOnly`, `SameSite=Strict`, production `Secure`, and scoped to `/api/admin`.

## Session lifetime (30-minute idle, 12-hour absolute)

- At Keycloak sign-in the encrypted Auth.js JWT records a fixed `loginAt` and an `activeAt` time. Every authenticated admin request (admin page loads, the CSRF route, and all three `/api/admin/uploads` handlers) re-issues the session cookie with a new `activeAt`; `loginAt` is never changed.
- A session is rejected once **30 minutes** pass without such a request, or **12 hours** after `loginAt` regardless of activity. Sessions issued before this change carry no timestamps and are rejected once, forcing a fresh sign-in. The rules live in `lib/admin/server/session-policy.ts` and are applied in the Auth.js `jwt` callback.
- Proxy and the upload route handlers read the session through the same Auth.js session action (`lib/admin/server/session.ts`), so they apply identical rules; the admin page and the CSRF route, which run behind Proxy, use the identity Proxy authenticated for that request. `/api/admin/uploads` bypasses Proxy and validates the session in its own handler. The no-argument `auth()` helper discards the re-issued cookie, so the loader uses Auth.js's API-route form and forwards only the session cookie.
- Expired page requests redirect to Keycloak sign-in; expired API requests return 401 `UNAUTHENTICATED`, and the expired cookie is cleared. The admin UI tells the user to reload and sign in again.
- Auth.js `session.maxAge` is set to the idle timeout, so each re-issued JWT and cookie also expire 30 minutes after the last activity; the 12-hour limit comes from `loginAt`.
- Activity is recorded when a request **starts**. If a single file upload takes longer than 30 minutes (500 MB needs a sustained ~2.3 Mbit/s or more to finish sooner), that upload still completes, but the next request requires signing in again.
- These are application sessions on top of the Keycloak SSO session (confirmed: SSO Session Idle 30 minutes, SSO Session Max 10 hours). Keycloak's 10-hour maximum ends the effective session before the local 12-hour limit; see the next section.
- There is still no server-side session store, but a session no longer outlives Keycloak's view of the user by more than 60 seconds: disabling the user, ending the SSO session or removing a group takes effect at the next revalidation. A copied cookie whose refresh token has since been rotated is refused by Keycloak once its own 60-second window ends.

## Keycloak revalidation (60-second authoritative window)

Confirmed by Friendy: cached Keycloak groups may be trusted for at most **60 seconds**. This is a separate rule from the idle timeout, the absolute lifetime and the access-token lifespan, and is defined on its own as `KEYCLOAK_REVALIDATION_WINDOW_SECONDS` in `lib/admin/server/session-policy.ts`. It is not an environment setting.

Confirmed Keycloak settings this design relies on:

| Setting | Value |
| --- | --- |
| Access token lifespan | 5 minutes |
| SSO Session Idle | 30 minutes |
| SSO Session Max | 10 hours |
| Refresh token | online, **rotated on use**; its lifetime follows the Keycloak session |
| Deployment | a single Node.js instance |

How it works:

- At sign-in the encrypted Auth.js JWT additionally stores the Keycloak refresh token, its expiry, the Keycloak subject (`keycloakSub`), the groups and `lastValidatedAt`. `token.sub` remains Auth.js's own per-login user id and is not replaced. The access token is not kept. A sign-in that returns no refresh token is rejected. `keycloakSub` is read from the encrypted JWT on the server only; it is not part of the session JSON the browser can fetch.
- Every authenticated admin request checks the local idle/absolute limits **first**, then freshness. Under 60 seconds since `lastValidatedAt`, the stored groups are used and Keycloak is not contacted. At 60 seconds or more, the request redeems the refresh token at Keycloak's token endpoint (found through OIDC discovery on `KEYCLOAK_ISSUER`, and required to live under that issuer) before authorization continues.
- The returned ID token is verified against Keycloak's JWKS: signature, issuer, audience (`KEYCLOAK_CLIENT_ID`, and `azp` when present), subject equal to `keycloakSub`, expiry, and `iat` (required, and not more than 30 seconds in the future, the same clock tolerance used for `exp`). With more than one audience, `azp` must be present and equal to the client ID. Its `groups` **replace** the stored groups; they are never merged, so a removed group stops authorizing at the next revalidation (within 60 seconds). `lastValidatedAt` moves only on such a success; ordinary activity updates `activeAt` only.
- Rotation is mandatory. A successful refresh must return a new refresh token, which is stored in the re-issued cookie. A response without one (or repeating the token just presented) is treated as a protocol failure: no validation is recorded, the spent token is not kept, and the request gets the 503 below.
- The local limits are unchanged: 30-minute idle, 12-hour absolute from a fixed `loginAt`. A refresh never moves `loginAt`, and the absolute limit is checked again after the Keycloak round trip. The 12-hour limit is an upper bound only: **Keycloak's 10-hour SSO Session Max ends the effective session earlier**, because the refresh is then refused.
- The logic lives in `lib/admin/server/keycloak-revalidation.ts` and runs in the Auth.js `jwt` callback, so Proxy and all three `/api/admin/uploads` handlers (which bypass Proxy) get it from the same session read, and the CSRF route and admin page get Proxy's result. No handler contains refresh logic of its own.

Failure behaviour when revalidation is due (fail closed):

| Keycloak outcome | Result |
| --- | --- |
| `invalid_grant` (revoked or expired refresh token, ended SSO session, disabled user) | Local session cleared; API **401 `UNAUTHENTICATED`**, pages redirect to sign-in |
| Fresh groups lack the required group | Normal **403 `FORBIDDEN`** |
| Timeout (5 s for discovery, JWKS and token request together), network failure, HTTP 5xx, or another non-`invalid_grant` rejection such as `invalid_client` | **503 `IDENTITY_PROVIDER_UNAVAILABLE`**; nothing privileged runs; stale groups are not used; the cookie is neither re-issued nor cleared, so `activeAt` and `lastValidatedAt` do not move and the browser can retry |
| Malformed response, a response without a new refresh token, or an ID token failing any check above | Same 503; no groups are taken from it |

A Keycloak outage therefore blocks all admin use within 60 seconds, for as long as it lasts. Each 503 writes one JSON line to stderr (`type: "admin_session_revalidation"`, with a `reason` only; never a token).

Refresh-token rotation and concurrency:

- Parallel browser requests can arrive with the same cookie. Redeeming a rotated refresh token twice would fail, so refreshes are coordinated **in process**: requests with the same refresh state share one Keycloak call, and a successful result is **eligible for reuse for 10 seconds** by requests still carrying the previous cookie. The state is two maps keyed by a SHA-256 digest (not the raw token): refreshes in flight, and reusable results. Each is capped at 256 entries, so up to about 512 entries can exist in total. In-flight entries are removed when the call completes; beyond the cap a refresh is refused (503) rather than queued. Reusable results are cleaned up lazily: an expired entry is never reused, but it is only deleted when it is next looked up, when another result is stored, or when the cap evicts the oldest. The 10 seconds is therefore a reuse limit, not a promise that the entry (which holds the rotated refresh token in memory) is gone at exactly 10 seconds.
- **These guarantees hold only for the confirmed single Node.js process.** With more than one instance, a second instance would redeem an already-rotated refresh token, be refused, and end the session. Running several instances needs a shared store or sticky routing first.
- If the browser does not receive the response carrying the rotated cookie (for example an aborted request), or Keycloak's answer is rejected after the token was already redeemed, the old refresh token is spent: once the 10-second reuse window has passed, the next request gets 401 and the user signs in again. The same applies while a slow request is the only one that has received a new generation: a second request sent with the old cookie more than 10 seconds later, and before the slow response arrives, is refused by Keycloak.

### Response ordering for the session cookie

Requests of one browser overlap, and their responses do not finish in the order the requests started. Every response used to apply its own view of the session cookie: the cookie re-issued from the refresh token that request ended up with, or its removal when that request found the session ended. A response that finished late could therefore undo a newer state:

- a slow request (a long upload) that had refreshed RT0 → RT1 finished after the browser already held RT2, and wrote RT1 back; RT1 is consumed, so the next revalidation was refused and the user signed out;
- an older request still carrying consumed RT1 was refused by Keycloak (`invalid_grant`) and its 401 removed the cookie, deleting the valid RT2 session;
- a request of a previous login finished after the same browser had signed in again, and replaced or removed the new login's cookie.

What decides the cookie now is recorded in three places.

**In the encrypted session JWT** (not in the session JSON, and not logged):

| Claim | Meaning |
|---|---|
| `browserInstanceId` | Random id of the browser profile the login came from (see below) |
| `loginId` | Random id of one Keycloak sign-in: the **login lineage**. Fixed for the life of that login; a new sign-in gets a new one |
| `refreshGeneration` | 0 at sign-in, +1 on every refresh-token rotation of that login |

Sessions issued before this change carry none of these and are rejected once, like sessions issued before revalidation: the user signs in again.

**In a separate browser-instance cookie** (`auraplex.browser-instance`, `__Host-` prefixed in production): an opaque random UUID, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production, about 400 days, set or renewed only on the response that completes a sign-in (`/api/auth/callback/keycloak`). It is **not a credential**: it grants nothing, is not derived from the user and is not compared with a user or group. Its only use is to tell successive logins of one browser profile apart from logins on another browser or device, including for the same Keycloak user. It deliberately survives sign-out. A value that is missing or was not issued by the app is replaced.

**In the process-local coordinator** (the same one that single-flights refreshes):

- per `loginId`, the highest `refreshGeneration` known to exist (one entry per login, however often it rotates);
- per `browserInstanceId`, the `loginId` that is current there. A sign-in replaces it; a sign-out (the logout action and Auth.js's own sign-out route, through its `signOut` event) marks the browser as having no current login.

Each map holds at most 1024 entries, least recently written evicted first, and entries older than the 12-hour absolute session lifetime are dropped at the next write. A failed refresh records nothing.

**Reason for an ended session.** The `jwt` callback no longer reports every ended session as the same `null`. It hands the session loader an internal reason, used only to decide cookie handling:

| Reason | When |
|---|---|
| `local-idle-expired` | 30 minutes without an authenticated admin request |
| `local-absolute-expired` | 12 hours since `loginAt` |
| `refresh-succeeded-but-local-session-expired` | Keycloak refreshed the session, but a local limit passed during that round trip |
| `provider-current-session-rejected` | Keycloak refused the newest refresh token of the login (disabled user, ended SSO session, revoked) |
| `provider-superseded-refresh-rejected` | Keycloak refused a refresh token that a later successful refresh of the same login had already replaced |
| `not-revalidatable` | Session without timestamps, refresh state or lineage claims |

(Keycloak being unavailable is not an ended session: the request gets 503 and no cookie is touched, as before.) Authorization is unchanged and fails closed in every case: all of these deny the request.

**Commit rule.** When a response is about to be sent, its session cookie is decided as follows. The HTTP result of the request itself is not changed by any of this.

| Case | Session cookie |
|---|---|
| Current login of the browser, current refresh generation | Re-issued cookie is set |
| Same login, but a newer refresh generation is known | Stale re-issued cookie is **not set** |
| 401 because Keycloak refused a refresh token already known to be superseded | Removal is **not sent**; the request stays denied |
| Current login ended by idle or 12-hour expiry, including a refresh that succeeded while the limit passed | Cookie is removed |
| Current login refused by Keycloak on its newest refresh token | Cookie is removed |
| Response of a login the browser has signed out of, or has replaced by a newer sign-in | Neither set nor removed |
| Sign-out of the browser's current login | Cookie is removed |
| Delayed sign-out of a login the browser has already left | Removal is **not sent**; the request completes as usual |
| Revalidation could not be completed (503 / unavailable) | Cookie is left exactly as it is |
| Session that cannot be revalidated, or a cookie Auth.js cannot read | Cookie is removed, as before |

A removal is withheld only for the explicit superseded-refresh reason or for a login that is no longer the browser's current one. In particular it is not withheld merely because the refresh token a request carried has since been rotated: a request whose own refresh succeeded and then crossed the 12-hour limit still removes the cookie.

Where the rule is applied (one shared function, `mustWithholdSessionCookies`, for all three):

- **`/api/admin/uploads`** (direct, Proxy-bypassed): after the handler has finished, i.e. as late as the server can decide, so a long upload is covered.
- **Proxy-covered paths**: when Proxy hands the request on. Proxy cannot see when the page or handler behind it finishes, so a cookie that was current at handoff can still be overtaken while that code runs. Those requests are short, but this window exists.
- **The Auth.js routes** (`app/api/auth/[...nextauth]/route.ts`, GET and POST): Auth.js writes the session cookie itself on `/api/auth/session` (re-issue or removal) and `/api/auth/signout` (removal). Both methods run through one wrapper, which applies the rule to the finished Auth.js response using what the callbacks reported while that request was handled; the session is not read a second time. When the rule says the browser's session cookie must be left alone, only the session cookie and its chunks are taken out of the response. Status, body, other headers and all other cookies (CSRF, callback URL, state, PKCE, nonce, the browser-instance cookie) pass through unchanged. A stale `/api/auth/session` request is still answered with no session; it is not turned into a success.
- The **logout server action** applies the same check before it clears the cookie: a logout submitted from a login the browser has already left does not remove the newer session cookie (the Keycloak logout redirect for the submitted login still happens).

What is and is not protected:

- **Protected (server-side commit decisions):** the cookie written by the direct admin Route Handlers, by Proxy at handoff and by the Auth.js routes; the removal that follows a refused, already superseded refresh token; and responses of an old login versus a newer login of the same browser.
- **Not protected: network arrival order.** The rule orders responses as the server commits them. Two responses committed in the right order can still reach the browser in the other order, and the browser then keeps the older cookie. With `HttpOnly` cookies there is no small, robust fix for this: a second ordering cookie can itself arrive out of order, and signing a value does not stop an older valid value from being applied later. The consequence is an availability problem, not an authorization one: the next revalidation of that older cookie is refused by Keycloak and the user signs in again. A test demonstrates this case explicitly.
- **Process-local state, single Node.js instance.** Several instances would each have their own view and would need shared coordination first.
- **Restart or eviction** loses the ordering knowledge for the affected login or browser; it is then treated as current and its response applies its cookie, which is the behaviour before this change.
- **Deleted or blocked browser-instance cookie:** the next sign-in starts a new browser instance and is not linked to, or ordered against, the previous login.
- None of this state authenticates anything. A request arriving with an old cookie is still judged by the session limits and by Keycloak.

### One session decision per request behind Proxy

For Proxy-covered routes (`/admin/*`, `/api/admin/csrf`), Proxy reads the session and the page or Route Handler behind it used to read it again a moment later. Those two reads could fall on either side of the 60-second mark: Proxy accepted the request at 59 s and re-issued the activity cookie, then the second read at 61 s needed Keycloak, and if Keycloak was down the API answered 503 while still carrying Proxy's cookie, and the page failed after its HTTP 200 status had been sent.

Now Proxy's decision is the only one for the request. When Proxy allows a request it forwards the identity it authenticated in an encrypted request header (`x-auraplex-admin-identity`; same JWE as the session cookie, keyed by `AUTH_SECRET` with its own salt, valid 120 seconds). `currentRequestIdentity()` uses that identity instead of reading the session again. Proxy always overwrites the header, so a value sent by a client is discarded, and it is a request header only, never sent to the browser. The upload endpoint has no Proxy and ignores it; it still does its own single session read.

Consequences:

- A request Proxy accepted at 59 s completes, even if its handler runs at 61 s. The freshness rule is evaluated once per request, when Proxy reads the session.
- When revalidation is due and fails, Proxy answers before anything else runs: API paths get 503 `IDENTITY_PROVIDER_UNAVAILABLE`, admin pages get a plain 503 (`Cache-Control: no-store`), and no cookie is set, so neither `activeAt` nor `lastValidatedAt` is persisted for the denied request.
- If the handoff is absent or does not decrypt (Proxy did not run), the session is read in place with the same rules.

### Upload ownership identity

`uploaded-by` object metadata, the uploader's recent-uploads filter, the per-user rate limit and the `user` field of audit events all use the **Keycloak subject** (`keycloakSub`), which is the same on every login. Previously they used Auth.js's `token.sub`, a random UUID generated at each sign-in, so an uploader lost sight of their own uploads after logging in again. `token.sub` is unchanged and remains the application session's id (`session.user.id`); email is not used as an ownership key.

**Legacy metadata is not migrated.** Objects uploaded before this change carry an old per-login UUID in `uploaded-by`. That value cannot be mapped back to a Keycloak user, so those objects are not attributed to anyone and do not appear in any uploader's own list. Admins still see and can delete them, as before. Audit lines written before the change likewise contain the per-login UUID.

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

Recent uploads: uploaders see only their own objects (matched on the Keycloak subject; see [Upload ownership identity](#upload-ownership-identity)); admins see all. Ownership is stored in object metadata, so the listing checks metadata newest-first in batches of 25 until 50 matching objects are found, rather than filtering after a global newest-50 cut. The cost grows with the number of other users' objects checked; a metadata index is a separate follow-up if bucket sizes grow large.

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
- Keycloak redirect and logout registration, trusted forwarded headers, and the exact production secret paths.
- **Keycloak revalidation has only been tested against an in-process fake.** Confirm against the real realm: the refresh response includes an ID token carrying `groups`; the client authenticates to the token endpoint with HTTP Basic client credentials; a disabled user, a logged-out SSO session and a removed group each take effect within 60 seconds; the session ends at the 10-hour SSO maximum; and the larger (possibly chunked) session cookie passes APISIX/Cloudflare header limits.
