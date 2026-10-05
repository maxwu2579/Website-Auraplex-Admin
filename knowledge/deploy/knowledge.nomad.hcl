job "knowledge" {
  datacenters = ["dmz"]
  type        = "service"
  priority    = 70

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
        image        = "auraplex.local/knowledge:v1"
        network_mode = "host"
      }

      env {
        NODE_ENV = "production"
        PORT     = "3100"
        HOSTNAME = "0.0.0.0"
        # AUTH_SECRET, AUTH_URL (this app's public origin, used for the
        # Keycloak post-logout redirect), KEYCLOAK_*, MINIO_* and QDRANT_*
        # must be injected via templates + nomadVar; never inline secrets here.
        # ADMIN_UPLOAD_MAX_MB is the server-enforced runtime cap (default 100,
        # range 1-500) and the UI follows it without a rebuild.
        # ADMIN_UPLOAD_MAX_CONCURRENT (default 4, range 1-16) caps concurrent
        # uploads PER ALLOCATION, sized for the memory below.
        # See docs/deployment/AURA-INT-001-runtime.md.
      }

      resources {
        cpu    = 1000
        memory = 1024
      }
    }

    service {
      name     = "auraplex-knowledge"
      provider = "consul"
      port     = "3100"
      tags     = ["internal", "next"]

      check {
        name     = "healthz"
        type     = "http"
        path     = "/"
        port     = "3100"
        interval = "30s"
        timeout  = "5s"
      }
    }
  }
}
