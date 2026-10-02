# syntax=docker/dockerfile:1.7
# Multi-target build for the Gabriel Trade Copier monorepo.
#   docker build --target engine -t gtc-engine .
#   docker build --target web    -t gtc-web .
# Behind a TLS-intercepting corporate proxy, pass its CA as an optional build secret:
#   docker build --secret id=extra_ca,src=/path/to/ca.pem ...
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/engine/package.json apps/engine/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/adapters/package.json packages/adapters/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile

FROM deps AS source
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY scripts scripts

# Engine (and operational CLIs: migrations, owner creation). Runs TypeScript via tsx.
FROM source AS engine
ENV NODE_ENV=production
RUN groupadd -r gtc && useradd -r -g gtc gtc && chown -R gtc:gtc /app
USER gtc
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --retries=4 CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /app/apps/engine
CMD ["/app/node_modules/.bin/tsx", "src/main.ts"]

FROM source AS web-build
RUN pnpm --filter @gtc/web build

# Dashboard: Next.js standalone server.
FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd -r gtc && useradd -r -g gtc gtc
COPY --from=web-build --chown=gtc:gtc /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=gtc:gtc /app/apps/web/.next/static ./apps/web/.next/static
USER gtc
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=4 CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
