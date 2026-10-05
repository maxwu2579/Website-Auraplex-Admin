# Auraplex Admin — Deployment Readiness

This document covers what is needed to deploy the standalone Auraplex Admin
application. It does not contain production values: every value that has not
been confirmed is listed in [section D](#d-requires-confirmation-from-friendy)
and appears in the repository only as a placeholder.

Detailed runtime and security behaviour is in
[AURA-INT-001-runtime.md](AURA-INT-001-runtime.md). The original design is in
[the RFC](../rfc/AURA-INT-001-admin-upload.md).

**Status: not deployed. Nothing in this repository has been run against real
Keycloak, MinIO, Qdrant, APISIX, Cloudflare Tunnel or Nomad.**

## A. Implemented in code

- **Routes.** `/` and `/admin` redirect to `/admin/upload`; `/signed-out` is
  the public logout landing page; `/api/admin/*` and `/api/auth/*` serve the
  Admin APIs and Auth.js. There are no other pages.
- **Liveness endpoint.** `GET /api/health` returns `200` with
  `{"status":"ok","service":"auraplex-admin"}` and `Cache-Control: no-store`.
  It is public, reads no session and contacts neither Keycloak, MinIO nor
  Qdrant. It reports only that the server process is answering; it is not a
  readiness check for those services.
- **Authentication guard.** `proxy.ts` protects `/admin/*` and `/api/admin/*`
  except `/api/admin/uploads`, whose Route Handler authenticates each request
  itself so that large bodies are streamed rather than buffered.
- **Session rules.** 30-minute idle timeout, 12-hour absolute lifetime, and
  re-verification with Keycloak once the last verification is 60 seconds old,
  with mandatory refresh-token rotation. What happens when a re-verification
  does not succeed depends on why; see
  [Re-verification outcomes](#re-verification-outcomes).
- **Upload contract.** Object key `{ingest_line}/{product.slug}/{sanitized_filename}`,
  Qdrant `source_key` `{bucket}/{key}`, three fixed buckets and three fixed
  collections. See the README.
- **Container image.** `Dockerfile` builds the Next.js standalone server on
  `node:22-slim`, needs no secrets at build time, and runs as the unprivileged
  `node` user. `PORT` and `HOSTNAME` default to `3000` and `0.0.0.0`.
- **Job template.** `deploy/admin.nomad.hcl.example` is a non-runnable
  template with `CHANGE_ME_AURAPLEX_ADMIN_*` placeholders and a health check
  on `/api/health`.

## B. Validated locally

Validated with automated tests and local builds only:

- `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`.
- The automated test suite (`npm test`), which uses an in-process fake
  Keycloak and an in-process S3 endpoint.
- The built server answering the routes above over HTTP on a developer
  machine, with throwaway credentials.

**Not validated:** a Docker image build (Docker was not available where this
was prepared), the non-root runtime user inside that image, and everything in
sections C to E.

## C. Requires production configuration

### Environment

All variables are listed in `.env.example`. Every one is read at runtime
except `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB`.

| Group | Variables | Required |
| --- | --- | --- |
| App origin / runtime | `AUTH_URL` | yes |
| | `ADMIN_TRUSTED_PROXY_SECRET` | no; see the runtime notes before setting |
| | `PORT`, `HOSTNAME` | set by the image; override in the job |
| Auth / Keycloak | `AUTH_SECRET`, `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` | yes |
| | `KEYCLOAK_UPLOADER_ROLE`, `KEYCLOAK_ADMIN_ROLE` | no; default `auraplex-uploader`, `auraplex-admin` |
| Storage / MinIO | `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | yes |
| | `MINIO_REGION` | no; defaults to `us-east-1` |
| Qdrant | `QDRANT_URL` | yes, for status and delete |
| | `QDRANT_API_KEY` | only if the deployment requires a key |
| Upload limits | `ADMIN_UPLOAD_MAX_MB` | no; default 100, range 1–500 |
| | `ADMIN_UPLOAD_MAX_CONCURRENT` | no; default 4, range 1–16, per process |
| | `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB` | no; build-time UI-only ceiling |

`AUTH_URL` must be the exact public origin users reach, with no trailing
slash. In production it must be HTTPS: the logout redirect is refused
otherwise, and the session cookies use the `__Host-` prefix.

### Keycloak client

The client must be configured as follows. `<AUTH_URL>` stands for the
confirmed public origin.

| Setting | Required value |
| --- | --- |
| Valid redirect URI (callback) | `<AUTH_URL>/api/auth/callback/keycloak` |
| Valid post-logout redirect URI | `<AUTH_URL>/signed-out` |
| Root URL / web origin | `<AUTH_URL>`. Sign-in and logout are full-page redirects and token calls are made server-side, so no browser cross-origin access to Keycloak is needed. |
| Client authentication | Confidential client with a secret; the token endpoint is called with Basic client authentication. |
| Refresh tokens | Must be issued at sign-in and **rotated on every use**. A refresh that returns no new token is treated as a failure. |
| ID token claims | Must include `groups`. Access is decided by group membership only; realm and client roles do not grant access. |

Session and token timings the application relies on:

| Item | Value | Where it is set |
| --- | --- | --- |
| Access token lifespan | 5 minutes (expected) | Keycloak |
| Authoritative re-verification | every 60 seconds | fixed in code |
| Session idle timeout | 30 minutes | fixed in code |
| Session absolute lifetime | 12 hours | fixed in code |
| Keycloak SSO Session Idle / Max | 30 minutes / 10 hours, as previously confirmed | Keycloak |

The application does not keep the access token. Removing a user's group,
disabling the user or ending the SSO session takes effect at the next
re-verification, within 60 seconds. Keycloak's SSO Session Max ends a session
before the local 12-hour limit if it is shorter.

### Re-verification outcomes

The application does **not** contact Keycloak on every request. While the
last verification is less than 60 seconds old, the groups stored in the
encrypted session cookie are used. Once it is 60 seconds old or more, the
next authenticated request redeems the refresh token at Keycloak before
anything privileged runs. The result of that call decides what happens:

| Keycloak outcome | Result |
| --- | --- |
| Keycloak cannot be reached, times out, answers with a server error, or rejects the request for a reason other than the refresh token itself (for example a client misconfiguration) | Fail closed: **503** `IDENTITY_PROVIDER_UNAVAILABLE`. The stored groups are not used. The session cookie is left as it is, so the browser can retry. |
| The response is malformed, carries no new refresh token, or its ID token fails verification | The same **503**. Nothing from the response is trusted. |
| Keycloak explicitly rejects the refresh token (`invalid_grant`: token revoked or expired, SSO session ended, user disabled) | The session is no longer valid: the local session is cleared, APIs answer **401** `UNAUTHENTICATED`, pages redirect to sign-in, and the user must authenticate again. |
| The refresh succeeds but the fresh groups no longer include a required group | Access is denied: **403** `FORBIDDEN`. |

A Keycloak outage therefore blocks Admin use within 60 seconds, for as long
as it lasts, without signing anyone out.

### Logout

Signing out always clears the local Auth.js session and always ends on
`/signed-out`. What happens to the Keycloak SSO session depends on the path
taken:

- **Normal path.** The application finds Keycloak's logout endpoint through
  OIDC discovery and sends the browser there with the server-held ID token.
  Keycloak then returns the browser to `<AUTH_URL>/signed-out`. Ending the
  SSO session is Keycloak's action: it is expected, subject to Keycloak's
  behaviour and the client's configuration, and the application does not
  verify it.
- **Fallback path.** If discovery cannot be completed in time, or no ID token
  is held, the application still clears the local session and sends the
  browser straight to `/signed-out`. Keycloak is not involved, so the SSO
  session is **not** known to have ended, and nothing should describe it as
  ended. The user may still be signed in to Keycloak and to other
  applications that use it.

### Ingress

- The route must forward request bodies up to the configured upload size
  without buffering them, and must not cut long-running uploads short.
- `/api/health` and `/signed-out` must be reachable without authentication.
- `ADMIN_TRUSTED_PROXY_SECRET` may only be set if the ingress strips any
  client-supplied `x-auraplex-proxy-secret` header and injects its own.

### Storage and search

- The MinIO access key needs the permissions in
  [minio-admin-upload-policy.json](minio-admin-upload-policy.json) on
  `auraplex-raw-pdf`, `auraplex-raw-image` and `auraplex-raw-video`.
- An incomplete-multipart lifecycle rule should exist on all three buckets.
- Qdrant must allow read and delete on `auraplex_machines`,
  `auraplex_software` and `auraplex_consulting`.

### Single instance and restarts

The application must run as **one instance**. Part of its state lives only in
the memory of the Node.js process, is not shared between processes and is not
written anywhere. Running several instances, or load-balancing across them,
is not supported until that is redesigned.

A process restart is **not** transparent. Two kinds of state behave
differently:

**Survives a restart**, because it is carried in the browser's encrypted
session cookie and not in the server: the signed-in identity, the stored
groups, the sign-in time and last-activity time behind the 30-minute and
12-hour limits, the time of the last Keycloak verification, and the Keycloak
refresh token.

**Lost on a restart**, because it is process-local:

- upload rate-limit event history;
- upload byte reservations for the hourly volume limit;
- upload concurrency counters;
- coordination of refreshes in flight (single-flight);
- the short-lived cache of successful refresh results (reusable for 10
  seconds by requests still carrying the previous cookie);
- login-generation and browser ordering records, which decide whose response
  may write the session cookie;
- the in-memory caches of Keycloak discovery metadata and signing keys
  (JWKS).

Consequences of a restart:

- Uploads in progress are cut off and must be retried.
- Rate and volume limits start counting again from zero, so the limits are
  briefly looser than configured.
- A signed-in user whose cookie is still within its limits can usually carry
  on. Their next request is judged as described under
  [Re-verification outcomes](#re-verification-outcomes): Keycloak is
  contacted only if the last verification is 60 seconds old or more, not on
  every request.
- Users **may need to authenticate again**. This happens when the cookie has
  passed a limit, when Keycloak refuses the refresh token, or when a response
  carrying a rotated refresh token was lost in the restart so that the
  browser still holds a token Keycloak has already consumed.
- The ordering protection for overlapping responses starts empty: until new
  records exist, a late response from before the restart is not recognised
  as stale.

None of the lost state authenticates anyone. A restart does not let a request
through that the session limits or Keycloak would refuse. It also provides no
continuity across instances: nothing here is cluster-wide.

## D. Requires confirmation from Friendy

Only production and infrastructure facts are asked for here. None of them has
a value in this repository. Where the application already fixes something
(URI formats, collection names, bucket names), the item asks for confirmation
that the real system matches, not for a new definition.

| # | Item | Confirmed value |
| --- | --- | --- |
| 1 | Admin production origin / hostname (this becomes `AUTH_URL`) | |
| 2 | Keycloak client ownership and client ID: whether Admin uses a dedicated client or an approved existing one, and its ID | |
| 3 | Keycloak issuer / realm (this becomes `KEYCLOAK_ISSUER`) | |
| 4 | That the real client is configured as the application requires: a confidential client; Basic client authentication at the token endpoint; refresh-token rotation compatible with the application (a new refresh token on every use); and refreshed ID tokens that contain the `groups` claim | |
| 5 | That these two URIs, derived from item 1, are registered on the client: `<AUTH_URL>/api/auth/callback/keycloak` and `<AUTH_URL>/signed-out` | |
| 6 | APISIX route | |
| 7 | Cloudflare Tunnel hostname / routing | |
| 8 | Nomad job name | |
| 9 | Nomad service name | |
| 10 | Container image registry, name and tag strategy | |
| 11 | Internal service port | |
| 12 | Datacenter / node placement | |
| 13 | Production secrets source and path | |
| 14 | The existing MinIO endpoint, that the three required buckets exist, and that the Admin access key has the documented policy | |
| 15 | The existing Qdrant endpoint, and that it allows access to the three collections the application already uses | |
| 16 | That the production deployment respects the single-instance requirement (one allocation, no load-balancing across instances) | |
| 17 | The production upload size limit, and that APISIX, Cloudflare and any other ingress in the path allow at least that size | |

Items 8 to 12 replace the `CHANGE_ME_AURAPLEX_ADMIN_*` placeholders in
`deploy/admin.nomad.hcl.example`. The job, service and image names must not
be the public website's, and the port must not be the website's host port.

Also outstanding before sign-off: triage of the open `npm audit` findings in
[the dependency review](AURA-INT-001-dependency-review.md).

## E. Production smoke tests

To be run once, after the first deployment, against the real environment.
None has been run.

| # | Check | Expected |
| --- | --- | --- |
| 1 | `GET /api/health` | 200 with the fixed JSON body |
| 2 | Anonymous `GET /signed-out` | 200 |
| 3 | Anonymous `GET /admin/upload` | Redirect to Keycloak sign-in |
| 4 | Sign in as a user in the uploader or admin group | Upload workspace opens |
| 5 | Sign in as a user in neither group | Access refused |
| 6 | Remove a signed-in user's group in Keycloak | Access denied (403) within 60 seconds |
| 7 | End a signed-in user's Keycloak session, or disable the user | Within 60 seconds the user is signed out and must authenticate again |
| 8 | Sign out (normal path) | The browser passes through Keycloak's logout endpoint and lands on `/signed-out`; the local session is cleared. Then confirm in Keycloak that the SSO session has ended: the application does not verify this itself |
| 9 | Sign out while Keycloak discovery is unreachable from the application (fallback path), if this can be arranged safely | The browser still lands on `/signed-out` and the local session is cleared. The Keycloak SSO session is **not** expected to have ended; do not record it as ended |
| 10 | Upload a small PDF | Succeeds |
| 11 | Upload at the configured size limit, and just over it (500 MB boundary if the cap is raised to 500) | At the limit succeeds; over it is rejected |
| 12 | Upload a file whose contents do not match its type | Rejected |
| 13 | Upload with no product selected | Rejected |
| 14 | Inspect the stored object in MinIO | Bucket and key follow `{ingest_line}/{product.slug}/{sanitized_filename}` |
| 15 | Check the upload's status against Qdrant | Pending until evidence exists, then processed (PDF) |
| 16 | Open the recent uploads list | The upload is listed; uploaders see only their own |
| 17 | Delete the upload as an admin | Qdrant points and the MinIO object are removed |
| 18 | Read the application log | An audit line exists for each upload and delete |
| 19 | Restart the container, then repeat checks 1, 3 and 10 | The same results. A user who was signed in either continues or is asked to sign in again; both are acceptable. An upload that was in progress during the restart fails and must be retried. See [Single instance and restarts](#single-instance-and-restarts) |
