FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY scripts ./scripts
COPY src ./src
COPY docs ./docs
COPY README.md LICENSE NOTICE ./

RUN pnpm build \
  && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/docs ./docs
COPY --from=build /app/README.md /app/LICENSE /app/NOTICE ./

ENV NODE_ENV=production
ENV SSH_HOST=0.0.0.0
ENV SSH_PORT=2222
ENV DOCS_DIR=/app/docs
ENV DOCS_SSH_STATE_DIR=/data/state
ENV SSH_HOST_KEY_PATH=/data/state/ssh_host_key

EXPOSE 2222

CMD ["node", "dist/src/server.js"]
