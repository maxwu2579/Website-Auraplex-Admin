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
