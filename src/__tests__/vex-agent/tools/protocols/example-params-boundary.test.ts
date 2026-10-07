/**
 * Every manifest's `exampleParams` must pass its own boundary gate.
 *
 * THE DEFECT THIS CLOSES, measured in a live verification (2026-10-07)
 *
 * `dexscreener.pair.get` advertised `include: "reactions,insight"` in both its
 * description and its `exampleParams`, and `validateProtocolParams` refused it:
 * the enum gate compared the whole comma-separated string against the closed
 * value set, so the one call the manifest itself recommended could never run.
 *
 * `exampleParams` is the call a model copies first - it is shipped on the
 * discovery row and spliced into the missing-required refusal as "Send: ...".
 * An example the boundary refuses is a contract that lies on its first use, so
 * this sweep covers EVERY registered protocol manifest, not only DexScreener.
 */

import { describe, expect, it } from "vitest";

import { NAMESPACE_MODULES } from "@vex-agent/tools/protocols/catalog.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";

const MANIFESTS = NAMESPACE_MODULES.flatMap((mod) => mod.manifests);

describe("exampleParams pass validateProtocolParams", () => {
  it("covers a non-trivial fleet (guards against an empty sweep)", () => {
    expect(MANIFESTS.length).toBeGreaterThan(50);
  });

  it.each(MANIFESTS.map((manifest) => [manifest.toolId, manifest] as const))(
    "%s",
    (_toolId, manifest) => {
      // A COPY: the gate normalizes chain values in place and must not mutate
      // the shared manifest example other suites read.
      const outcome = validateProtocolParams(manifest, structuredClone({ ...manifest.exampleParams }));
      expect(outcome).toEqual({ ok: true });
    },
  );
});
