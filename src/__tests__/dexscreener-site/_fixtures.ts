/**
 * Fixture loader for the DexScreener SITE surface tests.
 *
 * Every fixture is real captured bytes with a `.provenance.json` sibling naming
 * the endpoint, the request parameters, the capture time and the sha256 of the
 * bytes as recorded at capture time. The loader re-hashes on every read, so a
 * fixture that is edited or replaced fails loudly instead of quietly changing
 * what the codecs are proven against.
 *
 * The captures are stored base64-encoded (`<name>.bin.b64`) rather than as raw
 * `.bin` files. Two reasons, both mechanical: the repo's diff-scoped em-dash
 * gate treats every new file under `src/` as authored text, and provider
 * capture bytes are not authored (one captured token description carries a
 * U+2014 that the gate would fail on); and base64 keeps the capture reviewable
 * as text in a diff. The bytes are byte-identical to what the endpoint sent -
 * the sha256 in the provenance is over the DECODED bytes and is checked here on
 * every load.
 *
 * This directory is deliberately separate from `src/__tests__/dexscreener/`,
 * which protects the still-live public-API tools.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures"
);

export interface FixtureProvenance {
  readonly fixture: string;
  readonly encoding: "protobuf" | "dsavro" | "json";
  /** What the capture proves, when the fixture exists for a specific contract. */
  readonly note?: string;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly protobufMessage?: string;
  readonly dsavroSchema?: string;
  readonly endpoint: string;
  readonly requestParams: Readonly<Record<string, unknown>>;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly capturedAt: string;
  readonly httpStatus: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly capturedBy: string;
}

export interface Fixture {
  readonly bytes: Uint8Array;
  readonly provenance: FixtureProvenance;
}

/** Load a fixture and verify it still hashes to what the capture recorded. */
export function loadFixture(name: string): Fixture {
  const provenance = JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, `${name}.provenance.json`), "utf8")
  ) as FixtureProvenance;
  const base64 = readFileSync(
    path.join(FIXTURE_DIR, `${name}.bin.b64`),
    "utf8"
  ).replace(/\s+/g, "");
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== provenance.sha256) {
    throw new Error(
      `fixture ${name}.bin.b64 decodes to bytes hashing to ${digest} but its provenance records ${provenance.sha256}`
    );
  }
  if (bytes.byteLength !== provenance.bytes) {
    throw new Error(
      `fixture ${name}.bin.b64 decodes to ${bytes.byteLength} bytes but its provenance records ${provenance.bytes}`
    );
  }
  return { bytes, provenance };
}

/**
 * Load a fixture whose provider body is ITSELF JSON, and verify its hash.
 *
 * A separate entry point from `loadFixture` because these captures are stored
 * as the provider's own `.json` bytes rather than base64: the body is already
 * reviewable text in a diff, so the base64 wrapper would only obscure it. The
 * hash discipline is identical, and it is the point of both: a fixture that is
 * edited or re-captured fails loudly instead of quietly changing what the
 * parsers are proven against.
 *
 * Returns the raw BYTES, not parsed JSON, because the parser under test owns
 * the decoding step and a test that handed it an already-parsed object would
 * not exercise it.
 */
export function loadJsonFixture(name: string): Fixture {
  const provenance = JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, `${name}.provenance.json`), "utf8")
  ) as FixtureProvenance;
  const bytes = new Uint8Array(readFileSync(path.join(FIXTURE_DIR, `${name}.json`)));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== provenance.sha256) {
    throw new Error(
      `fixture ${name}.json hashes to ${digest} but its provenance records ${provenance.sha256}`
    );
  }
  if (bytes.byteLength !== provenance.bytes) {
    throw new Error(
      `fixture ${name}.json is ${bytes.byteLength} bytes but its provenance records ${provenance.bytes}`
    );
  }
  return { bytes, provenance };
}

/** The JSON the capture recorded next to a fixture, when one exists. */
export function loadFixtureDecodedJson(name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, `${name}.decoded.json`), "utf8")
  );
}
