#!/usr/bin/env node
/**
 * Extract the Lighter wire field names Vex reads, from Lighter's OWN OpenAPI
 * descriptor, into a committed artifact.
 *
 * WHY THIS EXISTS (rule 10 item 2). Every field name in `types.ts`,
 * `validation.ts` and the projectors is a string that goes on, or comes off,
 * the wire. Hand-spelling one is guesswork even when it happens to be right:
 * nothing fails when Lighter renames `taker_position_size_before` or changes
 * `usd_amount` from a decimal string to a number - the projection simply
 * reads `undefined`, the campaign row shows a null volume, and the first
 * evidence is a number a human disbelieves. The wire-codes artifact
 * (`src/tools/lighter/signer-runtime/wire-constants.json`) solved the same
 * problem for the signer's integers; this is that pattern for the REST models.
 *
 * THE SOURCE is `agents-colab/lighter-python/openapi.json`, the descriptor the
 * official Python SDK's models are generated from. That clone is gitignored,
 * so the descriptor cannot be read at test time: this script runs by hand
 * against the clone and commits its output, and the test reads only the
 * committed artifact. A test that reached into the clone would pass on one
 * machine, fail in CI, and pin whatever revision that machine happened to
 * have.
 *
 * REGENERATE:
 *   node scripts/extract-lighter-openapi-fields.mjs [path/to/openapi.json]
 *
 * The default path is `agents-colab/lighter-python/openapi.json` relative to
 * the repository root. The SDK's git commit and package version are recorded
 * when the clone exposes them, so the artifact says which revision it speaks
 * for.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DESCRIPTOR = "agents-colab/lighter-python/openapi.json";
const OUTPUT = join(REPO_ROOT, "src/tools/lighter/wire/openapi-fields.json");

/**
 * The schemas Vex projects or stores. Named explicitly rather than extracted
 * wholesale: an artifact of all 152 schemas would be a copy of the descriptor,
 * and the point is the small set our own types claim to mirror.
 */
const SCHEMAS = ["Trade", "PerpsOrderBookDetail", "SpotOrderBookDetail", "AccountPosition"];

function descriptorPath() {
  const argument = process.argv[2];
  return argument === undefined ? join(REPO_ROOT, DEFAULT_DESCRIPTOR) : resolve(argument);
}

function sdkProvenance(descriptorFile) {
  const clone = dirname(descriptorFile);
  const provenance = { sdkCommit: null, sdkVersion: null };
  try {
    provenance.sdkCommit = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Not a git checkout, or git is unavailable. The descriptor hash below is
    // the identity that always exists; the commit is extra provenance.
  }
  try {
    const pyproject = readFileSync(join(clone, "pyproject.toml"), "utf8");
    const match = /^version\s*=\s*"([^"]+)"/m.exec(pyproject);
    provenance.sdkVersion = match === null ? null : match[1];
  } catch {
    // Same: absent provenance is recorded as null, never guessed.
  }
  return provenance;
}

/**
 * One schema property -> the two facts a consumer of the wire needs: the JSON
 * type and the provider's own format spelling (`int64`, `uint8`, and the
 * descriptor's own `uin16` typo, which is copied verbatim because the artifact
 * mirrors the descriptor rather than correcting it).
 */
function property(name, node) {
  const reference = node.$ref ?? node.allOf?.[0]?.$ref ?? null;
  return {
    name,
    type: node.type ?? (reference === null ? "unknown" : "object"),
    format: node.format ?? null,
    ref: reference,
    enum: Array.isArray(node.enum) ? [...node.enum] : null,
    description: typeof node.description === "string" ? node.description : null,
  };
}

function main() {
  const descriptorFile = descriptorPath();
  const text = readFileSync(descriptorFile, "utf8");
  const descriptor = JSON.parse(text);
  const schemas = descriptor.components?.schemas;
  if (schemas === undefined) throw new Error(`No components.schemas in ${descriptorFile}`);

  const extracted = {};
  for (const name of SCHEMAS) {
    const schema = schemas[name];
    if (schema === undefined) throw new Error(`Schema ${name} is absent from ${descriptorFile}`);
    const properties = {};
    for (const [field, node] of Object.entries(schema.properties ?? {})) {
      properties[field] = property(field, node);
    }
    extracted[name] = {
      required: [...(schema.required ?? [])].sort(),
      properties: Object.fromEntries(Object.keys(properties).sort().map((key) => [key, properties[key]])),
    };
  }

  const artifact = {
    source: "Lighter's own OpenAPI descriptor; the official Python SDK's models are generated from it",
    generator: "scripts/extract-lighter-openapi-fields.mjs",
    regenerate: "node scripts/extract-lighter-openapi-fields.mjs [path/to/openapi.json]",
    descriptorPath: DEFAULT_DESCRIPTOR,
    descriptorSha256: createHash("sha256").update(text).digest("hex"),
    openapiVersion: descriptor.openapi ?? descriptor.swagger ?? null,
    ...sdkProvenance(descriptorFile),
    extractedAt: new Date().toISOString().slice(0, 10),
    schemas: extracted,
  };

  writeFileSync(OUTPUT, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${OUTPUT}: ${SCHEMAS.length} schemas\n`);
}

main();
