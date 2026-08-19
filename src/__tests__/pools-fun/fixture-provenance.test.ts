/**
 * The capture envelopes have to be honest about themselves.
 *
 * The defect this closes: `discover-deployer-gateway-launch.json` was committed
 * with `capturedAt` 38 minutes BEFORE the `deployedAt` of the row it contained -
 * an envelope reused from an earlier capture. Nothing broke, which is the
 * problem: a fixture's provenance is the only reason to trust it over a
 * hand-written object, and a timestamp that cannot have happened silently
 * destroys that. It is also the exact tell that bytes were pasted into an old
 * envelope rather than re-measured.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("./fixtures/live-captures/", import.meta.url));

const files = readdirSync(DIR).filter((name) => name.endsWith(".json"));

interface Envelope {
  endpoint?: unknown;
  capturedAt?: unknown;
  response?: unknown;
}

function load(name: string): Envelope {
  return JSON.parse(readFileSync(DIR + name, "utf8")) as Envelope;
}

/** Every ISO timestamp anywhere inside the captured payload. */
function timestampsIn(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
    found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) timestampsIn(item, found);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) timestampsIn(item, found);
  }
  return found;
}

describe("live-capture envelopes", () => {
  it("there are captures to check (the sweep must not silently go empty)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)("%s declares an endpoint and a parseable capture time", (name) => {
    const envelope = load(name);
    expect(typeof envelope.endpoint).toBe("string");
    expect(typeof envelope.capturedAt).toBe("string");
    expect(Number.isNaN(Date.parse(envelope.capturedAt as string))).toBe(false);
  });

  it.each(files)("%s was captured no earlier than the data it contains", (name) => {
    const envelope = load(name);
    const capturedAt = Date.parse(envelope.capturedAt as string);
    for (const stamp of timestampsIn(envelope.response)) {
      expect(
        Date.parse(stamp),
        `${name}: contains ${stamp}, which is AFTER its capturedAt ${String(envelope.capturedAt)} - `
          + "the envelope cannot predate its own payload; re-capture rather than reusing an envelope",
      ).toBeLessThanOrEqual(capturedAt);
    }
  });

  it("no capture carries a Vex-controlled probe wallet", () => {
    // The one rule this folder's README states without exception.
    const offenders = files.filter((name) => /33ef6673/i.test(readFileSync(DIR + name, "utf8")));
    expect(offenders).toEqual([]);
  });
});
