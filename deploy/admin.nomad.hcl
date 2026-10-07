# ─────────────────────────────────────────────────────────────────────────────
# Auraplex Admin — production Nomad job. DRAFT.
#
# NOT PRODUCTION-READY — DO NOT SUBMIT THIS FILE TO NOMAD.
# No `nomad job run`, and no `nomad job plan` against a real cluster with the
# intention of running it.
#
# This is a prohibition, not a technical lock. Nothing in this file stops
# Nomad: the HCL is meant to be well-formed, so Nomad may accept it and
# schedule the job. The missing secrets would not stop it either. The server
# process starts without them and GET /api/health answers 200, so the
# allocation can look healthy while sign-in and uploads cannot work.
#
# Deployment blockers (details in section E of
# docs/deployment/AURAPLEX-ADMIN-deployment.md):
#
#   1. Runtime secret injection is not wired (see the TODO in the task
#      below). KEYCLOAK_CLIENT_SECRET, AUTH_SECRET and the MinIO and Qdrant
#      settings are absent.
#   2. The Keycloak callback and logout URI registration is BLOCKED, awaiting
#      Friendy's confirmation.
#   3. The final upload size cap is not decided.
#   4. The host port / network mapping is not confirmed (see the network
#      block). Only the internal application port, 3000, is.
#   5. The image has never been built or started: no Docker build and no
#      container smoke test have been run.
#   6. This file has never been validated. `nomad job validate` has not been
#      run on it (Nomad was not available where it was prepared) and it has
#      not been run anywhere.
#   7. The APISIX route and Cloudflare Tunnel configuration are not in this
#      repository.
#
# What is confirmed and set below: job, group, service, internal port,
# datacenter, node, image, resources, single instance, health path, and the
# production AUTH_URL, Keycloak issuer and client ID. This is the production
# job only; no staging job exists.
#
# It deliberately does not reuse the public website's identity (its job,
# service or image names), so applying it can never replace that job. Do not
# put those names back.
# ─────────────────────────────────────────────────────────────────────────────
job "admin-upload" {
  datacenters = ["acumen-local"]
  type        = "service"

  constraint {
    attribute = "${node.unique.name}"
    value     = "auraplex01"
  }

  group "web" {
    # Single instance. Upload rate limiting, upload byte reservations, upload
    # concurrency, refresh/re-verification coordination, login ordering and
    # the Keycloak metadata caches all live in the memory of one process and
    # are not shared. Do not raise this, and do not add canary or
    # multi-instance behaviour, until that is redesigned.
    #
    # count = 1 limits the steady state only. It does not by itself guarantee
    # that an old and a new allocation never overlap while the job is being
    # updated or rescheduled. No update policy is defined here.
    count = 1

    network {
      mode = "host"

      # TODO(unresolved): host port / network mapping. Confirmed: the
      # application listens on internal port 3000. NOT confirmed: that the
      # host port must be statically bound to 3000. Host networking and the
      # static port are carried over from the reviewed template, which makes
      # 3000 the host port on auraplex01 as well; the public website has been
      # documented as using that port. A dynamic host port mapped to internal
      # port 3000 would be equally consistent with what was confirmed.
      port "http" {
        static = 3000
      }
    }

    restart {
      attempts = 5
      interval = "5m"
      delay    = "15s"
      mode     = "delay"
    }

    task "next" {
      driver = "docker"

      config {
        image        = "auraplex.local/admin-upload:v1"
        network_mode = "host"
      }

      env {
        NODE_ENV = "production"
        PORT     = "3000"
        HOSTNAME = "0.0.0.0"

        # Confirmed, non-secret.
        AUTH_URL           = "https://admin-auraplex.auraplex.info"
        KEYCLOAK_ISSUER    = "https://keycloak.auraplex.info/realms/auraplex"
        KEYCLOAK_CLIENT_ID = "auraplex-admin-upload"

        # Upload size: ADMIN_UPLOAD_MAX_MB is the server-enforced RUNTIME cap
        # (default 100 MB, range 1-500) and the admin UI follows it without a
        # rebuild. It is deliberately not set here: the final production cap
        # has not been confirmed, so the 100 MB default applies.
        # NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB is an optional build-time UI-only
        # ceiling; leave it unset unless the UI must stay lower.
        # ADMIN_UPLOAD_MAX_CONCURRENT (default 4, range 1-16) caps concurrent
        # uploads PER ALLOCATION/PROCESS; it is not a cluster-wide limit. The
        # default was sized for a 1024 MB task, not the 512 MB below.
      }

      # TODO(unresolved): runtime secret injection.
      #
      # KEYCLOAK_CLIENT_SECRET must come from Vault at
      #   kv/auraplex/admin-upload/keycloak_client_secret
      # and must never be written in this file. No Vault/Nomad integration
      # pattern exists in this repository, so none is guessed here: the KV
      # engine version, whether the last path segment is a secret or a field,
      # the Vault role/policy for this job and the template to use all need to
      # come from the working Auraplex pattern.
      #
      # The same mechanism must also provide the inputs whose source has not
      # been supplied: AUTH_SECRET, MINIO_ENDPOINT, MINIO_ACCESS_KEY,
      # MINIO_SECRET_KEY, QDRANT_URL and, if required, QDRANT_API_KEY.
      # See .env.example for the full list.

      resources {
        cpu    = 500
        memory = 512
      }
    }

    service {
      name     = "admin-upload"
      provider = "consul"
      port     = "http"

      check {
        name     = "healthz"
        type     = "http"
        # Liveness only: public, no session, and no call to Keycloak, MinIO
        # or Qdrant. It proves the server process answers, not that those
        # services are reachable.
        path     = "/api/health"
        port     = "http"
        interval = "30s"
        timeout  = "5s"
      }
    }
  }
}
