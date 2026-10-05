# syntax=docker/dockerfile:1
# Auraplex Knowledge — standalone Next.js upload workspace for the AI
# knowledge base. Same three-stage layout as the website image.
#
# Everything this app needs is read at RUNTIME (Keycloak, MinIO, Qdrant, upload
# limits), so one image serves every environment. The only build-time value is
# the optional NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB UI ceiling.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* .npmrc* ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB=
ENV NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB=$NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3100
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3100
CMD ["node", "server.js"]
