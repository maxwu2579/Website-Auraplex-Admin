# syntax=docker/dockerfile:1
# Dockerfile for the standalone Auraplex Admin application. Place at repo root.
#
# Three stages: install from the lockfile, build, then run the Next.js
# standalone server. All Admin secrets and service addresses (Auth.js,
# Keycloak, MinIO, Qdrant) are server-only and read at RUNTIME; none is needed
# to build the image. See .env.example.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* .npmrc* ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Optional build-time UI-only upload ceiling. NEXT_PUBLIC_* values are inlined
# by Next at BUILD time; leave this unset so the UI follows the server's
# runtime ADMIN_UPLOAD_MAX_MB.
ARG NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB
ENV NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB=$NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB

RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# The standalone build brings its own node_modules subset. Files are owned by
# the unprivileged `node` user that the base image already provides, and the
# server runs as that user.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

USER node

EXPOSE 3000
CMD ["node", "server.js"]
