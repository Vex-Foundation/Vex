/**
 * Schema drift gate for the DexScreener site surface.
 *
 * The checked-in descriptor set was lifted out of one deploy of the site's JS
 * bundle. The bundle hash changes with every deploy, and a schema change there
 * silently changes what our decoders produce. This test re-extracts the
 * descriptors from the CURRENT bundle and names every message that appeared,
 * disappeared, or changed field shape.
 *
 * GATING: `describe.skipIf(VEX_DEXSCREENER_DRIFT !== "1")`, the same shape the
 * repo's other live gates use (see `judge-benchmark.int.test.ts`). Two ways to
 * feed it, because dexscreener.com refuses Node's TLS fingerprint outright
 * (measured: 403 cf-mitigated=challenge on plain fetch/undici):
 *
 *   1. a mounted site transport - register one before running, e.g. from the
 *      desktop app's runner;
 *   2. `VEX_DEXSCREENER_BUNDLE_DIR=<dir>` pointing at an already downloaded
 *      bundle (any directory containing the site's `.js` assets, however they
 *      were fetched). This is how the recon captures were taken.
 *
 * With the gate set and neither source available the test FAILS rather than
 * skips: the operator asked for the check, and silently passing would be the
 * exact false assurance this gate exists to prevent.
 *
 *   VEX_DEXSCREENER_BUNDLE_DIR=/path/to/bundle VEX_DEXSCREENER_DRIFT=1 \
 *     npx vitest run src/__tests__/dexscreener-site/descriptor-drift.gated.test.ts
 *
 * Port of `evidence/extract-descriptors-from-bundle.py`: every base64 literal
 * of 200 characters or more is tried as a `FileDescriptorProto`; the ones that
 * parse and carry a file name are the site's schemas.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fromBinary } from "@bufbuild/protobuf";
import {
  FileDescriptorProtoSchema,
  type DescriptorProto,
  type FileDescriptorProto,
} from "@bufbuild/protobuf/wkt";
import { getDexScreenerProtoRegistry } from "../../tools/dexscreener/codec/protobuf.js";
import { getDexScreenerTransport } from "../../tools/dexscreener/transport.js";

const driftEnabled = process.env.VEX_DEXSCREENER_DRIFT === "1";
const bundleDir = process.env.VEX_DEXSCREENER_BUNDLE_DIR;

const SITE_ORIGIN = "https://dexscreener.com";
/** Politeness bounds for the crawl: the recon measured 429 after 30 loads in 9 s. */
const MAX_ASSETS = 200;
const REQUEST_SPACING_MS = 120;
const ASSET_TIMEOUT_MS = 60_000;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** A message's shape, reduced to what a decoder actually depends on. */
type MessageShape = Map<string, string>;

function shapeOfDescriptorProto(
  message: DescriptorProto,
  scope: string,
  out: Map<string, MessageShape>
): void {
  const typeName = `${scope}.${message.name}`;
  const fields: MessageShape = new Map();
  for (const field of message.field) {
    fields.set(
      field.name,
      `${field.number}:${field.type}:${field.label}:${field.typeName}`
    );
  }
  out.set(typeName, fields);
  for (const nested of message.nestedType) {
    shapeOfDescriptorProto(nested, typeName, out);
  }
}

function shapesOfBundle(files: FileDescriptorProto[]): Map<string, MessageShape> {
  const out = new Map<string, MessageShape>();
  for (const file of files) {
    const scope = file.package === "" ? "" : file.package;
    for (const message of file.messageType) {
      shapeOfDescriptorProto(message, scope, out);
    }
  }
  return out;
}

/** The same reduction over the checked-in registry. */
function shapesOfCheckedIn(): Map<string, MessageShape> {
  const out = new Map<string, MessageShape>();
  for (const type of getDexScreenerProtoRegistry()) {
    if (type.kind !== "message") continue;
    if (type.typeName.startsWith("google.protobuf.")) continue;
    const fields: MessageShape = new Map();
    for (const field of type.proto.field) {
      fields.set(
        field.name,
        `${field.number}:${field.type}:${field.label}:${field.typeName}`
      );
    }
    out.set(type.typeName, fields);
  }
  return out;
}

