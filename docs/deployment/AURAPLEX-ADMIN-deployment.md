# Auraplex Admin — Deployment Readiness

This document covers what is needed to deploy the standalone Auraplex Admin
application. Three words are used with fixed meanings throughout:

- **Confirmed** — a value Friendy supplied.
- **Wired** — a value that is present in configuration in this repository.
- **Deployed** — running in production or staging. Nothing is.

[Section D](#d-confirmed-deployment-values) lists every confirmed value and
whether it is wired. What is still open is in [section E](#e-unresolved);
none of it has been guessed. No secret value is stored in this repository.
[Section G](#g-handoff-to-friendy) is the working list for taking the
application to staging and production.

Detailed runtime and security behaviour is in
[AURA-INT-001-runtime.md](AURA-INT-001-runtime.md). The original design is in
[the RFC](../rfc/AURA-INT-001-admin-upload.md).

**Status: not deployed. There has been no production deployment and no
staging deployment. Nothing in this repository has been run against real
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
- **Nomad job draft.** `deploy/admin.nomad.hcl` is a draft of the production
  job with the confirmed identity and a health check on `/api/health`. It is
  not production-ready and must not be submitted; see
  [The Nomad job draft](#the-nomad-job-draft). There is no staging job.

## B. Validated locally

Validated with automated tests and local builds only:

- `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`.
- The automated test suite (`npm test`), which uses an in-process fake
  Keycloak and an in-process S3 endpoint.
- The built server answering the routes above over HTTP on a developer
  machine, with throwaway credentials.

**Not validated:**

- A Docker image build. Docker was not available where this was prepared, so
  the image has never been built or started. A real `docker build` and a
  container smoke test (start it, `GET /api/health`, confirm the process runs
  as the `node` user) are required before deployment.
- `deploy/admin.nomad.hcl`. Nomad was not available either, so the file has
  not been through `nomad job validate` or `nomad job plan`.
- Everything in sections C to G.

## C. Requires production configuration

### Environment

All variables are listed in `.env.example`. Every one is read at runtime
except `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB`. They are not all mandatory. The
classification below follows what the code does when a variable is missing;
no variable is validated at startup, so a missing one shows up only when the
feature that needs it is used.

**A. Required for authentication**

| Variable | If missing |
| --- | --- |
| `AUTH_SECRET` | Every protected route answers 503. |
| `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` | Required together with `AUTH_SECRET`. Sign-in is impossible and protected requests are refused. |
| `AUTH_URL` | Not checked by the code. Logout cannot build the Keycloak logout redirect, so it clears the local session only and the Keycloak session stays open. Set it in every environment behind the ingress. |

**B. Required for upload and storage**

| Variable | If missing |
| --- | --- |
| `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | Uploads, the recent uploads list and delete answer 503 `BACKEND_NOT_CONFIGURED`. |

**C. Required for complete Qdrant functionality**

| Variable | If missing |
| --- | --- |
| `QDRANT_URL` | Uploads and the list still work. Processing status is unavailable and delete is refused, because a delete must remove the Qdrant points as well. |

**D. Optional or defaulted**

| Variable | Default |
| --- | --- |
| `KEYCLOAK_UPLOADER_ROLE`, `KEYCLOAK_ADMIN_ROLE` | `auraplex-uploader`, `auraplex-admin` |
| `MINIO_REGION` | `us-east-1` |
| `ADMIN_UPLOAD_MAX_MB` | 100; range 1–500 |
| `ADMIN_UPLOAD_MAX_CONCURRENT` | 4 per process; range 1–16 |
| `PORT`, `HOSTNAME` | `3000` and `0.0.0.0`, set by the image |

**E. Conditional**

| Variable | Set only when |
| --- | --- |
| `QDRANT_API_KEY` | the Qdrant deployment requires a key. |
| `ADMIN_TRUSTED_PROXY_SECRET` | the ingress strips any client-supplied `x-auraplex-proxy-secret` header and injects its own. See the runtime notes first. |
| `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB` | the UI must show a lower ceiling than the server cap. Build-time and UI-only; normally unset. |

`AUTH_URL` must be the exact public origin users reach, with no trailing
slash. In production it must be HTTPS: the logout redirect is refused
otherwise, and the session cookies use the `__Host-` prefix.

Confirmed values, and where each one is wired:

| Variable | Confirmed value | Wired |
| --- | --- | --- |
| `AUTH_URL` (production) | `https://admin-auraplex.auraplex.info` | yes, in `deploy/admin.nomad.hcl` |
| `AUTH_URL` (staging) | `https://admin-auraplex-staging.auraplex.info` | no; documented only, no staging job exists |
| `KEYCLOAK_ISSUER` | `https://keycloak.auraplex.info/realms/auraplex` | yes, in `deploy/admin.nomad.hcl` |
| `KEYCLOAK_CLIENT_ID` | `auraplex-admin-upload` | yes, in `deploy/admin.nomad.hcl` |
| `KEYCLOAK_CLIENT_SECRET` | source only: Vault path below | no; injection not wired |

One issuer and one client ID were supplied, with no separate staging client.
No value or source has been supplied for `AUTH_SECRET`, the MinIO variables
or the Qdrant variables; see [section E](#e-unresolved).

### Secrets

| Secret | Source |
| --- | --- |
| `KEYCLOAK_CLIENT_SECRET` | Vault: `kv/auraplex/admin-upload/keycloak_client_secret` |
| `AUTH_SECRET` | not supplied; required for authentication |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | not supplied; required for upload and storage |
| `QDRANT_API_KEY` | not supplied; needed only if Qdrant requires a key |

The Vault entry is a path reference only. No secret value, real or invented,
belongs in the job file, `.env.example`, the image or this document. Local
`.env` files are excluded from the Docker build context by `.dockerignore`.

How Nomad reads that path is **not wired**. This repository has no working
Vault/Nomad integration to copy, so `deploy/admin.nomad.hcl` carries a TODO
instead of guessed syntax.

### The Nomad job draft

`deploy/admin.nomad.hcl` is a draft of the production job. It is **not
production-ready and must not be submitted to Nomad.**

- That is a rule for people, not a technical lock. The file is meant to be
  well-formed HCL, so Nomad may accept it and schedule the job. Nothing in it
  disables it.
- Missing secrets would not stop it. The server process starts without them
  and `GET /api/health` answers 200, so the allocation can look healthy while
  nobody can sign in and nothing can be uploaded. A passing health check is
  not evidence that the deployment works.
- The blockers are listed at the top of the file and in
  [section E](#e-unresolved).
- It has not been validated: `nomad job validate` has not been run on it.
- It is the production job only. No staging job exists.

### Keycloak client

Realm `auraplex`, client `auraplex-admin-upload`, access type confidential.
`<AUTH_URL>` stands for the public origin of the environment.

The two URIs below are what the application uses today. They do **not** match
the URIs Friendy supplied, and this is not settled: see
[Keycloak callback and logout URIs](#keycloak-callback-and-logout-uris--blocked).

| Setting | Required value |
| --- | --- |
| Valid redirect URI (callback) | `<AUTH_URL>/api/auth/callback/keycloak` (what the application sends; registration **blocked**) |
| Valid post-logout redirect URI | `<AUTH_URL>/signed-out` (what the application sends; registration **blocked**) |
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

Traffic reaches the application through Node → APISIX → Cloudflare Tunnel.
Neither hostname is routed yet. When they are, each must reach the Admin
service of its environment:

| Environment | Public hostname | Must route to |
| --- | --- | --- |
| Production | `admin-auraplex.auraplex.info` | Consul service `admin-upload`, internal port `3000` |
| Staging | `admin-auraplex-staging.auraplex.info` | a staging Admin service that does not exist yet |

The APISIX route definitions and the Cloudflare Tunnel configuration are not
in this repository, and none is invented here. Only the production Nomad
identity was supplied; no staging job, node or image was, so the staging
hostname is documented and nothing more.

`3000` is the port the application listens on. Which host port APISIX must
reach is a separate, unresolved question; see [section E](#e-unresolved).

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

`count = 1` in the job limits the steady state. On its own it does not
guarantee that an old and a new allocation never run at the same moment
while the job is being updated or rescheduled. The draft defines no update
policy, and no rollout behaviour has been tested. Canary and scaling
settings must not be added; whether an update policy is needed to rule out
overlap is open.

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

## D. Confirmed deployment values

Confirmed by Friendy. These are settled and are not open questions. "Wired"
says whether the value is present in configuration in this repository. None
of it is deployed.

| Item | Confirmed value | Wired |
| --- | --- | --- |
| Production hostname | `admin-auraplex.auraplex.info` | yes, as `AUTH_URL` in the job draft |
| Staging hostname | `admin-auraplex-staging.auraplex.info` | no; documented only |
| Ingress path | Node → APISIX → Cloudflare Tunnel | no; not in this repository |
| Keycloak realm | `auraplex` | yes, as part of the issuer |
| Keycloak issuer | `https://keycloak.auraplex.info/realms/auraplex` | yes |
| Keycloak client ID | `auraplex-admin-upload` | yes |
| Keycloak access type | confidential | n/a; a Keycloak-side setting |
| Keycloak client secret source | Vault: `kv/auraplex/admin-upload/keycloak_client_secret` | no; path referenced in a comment only |
| Nomad job name | `admin-upload` | yes |
| Nomad task group | `web` | yes |
| Consul service name | `admin-upload` | yes |
| Internal application port | `3000` | yes |
| Datacenter | `acumen-local` | yes |
| Node placement | `auraplex01`, by constraint on `${node.unique.name}` | yes |
| Container image | `auraplex.local/admin-upload:v1` | yes; the image itself has not been built |
| Resources | CPU `500`, memory `512` MB | yes |
| Deployment model | single instance | yes, `count = 1` |

"Wired" means present in `deploy/admin.nomad.hcl`, which is a draft of the
production job. There is no staging job.

## E. Unresolved

Nothing below has been guessed or changed in code. Each item needs one
explicit answer before the first deployment.

### Keycloak callback and logout URIs — BLOCKED

**BLOCKED / awaiting Friendy confirmation.** The URIs supplied for the
Keycloak client differ from the ones the application uses.

| | Supplied by Friendy | Used by the application today |
| --- | --- | --- |
| Production callback | `https://admin-auraplex.auraplex.info/api/auth/callback` | `https://admin-auraplex.auraplex.info/api/auth/callback/keycloak` |
| Production logout | `https://admin-auraplex.auraplex.info/api/auth/logout` | post-logout redirect to `https://admin-auraplex.auraplex.info/signed-out` |
| Staging callback | `https://admin-auraplex-staging.auraplex.info/api/auth/callback` | `https://admin-auraplex-staging.auraplex.info/api/auth/callback/keycloak` |
| Staging logout | `https://admin-auraplex-staging.auraplex.info/api/auth/logout` | post-logout redirect to `https://admin-auraplex-staging.auraplex.info/signed-out` |

- The application has no `/api/auth/callback` route without the provider
  segment and no `/api/auth/logout` route. Auth.js completes sign-in on
  `/api/auth/callback/keycloak`, and logout returns to `/signed-out`.
- Keycloak compares redirect URIs exactly unless a wildcard is registered. If
  only the supplied URIs are registered, sign-in fails at the callback and
  Keycloak refuses the post-logout redirect.
- Application routes, the Auth.js configuration, the logout implementation and
  `post_logout_redirect_uri` are deliberately unchanged. The decision is one
  of: register the application's URIs on the client, or change the
  application to the supplied URIs.

### Other open items

| # | Item | State |
| --- | --- | --- |
| 1 | Final production upload cap | Not decided. 100 MB, 300 MB and 500 MB have all been mentioned. The code is unchanged: the server default is 100 MB, the supported range is 1–500, and `ADMIN_UPLOAD_MAX_MB` is not set in the job. One explicit value is needed, and APISIX and Cloudflare must allow at least that size. |
| 2 | Vault/Nomad injection of `KEYCLOAK_CLIENT_SECRET` | Path confirmed; mechanism not wired. Needed: the KV engine version, whether `keycloak_client_secret` is a secret or a field inside `kv/auraplex/admin-upload`, and the Vault role or policy for the job. |
| 3 | `AUTH_SECRET` | Value and source not supplied. |
| 4 | MinIO endpoint, access key and secret key | Not supplied. The three buckets must exist and the key needs the documented policy. |
| 5 | Qdrant URL and, if required, API key | Not supplied. |
| 6 | APISIX route definitions | Not in this repository. |
| 7 | Cloudflare Tunnel ID and configuration | Not in this repository. |
| 8 | Host port and network mapping | Confirmed: the application listens on internal port 3000. Not confirmed: that the host port must be statically bound to 3000. The draft keeps host networking and a static port from the reviewed template, which makes 3000 the host port on `auraplex01` too; the public website has been documented as listening on host port 3000. A dynamic host port mapped to internal port 3000 would fit what was confirmed equally well. The draft's networking is unchanged until this is answered. |
| 9 | Upload concurrency at 512 MB | The default of 4 concurrent uploads was measured against a 1024 MB task. It is unchanged; whether it fits in 512 MB has not been measured. |
| 10 | Staging deployment identity | Only the staging hostname was supplied. No staging job, node or image is defined. |
| 12 | Overlap during job updates | `count = 1` does not by itself rule out an old and a new allocation running briefly together. No update policy is defined and none has been tested. |
| 13 | Nomad validation | `nomad job validate` has not been run on the draft. |
| 11 | That the real client issues rotated refresh tokens and puts `groups` in refreshed ID tokens | Not verified against the real realm. |

Also outstanding before sign-off: the Docker build and container smoke test
described in section B, and triage of the open `npm audit` findings in
[the dependency review](AURA-INT-001-dependency-review.md).

## F. Production smoke tests

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

## G. Handoff to Friendy

This section is the working list for whoever takes the application to staging
and production. It repeats nothing as settled that is still open: every open
item points back to [section E](#e-unresolved).

**State at handoff.** The application is feature-complete and its automated
tests pass. It has not been deployed anywhere. The image has never been
built, and `deploy/admin.nomad.hcl` is a draft that has never been validated
and is **not safe to submit as it is**.

### G1. Decisions needed first

Nothing below can be finished without these. Each needs one explicit answer.

| # | Decision | Why it blocks |
| --- | --- | --- |
| 1 | Keycloak callback and logout URIs: register the application's URIs, or change the application to the supplied ones | Sign-in fails at the callback if the registered URI differs. See [G5](#g5-keycloak-uris). |
| 2 | How Nomad reads the Vault secret: KV engine version, whether `keycloak_client_secret` is a secret or a field, and the Vault role or policy for the job | The job has no secret injection. See [G4](#g4-environment-and-secrets). |
| 3 | Values or sources for `AUTH_SECRET`, MinIO and Qdrant | Authentication, uploads and status do not work without them. |
| 4 | Host port and network mode | The draft binds host port 3000 on `auraplex01`. See [G6](#g6-networking). |
| 5 | Final upload size cap | Sets `ADMIN_UPLOAD_MAX_MB` and the ingress body limit. See [G7](#g7-upload-limits). |
| 6 | Image tag strategy and how the image reaches `auraplex01` | Decides what CI publishes. See [G3](#g3-what-ci-must-build-and-publish). |
| 7 | Staging identity: job, node, image | Only the staging hostname exists. See [G9](#g9-staging-checks). |

### G2. Building the image

From the repository root, with Docker available:

```bash
docker build -t auraplex.local/admin-upload:v1 .
```

- The build needs no secrets and no build arguments. Do not pass any secret
  as a build argument; every secret is read at runtime.
- The one optional build argument is `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB`, a
  UI-only ceiling. Leave it out so the UI follows the server's runtime cap.
- `.dockerignore` keeps local `.env` files out of the build context.
- The image runs as the unprivileged `node` user and listens on port 3000.

This build has **never been run**: Docker was not available where the
repository was prepared. Before the image is used, smoke-test the container:

```bash
docker run --rm -d --name admin-upload-smoke -p 3000:3000 auraplex.local/admin-upload:v1
curl -i http://localhost:3000/api/health     # 200 {"status":"ok","service":"auraplex-admin"}
docker exec admin-upload-smoke id -un         # node
docker rm -f admin-upload-smoke
```

The container starts and answers the health check with no environment
variables set. That confirms the image only; it says nothing about sign-in
or uploads.

### G3. What CI must build and publish

The repository has one workflow today, `.github/workflows/secrets-scan.yml`
(gitleaks). There is no workflow that tests or builds. CI needs to:

1. Use Node.js 22 and run `npm ci`.
2. Run `npm run typecheck`, `npm run lint` and `npm test`. `npm test` must
   end with no failed and no cancelled tests. The tests need no internet
   access, no production services and no real secrets. Some of them start
   local HTTP servers, so the runner must allow loopback (`localhost`)
   connections.
3. Run `npm run build`.
4. Build the image as in [G2](#g2-building-the-image) and run the container
   smoke test.
5. Publish the image under the name the job uses,
   `auraplex.local/admin-upload`, somewhere Docker on `auraplex01` can pull
   it from.

Open points for CI:

- **Where the image is published.** The job names `auraplex.local/admin-upload:v1`.
  Whether `auraplex.local` is a registry that CI can push to, or the image is
  built or loaded on the node, is not recorded in this repository.
- **Tag strategy.** Only `v1` has been confirmed. If a later build reuses the
  tag `v1`, Nomad's Docker driver does not pull it again by default, so the
  node can keep running the old image. Either publish a new tag per build and
  update the job, or decide how a reused tag is refreshed.
- CI must not run `nomad job run` against this draft.

### G4. Environment and secrets

Every variable the application reads. "Friendy" says whether a value must be
provided or configured for a deployment. No variable is checked at startup;
a missing one shows up when the feature that needs it is used.

| Variable | Purpose | Required | Default | Secret | Expected source | Friendy |
| --- | --- | --- | --- | --- | --- | --- |
| `AUTH_SECRET` | Encrypts the session cookie and the Proxy identity handoff | yes, for authentication | none | **yes** | runtime secret injection; store not specified | provide: a long random value, kept the same across restarts |
| `AUTH_URL` | Public origin of the application; used for the Keycloak logout redirect | yes, in any deployed environment | none | no | job `env` (production value is in the draft) | set the staging value in the staging job |
| `KEYCLOAK_ISSUER` | Keycloak realm issuer URL | yes, for authentication | none | no | job `env` (in the draft) | nothing, unless staging differs |
| `KEYCLOAK_CLIENT_ID` | Keycloak client ID | yes, for authentication | none | no | job `env` (in the draft) | nothing, unless staging differs |
| `KEYCLOAK_CLIENT_SECRET` | Secret of the confidential Keycloak client | yes, for authentication | none | **yes** | Vault: `kv/auraplex/admin-upload/keycloak_client_secret` | wire the injection; see below |
| `KEYCLOAK_UPLOADER_ROLE` | Keycloak group allowed to upload | no | `auraplex-uploader` | no | job `env`, only to override | confirm the group exists, or set another name |
| `KEYCLOAK_ADMIN_ROLE` | Keycloak group allowed to administer and delete | no | `auraplex-admin` | no | job `env`, only to override | confirm the group exists, or set another name |
| `MINIO_ENDPOINT` | MinIO S3 endpoint URL | yes, for upload and storage | none | no | job `env`; value not supplied | provide |
| `MINIO_ACCESS_KEY` | MinIO access key | yes, for upload and storage | none | **yes** | runtime secret injection; store not specified | provide |
| `MINIO_SECRET_KEY` | MinIO secret key | yes, for upload and storage | none | **yes** | runtime secret injection; store not specified | provide |
| `MINIO_REGION` | S3 region name sent to MinIO | no | `us-east-1` | no | job `env`, only to override | nothing, unless MinIO uses another region |
| `QDRANT_URL` | Qdrant endpoint, for processing status and delete | yes, for status and delete | none | no | job `env`; value not supplied | provide |
| `QDRANT_API_KEY` | Qdrant API key | only if Qdrant requires a key | none | **yes** | runtime secret injection; store not specified | provide if Qdrant requires one |
| `ADMIN_UPLOAD_MAX_MB` | Server-enforced per-file size cap | no | `100` (range 1–500) | no | job `env` | set once the cap is decided |
| `ADMIN_UPLOAD_MAX_CONCURRENT` | Concurrent uploads per process | no | `4` (range 1–16) | no | job `env`, only to override | decide whether 4 fits in 512 MB |
| `ADMIN_TRUSTED_PROXY_SECRET` | Lets audit logging trust `cf-connecting-ip` | no; only with matching APISIX configuration | unset | **yes** | runtime secret injection, only if used | leave unset unless APISIX strips and injects the header |
| `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB` | UI-only upload ceiling, fixed when the image is built | no | unset | no | Docker build argument | leave unset |
| `NODE_ENV` | Must be `production`: enables HTTPS-only cookies and logout | yes | `production` in the image | no | image and job `env` | nothing |
| `PORT` | Port the server listens on | yes | `3000` in the image | no | image and job `env` | nothing; see [G6](#g6-networking) |
| `HOSTNAME` | Address the server binds to | yes | `0.0.0.0` in the image | no | image and job `env` | nothing |

Secrets needing runtime injection: `AUTH_SECRET`, `KEYCLOAK_CLIENT_SECRET`,
`MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, and `QDRANT_API_KEY` and
`ADMIN_TRUSTED_PROXY_SECRET` where they are used.

- Only one Vault location has been supplied:
  `kv/auraplex/admin-upload/keycloak_client_secret`. It is a path. No secret
  value has been read, and none is in this repository.
- The job contains no Vault or template stanza. Nothing here states the KV
  engine version, whether `keycloak_client_secret` is the secret or a field
  inside `kv/auraplex/admin-upload`, or which Vault role the job uses. The
  injection has to be written from the pattern that already works for other
  Auraplex jobs.
- Where the other secrets live has not been specified.
- `AUTH_SECRET` must not change between restarts or redeployments unless the
  intention is to sign everyone out: existing session cookies cannot be read
  with a different value.

### G5. Keycloak URIs

**BLOCKED / awaiting Friendy confirmation.** The application is unchanged
and uses:

| Environment | Redirect URI (callback) | Post-logout redirect URI |
| --- | --- | --- |
| Production | `https://admin-auraplex.auraplex.info/api/auth/callback/keycloak` | `https://admin-auraplex.auraplex.info/signed-out` |
| Staging | `https://admin-auraplex-staging.auraplex.info/api/auth/callback/keycloak` | `https://admin-auraplex-staging.auraplex.info/signed-out` |

The URIs supplied for the client were `/api/auth/callback` and
`/api/auth/logout` on the same hosts. The application has neither route. If
the application stays as it is, the four URIs in the table are the ones that
must be registered on client `auraplex-admin-upload`. If the supplied URIs
are to be used instead, the application has to change first, and that has not
been done. The comparison is in
[Keycloak callback and logout URIs](#keycloak-callback-and-logout-uris--blocked).

The client must also issue refresh tokens, rotate them on every use, and put
`groups` in the ID token; see [Keycloak client](#keycloak-client).

### G6. Networking

Confirmed: the application listens on internal port 3000, and traffic arrives
through APISIX and the Cloudflare Tunnel. Everything else is open.

The draft uses host networking with a static port, so it binds **host port
3000 on `auraplex01`**. That is carried over from the reviewed template, not
confirmed. The public website has been documented as listening on host port
3000 with host networking. If it runs on `auraplex01`, the two jobs cannot
both hold the port.

The choices, none of which has been made:

- **Keep the draft**, after confirming that nothing else on `auraplex01` uses
  host port 3000.
- **Map a host port to internal port 3000**, with the host port static or
  dynamic. The application keeps listening on 3000. This is a change of
  network mode in the job, and APISIX then has to reach the mapped port, for
  example through the Consul service.

Whichever is chosen, the pieces have to agree:

- The Node.js server listens on the port given by `PORT`, which is `3000`.
- Changing only Nomad's static host port does not change the port the
  application listens on.
- A port reservation or mapping that does not lead to the port the
  application listens on can break service discovery, routing or the health
  check, even though the process itself is running.
- The network mode, the port block, `PORT`, and the service and check ports
  must therefore be changed together and kept consistent.

Also needed, and not in this repository: the APISIX route for each hostname
to the Admin service, and the Cloudflare Tunnel configuration. APISIX and
Cloudflare must pass request bodies up to the upload cap without buffering,
and must leave `/api/health` and `/signed-out` reachable without
authentication.

### G7. Upload limits

The final cap is not decided. Until it is, the server default of 100 MB
applies and the job sets nothing.

Once a value is chosen:

1. Set `ADMIN_UPLOAD_MAX_MB` in the job to that value (1–500). The UI follows
   it without a rebuild.
2. Make APISIX, Cloudflare and anything else in the path allow request bodies
   of at least that size.
3. Leave `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB` unset.
4. Decide `ADMIN_UPLOAD_MAX_CONCURRENT`. The default of 4 was measured
   against a 1024 MB task; the job has 512 MB, and that combination has not
   been measured.

### G8. The Nomad job

The file to use is `deploy/admin.nomad.hcl`, **after** the items below are
done. It must not be submitted before then; see
[The Nomad job draft](#the-nomad-job-draft).

1. Add the runtime secret injection ([G4](#g4-environment-and-secrets)).
2. Add `MINIO_ENDPOINT` and `QDRANT_URL`, and the upload settings from
   [G7](#g7-upload-limits).
3. Settle the network block ([G6](#g6-networking)).
4. Decide whether an update policy is needed so that an old and a new
   allocation cannot overlap. `count = 1` must stay; canary and scaling
   settings must not be added.
5. Run `nomad job validate` and `nomad job plan`. Neither has ever been run
   on this file.

Already in the file and confirmed: job `admin-upload`, group `web`, service
`admin-upload`, datacenter `acumen-local`, node `auraplex01`, image
`auraplex.local/admin-upload:v1`, CPU 500, memory 512 MB, one instance, and
the `GET /api/health` check.

The health check is liveness only. It passes with no secrets and with
Keycloak, MinIO and Qdrant unreachable, so a healthy allocation is not proof
of a working deployment.

### G9. Staging checks

No staging environment is defined: there is no staging job, node or image,
only the hostname `admin-auraplex-staging.auraplex.info`. Staging needs its
own job with `AUTH_URL` set to `https://admin-auraplex-staging.auraplex.info`
and the staging URIs registered in Keycloak.

Before production, on staging:

1. Run every check in [section F](#f-production-smoke-tests). They are
   written for the first deployment and apply to staging unchanged.
2. Pay particular attention to the checks that have only ever run against
   local fakes: sign-in and group checks against the real realm (4 to 7),
   logout through Keycloak (8), an upload at the size cap through APISIX and
   Cloudflare (11), and the stored object and Qdrant status (14, 15).
3. Restart the allocation and repeat checks 1, 3 and 10 (check 19).
4. Update the job once and confirm that only one allocation serves traffic
   during the update.
