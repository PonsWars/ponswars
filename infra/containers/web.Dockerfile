# The client (§80).
#
#   docker build -f infra/containers/web.Dockerfile \
#     --build-arg VITE_API_URL=https://api.example.com \
#     --build-arg VITE_WS_URL=wss://ws.example.com \
#     -t ponswars-web .
#
# Built from the repository root, for the same reason the server is: a
# workspace package cannot be installed without the lockfile.
#
# The two URLs are build arguments rather than environment variables because
# that is what they are — Vite inlines them into the bundle, so a built image
# is already pointed at one deployment. They are also public the moment it
# ships, which is why they are not in `@ponswars/config`: that table is the
# server's contract and holds secrets.

FROM node:22.23-alpine AS deps
WORKDIR /repo
RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/realtime/package.json packages/realtime/
COPY packages/schemas/package.json packages/schemas/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/ui-tokens/package.json packages/ui-tokens/
COPY packages/world-runtime/package.json packages/world-runtime/
COPY packages/battle-math/package.json packages/battle-math/

RUN pnpm install --frozen-lockfile --ignore-scripts --filter @ponswars/web...

FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages/
COPY apps/web apps/web/

ARG VITE_API_URL=""
ARG VITE_WS_URL=""
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL

# The workspace packages the client imports, then the bundle. An unconfigured
# build is allowed and is not a broken one: `liveEndpoints` returns `null` and
# the app says on screen that it is showing a preview rather than a live round.
RUN pnpm exec tsc -b \
      packages/shared-types/tsconfig.build.json \
      packages/realtime/tsconfig.build.json \
      packages/schemas/tsconfig.build.json \
      packages/ui-tokens/tsconfig.build.json \
      packages/world-runtime/tsconfig.build.json \
 && pnpm --filter @ponswars/web exec vite build

FROM nginx:1.29-alpine AS runtime

ARG VITE_API_URL=""
ARG VITE_WS_URL=""

COPY infra/containers/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

# `connect-src` is written here rather than left open, from the same two values
# the bundle was built with: a policy that allowed any origin would permit
# exactly what it exists to prevent. An unconfigured build gets `'self'` alone,
# which is true — it talks to nobody.
RUN set -eu; \
    connect=""; \
    for origin in "$VITE_API_URL" "$VITE_WS_URL"; do \
      if [ -n "$origin" ]; then connect="$connect $origin"; fi; \
    done; \
    sed -i "s|__CONNECT_SRC__|$connect|g" /etc/nginx/conf.d/default.conf; \
    nginx -t

EXPOSE 8080
