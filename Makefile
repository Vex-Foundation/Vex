# Vex — Developer Makefile

.PHONY: build test dev clean lint lint-all check e2e-smoke \
        knowledge-export knowledge-import knowledge-reembed \
        vex-dev vex-make vex-lint vex-test

# -- Build & Test -------------------------------------------------------------

build:
	pnpm run build

test:
	pnpm test

dev:
	pnpm run dev

clean:
	pnpm run clean

lint:
	pnpm exec tsc --noEmit

lint-all:
	pnpm exec tsc --noEmit -p tsconfig.test.json

check: lint test

# -- Embeddings endpoint smoke ------------------------------------------------
#
# Checks that EMBEDDING_BASE_URL answers /embeddings with EMBEDDING_DIM-long
# vectors for EMBEDDING_MODEL. The app's own embeddings server picks its port
# and an API key per launch, so point these at a server you started yourself
# (the bundled llama-server: vex-app/docs/LOCAL_RUNTIME.md, "Embeddings for
# the integration suite") or any OpenAI-compatible /v1 endpoint.
#
# No separate database stack is needed: the Studio e2e specs start their own
# throwaway Postgres on the bundled binaries, and so do the integration lanes
# with VEX_TEST_PG=native.

e2e-smoke:
	@if [ -z "$$EMBEDDING_DIM" ] || [ -z "$$EMBEDDING_MODEL" ] || [ -z "$$EMBEDDING_BASE_URL" ]; then \
	  echo "FAIL: EMBEDDING_DIM / EMBEDDING_MODEL / EMBEDDING_BASE_URL not set — source the local services env first"; \
	  exit 1; \
	fi
	@echo "Smoke-testing $$EMBEDDING_BASE_URL/embeddings (model=$$EMBEDDING_MODEL, expecting dim=$$EMBEDDING_DIM)…"
	@curl -fsS -X POST "$$EMBEDDING_BASE_URL/embeddings" \
	  -H "Content-Type: application/json" \
	  -d "{\"input\":\"ping\",\"model\":\"$$EMBEDDING_MODEL\"}" \
	  | jq '.data[0].embedding | length' \
	  | (read dim; if [ "$$dim" = "$$EMBEDDING_DIM" ]; then echo "OK: dim=$$dim"; else echo "FAIL: expected $$EMBEDDING_DIM, got $$dim"; exit 1; fi)

# -- Knowledge maintenance (portability / backup / restore / reembed) --------
#
# Three companion scripts for the embedding-portability subsystem.
# See README "Switching embedding model" for the operator workflow.
#
# All three accept ARGS=... to forward command flags, e.g.:
#   make knowledge-export ARGS="--out backup.jsonl"
#   make knowledge-import ARGS="--in backup.jsonl"
#   make knowledge-reembed ARGS="--dry-run"

knowledge-export:
	pnpm exec tsx src/vex-agent/scripts/knowledge-export.ts $(ARGS)

knowledge-import:
	pnpm exec tsx src/vex-agent/scripts/knowledge-import.ts $(ARGS)

knowledge-reembed:
	pnpm exec tsx src/vex-agent/scripts/knowledge-reembed.ts $(ARGS)

# -- Vex Electron desktop app (vex-app/) --------------------------------------
#
# Sibling top-level package for the Electron GUI. See vex-app/dependency-audit.md
# for stack details. Phase 1 focus: bootstrap ceremony (splash → wizard → setup).

vex-dev:
	pnpm vex:dev

vex-make:
	pnpm vex:make

vex-lint:
	pnpm vex:lint

vex-test:
	pnpm vex:test
