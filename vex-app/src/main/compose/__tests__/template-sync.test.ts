/**
 * Template ↔ TS sync test (M11.5.4) — codex turn 1 YELLOW.
 *
 * The compose template (`resources/compose/docker-compose.template.yml`)
 * and the TS single source of truth (`embedding-defaults.ts`) BOTH
 * embed the model filename, SHA256, alias, image digests, default
 * port, and HF download URL. A drift between them is silent in
 * production: the template would happily download a model whose
 * dim/filename does not match the env defaults written by
 * `ensureEmbeddingDefaults`. This test pins them together — bumping
 * one and forgetting the other fails CI.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  COMPOSE_IMAGES,
  DEFAULT_EMBED_PORT,
  EMBEDDING_MODEL_ALIAS,
  EMBEDDING_MODEL_DOWNLOAD_URL,
  EMBEDDING_MODEL_FILENAME,
  EMBEDDING_MODEL_SHA256,
} from "../../onboarding/embedding-defaults.js";
import { EMBEDDING_CONTEXT_TOKENS } from "@shared/embedding-defaults.js";
import { DEFAULT_PG_PORT } from "@shared/local-service-ports.js";
import { postgresVolumeName } from "../project.js";

const TEMPLATE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "resources",
  "compose",
  "docker-compose.template.yml"
);

const template = readFileSync(TEMPLATE_PATH, "utf8");

describe("docker-compose.template.yml ↔ embedding-defaults.ts sync", () => {
  it("references the llama.cpp image at the digest pinned in TS", () => {
    expect(template).toContain(
      `${COMPOSE_IMAGES.llamaServer.tag}@${COMPOSE_IMAGES.llamaServer.digest}`
    );
  });

  it("references the curl init image at the digest pinned in TS", () => {
    expect(template).toContain(
      `${COMPOSE_IMAGES.curlInit.tag}@${COMPOSE_IMAGES.curlInit.digest}`
    );
  });

  it("references the GGUF filename from TS in the runtime command and init script", () => {
    // Compose `command:` mounts the file at /models/<filename>.
    expect(template).toContain(`/models/${EMBEDDING_MODEL_FILENAME}`);
    // Init script defines MODEL=/models/<filename>.
    expect(template).toContain(`MODEL=/models/${EMBEDDING_MODEL_FILENAME}`);
  });

  it("embeds the GGUF SHA256 hex literal expected by TS", () => {
    expect(template).toContain(`EXPECTED=${EMBEDDING_MODEL_SHA256}`);
  });

  it("uses the alias from TS for /v1/models reporting", () => {
    expect(template).toContain(`"${EMBEDDING_MODEL_ALIAS}"`);
  });

  it("sizes the server's context and both batches to EMBEDDING_CONTEXT_TOKENS, as the native launch does", () => {
    for (const flag of ["--ctx-size", "--batch-size", "--ubatch-size"]) {
      expect(template).toContain(`- ${flag}\n      - "${String(EMBEDDING_CONTEXT_TOKENS)}"`);
    }
  });

  it("defaults the embed port placeholder to DEFAULT_EMBED_PORT", () => {
    expect(template).toContain(
      `\${VEX_EMBED_PORT:-${DEFAULT_EMBED_PORT}}`
    );
  });

  it("defaults the pg port placeholder to DEFAULT_PG_PORT", () => {
    // Lockstep with `local-service-ports.ts`: render.ts builds the
    // replace string from DEFAULT_PG_PORT, so a drift between the
    // constant and this template default would silently publish the
    // wrong host port. (Codex harness-vexup-docker-ports requirement.)
    expect(template).toContain(
      `\${VEX_PG_PORT:-${DEFAULT_PG_PORT}}`
    );
  });

  it("names the Postgres volume exactly as postgresVolumeName does (the migration reads it)", () => {
    const placeholder = "${VEX_INSTALL_ID}";
    expect(template).toContain(`- ${postgresVolumeName(placeholder)}:/var/lib/postgresql`);
    expect(template).toContain(`name: ${postgresVolumeName(placeholder)}`);
  });

  it("downloads the GGUF from the URL pinned in TS", () => {
    expect(template).toContain(`"${EMBEDDING_MODEL_DOWNLOAD_URL}"`);
  });

  it("uses LF line endings only (CRLF would break inline shell script)", () => {
    // docker/compose#2648 — CRLF in inline `configs.content:` breaks
    // `#!/bin/sh` with "bad interpreter".
    expect(template).not.toContain("\r");
  });

  it("escapes every shell variable reference as $$ inside configs.content", () => {
    // Compose runs variable interpolation over the entire YAML, including
    // inline `configs.content:` strings. A single `$VAR` or `$(expr)`
    // would be substituted by the time the container starts — every
    // shell expansion would expand to "" and break the script (live test
    // surfaced this as `curl: option : blank argument where content is
    // expected`). Doubling to `$$` is the documented escape.
    //
    // The regex flags any `$` that is NOT preceded by another `$` and
    // is followed by a letter, paren, or underscore (the shell-variable
    // / command-substitution start characters we actually use). The
    // `${PLACEHOLDER}` form used by render.ts placeholders is exempt
    // because `{` is not in the character class.
    const offenders = template.match(/(?<!\$)\$[A-Za-z(_]/g);
    expect(offenders).toBeNull();

    // Explicit positive assertions on the shell variables we DO use —
    // double-checks the regex didn't pass because the variable was
    // dropped from the template entirely.
    for (const escaped of [
      "$$MODEL",
      "$$TMP",
      "$$EXPECTED",
      "$$URL",
      "$$ACTUAL",
      "$$(sha256sum",
    ]) {
      expect(template).toContain(escaped);
    }
  });
});
