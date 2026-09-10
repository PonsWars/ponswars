# The deployable service (§21.3).
#
#   docker build -f infra/containers/server.Dockerfile -t ponswars-server .
#
# Built from the repository root, because a workspace package cannot be
# installed without the lockfile and the manifests of everything it depends on.
#
# Three stages. `deps` installs once and is cached until the lockfile changes;
# `build` compiles TypeScript and collapses the workspace into one
# self-contained directory; the last stage carries that directory and a Node
# runtime, and nothing else — no compiler, no sources, no dev dependencies.

# Pinned to a digest-stable minor rather than `22-alpine`, so a rebuild of an
# old commit produces the runtime that commit was tested on. `.nvmrc` says 22.
FROM node:22.23-alpine AS deps
WORKDIR /repo
RUN corepack enable

# Manifests before sources. Everything below this layer is cached until a
# dependency actually changes, which is the difference between a thirty-second
# rebuild and a four-minute one.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/gateway/package.json apps/gateway/
COPY apps/server/package.json apps/server/
COPY packages/battle-engine/package.json packages/battle-engine/
COPY packages/battle-math/package.json packages/battle-math/
COPY packages/config/package.json packages/config/
COPY packages/market-data/package.json packages/market-data/
COPY packages/realtime/package.json packages/realtime/
COPY packages/round-service/package.json packages/round-service/
COPY packages/schemas/package.json packages/schemas/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/store-postgres/package.json packages/store-postgres/

# `--frozen-lockfile` is the point of committing one: a build that resolved a
# different tree than the one CI verified would be a different program.
# `--ignore-scripts` because nothing in this graph needs a postinstall, and a
# package that decides it does should have to say so here.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @ponswars/server...

FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json tsconfig.json ./
COPY apps/api apps/api/
COPY apps/gateway apps/gateway/
COPY apps/server apps/server/
COPY packages packages/

# Only what the server needs. Building the whole workspace here would pull in
# the web client and its bundler for a container that never serves a page.
RUN pnpm exec tsc -b apps/server/tsconfig.build.json

# One directory with real `node_modules` instead of a workspace of symlinks,
# so the runtime stage can be copied into rather than reassembled.
RUN pnpm --filter @ponswars/server deploy --prod --legacy /out

FROM node:22.23-alpine AS runtime
WORKDIR /app

# Unprivileged, and owned by the user that runs it. The `node` image ships this
# account; a service that writes nothing needs no more than it.
COPY --from=build --chown=node:node /out /app

# The schema the code expects, beside the code that expects it (§49). One
# artifact carries both, so a deployment cannot apply the wrong version of the
# schema for the binary it is running — `dist/migrate.js` reads this directory
# by default and there is only one of each in the image.
COPY --chown=node:node database/migrations /app/migrations

USER node

ENV NODE_ENV=production

# No `EXPOSE` and no default ports. `API_PORT` and `GATEWAY_PORT` are required
# configuration (§102) and the process refuses to start without them; a
# hard-coded port here would be a second answer to a question the environment
# already answers.

# Exec form, so the process is PID 1 and receives `SIGTERM` directly. Under a
# shell it would not, and §25's stop-between-rounds would never run.
CMD ["node", "dist/main.js"]
