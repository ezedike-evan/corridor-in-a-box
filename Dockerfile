# syntax=docker/dockerfile:1
#
# @corridor/service as a container: the same process and env contract as
# `pnpm serve` (examples/run-service.ts). Secrets are NEVER built in. Pass
# CORRIDOR_SIGNER_SECRET (or the Vault settings), DATABASE_URL and
# CORRIDOR_API_KEYS at `docker run` time; see docs/operations.md and
# docs/key-management.md.
#
#   docker build -t corridor-service .
#   docker run --rm -p 8080:8080 -e CORRIDOR_SIGNER_SECRET=S... corridor-service

# --- deps: resolve the workspace once, from the lockfile ---------------------
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
# --ignore-scripts: the root `prepare` script installs git hooks, and there is no git here.
RUN pnpm install --frozen-lockfile --ignore-scripts

# --- runtime ----------------------------------------------------------------
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY package.json tsconfig.json ./
COPY examples/run-service.ts ./examples/run-service.ts
# Manifests are read-only to the service: root-owned, no write bit. (`.env*` files
# are excluded by .dockerignore and nothing else is copied in.)
COPY --chown=root:root corridors ./corridors
RUN chmod -R a-w /app/corridors

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node_modules/.bin/tsx", "examples/run-service.ts"]
