# A22: base tag must equal the installed playwright version in package-lock.json.
ARG PLAYWRIGHT_TAG=v1.65.0-noble

# ---- build stage: toolchain for better-sqlite3 (no prebuild matches the base image's Node) ----
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_TAG} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev \
 && node -e "const D=require('better-sqlite3');new D(':memory:').close()" \
 && npm cache clean --force

# ---- runtime stage ----
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_TAG}
ENV NODE_ENV=production \
    DATA_DIR=/app/data

# git is required for the ./data audit repo (A21).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

# A09: unprivileged user that bash tool commands run as. Node itself stays root.
RUN useradd --uid 1500 --user-group --no-create-home --shell /usr/sbin/nologin sandbox

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN sed -i 's/\r$//' /app/docker-entrypoint.sh && chmod 755 /app/docker-entrypoint.sh

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
