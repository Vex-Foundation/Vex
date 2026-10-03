import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLighterRegisteredKeyCheckerBinary } from "@tools/lighter/signer-binary-adapter.js";
import { LIGHTER_SIGNER_RESIDENT } from "@tools/lighter/signer-resident-runner.js";
import { materialFromSecret } from "@tools/lighter/trading-secret.js";

/**
 * LIGHTER_SIGNER_RESIDENT OFF (forced here; it ships on) is the one-shot
 * rollback path: an adapter built without an injected runner spawns one helper
 * per signature, with no arguments, which reads one payload and exits.
 */
vi.mock("@tools/lighter/signer-resident-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tools/lighter/signer-resident-runner.js")>();
  return { ...actual, LIGHTER_SIGNER_RESIDENT: false };
});
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const realChild = process.platform === "win32" ? it.skip : it;

describe("Lighter signer adapters with LIGHTER_SIGNER_RESIDENT off", () => {
  realChild("spawn one no-argument helper per signature, exactly as before", async () => {
    expect(LIGHTER_SIGNER_RESIDENT).toBe(false);
    const root = mkdtempSync(join(os.tmpdir(), "vex-lighter-signer-off-"));
    roots.push(root);
    const log = join(root, "starts.log");
    const helper = join(root, "helper");
    writeFileSync(helper, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const operation = JSON.parse(input).operation;
  process.stdout.write(JSON.stringify({ ok: operation === "checkClient", publicKey: "b".repeat(80) }));
});
`);
    chmodSync(helper, 0o755);

    const checker = createLighterRegisteredKeyCheckerBinary({ binaryPath: helper });
    const input = {
      environment: "rhc" as const,
      accountIndex: 42,
      apiKeyIndex: 7,
      secret: materialFromSecret(`0x${"1".repeat(80)}`),
    };
    await expect(checker.check(input)).resolves.toEqual({ publicKey: "b".repeat(80) });
    await expect(checker.check(input)).resolves.toEqual({ publicKey: "b".repeat(80) });

    const starts = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(starts).toEqual([[], []]);
  });
});
