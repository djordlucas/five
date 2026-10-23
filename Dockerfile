# five runs and is developed in this image. Two targets:
#
#   dev      the toolchain (all deps, the web UI's too, git, make) with the repo
#            bind-mounted at /app by compose.yaml; `make ci` runs here.
#   runtime  production deps, src/ and the built web UI, as the unprivileged
#            `node` user.
#
# All of five's data — its state database, tool sources, node_modules, and the
# agent's own files and databases — lives in the workspace, /workspace.
#
# Node runs the TypeScript sources directly; the only build is the web UI's
# (web/, Vite), whose output the runtime serves.

FROM node:24.21.0-bookworm-slim AS base
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
# git and ca-certificates are for the agent's own code and for npm fetching
# the packages its code imports, not for five itself.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# The web UI: its dependencies, then its build. It imports the API's types
# from src/api/types.ts.
FROM base AS web
COPY web/package.json web/package-lock.json web/
RUN npm ci --prefix web
COPY src/api/types.ts src/api/types.ts
COPY web web
RUN npm --prefix web run build

FROM base AS dev
RUN apt-get update \
 && apt-get install -y --no-install-recommends make \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules node_modules
COPY --from=web /app/web/node_modules web/node_modules
COPY . .
ENV FIVE_WORKSPACE=/workspace
CMD ["bash"]

FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS runtime
COPY --from=prod-deps /app/node_modules node_modules
COPY package.json ./
COPY src src
COPY --from=web /app/web/dist web/dist
RUN mkdir -p /workspace && chown node:node /workspace
# five listens on every interface inside the container; compose publishes the
# port on the host's loopback only. Ollama runs on the host.
ENV FIVE_WORKSPACE=/workspace \
    FIVE_API_ADDR=0.0.0.0:5555 \
    FIVE_OLLAMA_ENDPOINT=http://host.docker.internal:11434 \
    NODE_ENV=production
EXPOSE 5555
USER node
WORKDIR /workspace
VOLUME ["/workspace"]
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "/app/src/main.ts"]
