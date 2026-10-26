# Everything that matters runs in the container (compose.yaml), so a result does
# not depend on the machine. The *-host targets run the same thing on the host's
# Node for a quicker inner loop.

COMPOSE := docker compose
DEV     := $(COMPOSE) run --rm dev

.PHONY: help image image-dev up down logs dev ci deps-reset ci-host web-host start-host ui-host clean

help:
	@echo "make up         run five in the background; web UI on port 5555 (every interface)"
	@echo "make down       stop it (the context is kept in ./workspace)"
	@echo "make logs       follow its log"
	@echo "make dev        shell in the dev container (repo at /app)"
	@echo "make ci         typecheck + lint + test, and the web UI's typecheck, in the dev container"
	@echo "make ci-host    the same on the host's Node (>= 24)"
	@echo "make start-host build the web UI and run five on the host"
	@echo "make ui-host    the web UI from source, reloading as it changes, on port 5173 (every interface); API from five on :5555"

image:
	$(COMPOSE) build five

image-dev:
	$(COMPOSE) build dev

up: image
	$(COMPOSE) up -d five
	@echo "web UI: http://<this host>:5555"

down:
	$(COMPOSE) stop five

logs:
	$(COMPOSE) logs -f five

dev: image-dev
	$(DEV)

ci: image-dev
	$(DEV) make ci-host

# Re-populate the container's node_modules volumes after package.json changes.
deps-reset:
	$(DEV) sh -c 'npm ci && npm ci --prefix web'

ci-host:
	npm run ci
	npm --prefix web run typecheck

web-host:
	npm --prefix web run build

start-host: web-host
	npm start

# Vite's dev server: edits to web/ show at once, without rebuilding five.
ui-host:
	npm --prefix web run dev -- --host 0.0.0.0 --port 5173 --strictPort

clean:
	$(COMPOSE) down --volumes --remove-orphans