/** Every base64 literal in a JS source that parses as a FileDescriptorProto. */
function extractDescriptors(source: string): FileDescriptorProto[] {
  const out: FileDescriptorProto[] = [];
  const pattern = /\("([A-Za-z0-9+/=_-]{200,})"/g;
  for (const match of source.matchAll(pattern)) {
    const literal = match[1];
    if (literal === undefined) continue;
    const padded = literal + "=".repeat((4 - (literal.length % 4)) % 4);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(padded, "base64");
    } catch {
      continue;
    }
    if (bytes.byteLength === 0) continue;
    try {
      const file = fromBinary(FileDescriptorProtoSchema, new Uint8Array(bytes));
      if (file.name !== "") out.push(file);
    } catch {
      // Not a descriptor. Most long base64 literals in the bundle are not.
    }
  }
  return out;
}

function readBundleFromDisk(dir: string): string[] {
  const sources: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      if (statSync(full).size > MAX_ASSET_BYTES) continue;
      sources.push(readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return sources;
}

async function downloadBundle(): Promise<string[]> {
  const transport = getDexScreenerTransport();
  if (!transport.capabilities.site) {
    throw new Error(
      "VEX_DEXSCREENER_DRIFT is set but no site transport is mounted and VEX_DEXSCREENER_BUNDLE_DIR is unset. " +
        "dexscreener.com refuses Node's TLS fingerprint, so this check needs the Electron site bridge or a pre-downloaded bundle directory."
    );
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const get = async (url: string): Promise<string> => {
    const response = await transport.httpGet(url, {
      timeoutMs: ASSET_TIMEOUT_MS,
      maxBytes: MAX_ASSET_BYTES,
    });
    if (response.status !== 200) {
      throw new Error(`${url} answered HTTP ${response.status}`);
    }
    return decoder.decode(response.body);
  };

  const index = await get(`${SITE_ORIGIN}/`);
  const queue: string[] = [];
  for (const match of index.matchAll(/(?:src|href)=["']([^"']+\.js)["']/g)) {
    const found = match[1];
    if (found !== undefined) queue.push(found);
  }
  const seen = new Set<string>();
  const sources: string[] = [];
  while (queue.length > 0 && sources.length < MAX_ASSETS) {
    const next = queue.shift();
    if (next === undefined) break;
    const url = new URL(next, `${SITE_ORIGIN}/`);
    if (url.host !== "dexscreener.com" || !url.pathname.endsWith(".js")) continue;
    if (seen.has(url.pathname)) continue;
    seen.add(url.pathname);
    const source = await get(url.toString());
    sources.push(source);
    for (const match of source.matchAll(
      /["']((?:\/?assets\/)[A-Za-z0-9_./-]+\.js)["']/g
    )) {
      const found = match[1];
      if (found !== undefined && !seen.has(`/${found.replace(/^\//, "")}`)) {
        queue.push(found);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS));
  }
  return sources;
}

describe.skipIf(!driftEnabled)("DexScreener descriptor drift", () => {
  it(
    "the current site bundle still declares the messages this build decodes",
    async () => {
      const sources =
        bundleDir === undefined
          ? await downloadBundle()
          : readBundleFromDisk(bundleDir);
      expect(sources.length).toBeGreaterThan(0);

      const files = new Map<string, FileDescriptorProto>();
      for (const source of sources) {
        for (const file of extractDescriptors(source)) files.set(file.name, file);
      }
      expect(files.size).toBeGreaterThan(0);

      const live = shapesOfBundle([...files.values()]);
      const checkedIn = shapesOfCheckedIn();

      const removed: string[] = [];
      const changed: string[] = [];
      for (const [name, fields] of checkedIn) {
        const liveFields = live.get(name);
        if (liveFields === undefined) {
          removed.push(name);
          continue;
        }
        for (const [fieldName, shape] of fields) {
          const liveShape = liveFields.get(fieldName);
          if (liveShape === undefined) {
            changed.push(`${name}.${fieldName} removed`);
          } else if (liveShape !== shape) {
            changed.push(
              `${name}.${fieldName} changed (${shape} -> ${liveShape})`
            );
          }
        }
        for (const fieldName of liveFields.keys()) {
          if (!fields.has(fieldName)) changed.push(`${name}.${fieldName} added`);
        }
      }
      const added = [...live.keys()].filter((name) => !checkedIn.has(name));

      // Every difference is named. New messages are reported but do not fail:
      // the site adding a message it does not send us breaks nothing.
      if (added.length > 0) {
        console.log(`descriptor drift: new messages: ${added.join(", ")}`);
      }
      expect({ removed, changed }).toStrictEqual({ removed: [], changed: [] });
    },
    600_000
  );
});
