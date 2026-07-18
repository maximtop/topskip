# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

FROM ${NODE_IMAGE} AS build

ARG PNPM_VERSION=10.33.0

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

WORKDIR /workspace

RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY backend/package.json ./backend/package.json
COPY common/package.json ./common/package.json
COPY extension/package.json ./extension/package.json

RUN --mount=type=cache,id=topskip-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY backend/src ./backend/src
COPY common/src ./common/src
COPY deploy/rspack.config.ts ./deploy/rspack.config.ts

RUN pnpm exec rspack build --config deploy/rspack.config.ts

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production
ENV TOPSKIP_HOST=0.0.0.0
ENV TOPSKIP_PORT=8787
ENV TOPSKIP_DATABASE_PATH=/var/lib/topskip/topskip.sqlite
ENV TOPSKIP_CAPTION_SOURCE=extension_upload

WORKDIR /app

RUN install -d -o node -g node -m 0750 /var/lib/topskip

COPY --from=build --chown=node:node /workspace/deployment-dist/server.mjs /app/server.mjs

USER node

EXPOSE 8787

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8787/v1/health').then(async (response) => { const body = await response.json(); if (!response.ok || body.ok !== true) process.exit(1); }).catch(() => process.exit(1))"]

CMD ["node", "/app/server.mjs"]
