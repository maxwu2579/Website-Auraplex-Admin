job "website" {
  datacenters = ["dmz"]
  type        = "service"
  priority    = 80

  group "web" {
    count = 1

    network {
      mode = "host"
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
        image        = "auraplex.local/website:v1"
        network_mode = "host"
      }

      env {
        NODE_ENV                     = "production"
        PORT                         = "3000"
        HOSTNAME                     = "0.0.0.0"
        NEXT_PUBLIC_SITE_URL         = "https://www.auraplex.info"
        NEXT_PUBLIC_CHAT_API_URL     = "https://chat-api.auraplex.info"
        NEXT_PUBLIC_PLAUSIBLE_DOMAIN = "auraplex.info"
        # Sanity / Resend / Anthropic keys added by ops via templates + nomadVar.
        # Admin-upload secrets, AUTH_URL (for Keycloak RP logout), group mapping,
        # and service addresses must also be injected via templates + nomadVar.
        # Upload size: ADMIN_UPLOAD_MAX_MB is the server-enforced RUNTIME cap
        # (default 100 MB, range 1-500) and the admin UI follows it without a
        # rebuild. NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB is an optional build-time
        # UI-only ceiling; leave it unset unless the UI must stay lower.
        # ADMIN_UPLOAD_MAX_CONCURRENT (default 4, range 1-16) caps concurrent
        # uploads PER ALLOCATION/PROCESS, sized for the 1024 MB memory below;
        # it is not a cluster-wide limit.
        # The production variable path is intentionally not guessed here;
        # see docs/deployment/AURA-INT-001-runtime.md.
      }

      resources {
        cpu    = 1000
        memory = 1024
      }
    }

    service {
      name     = "auraplex-website"
      provider = "consul"
      port     = "3000"
      tags     = ["public", "next"]

      check {
        name     = "healthz"
        type     = "http"
        path     = "/en"
        port     = "3000"
        interval = "30s"
        timeout  = "5s"
      }
    }
  }
}
