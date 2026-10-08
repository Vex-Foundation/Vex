import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * LIGHTER_SIGNER_RESIDENT ON (forced here; it also ships on): an adapter built
 * without an injected runner sends every signature to ONE `--serve` child.
 */
vi.mock("@tools/lighter/signer-resident-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tools/lighter/signer-resident-runner.js")>();
  return { ...actual, LIGHTER_SIGNER_RESIDENT: true };
});

const { createLighterRegisteredKeyCheckerBinary } = await import("@tools/lighter/signer-binary-adapter.js");
const { shutdownLighterResidentSigner } = await import("@tools/lighter/signer-resident-runner.js");
const { materialFromSecret } = await import("@tools/lighter/trading-secret.js");

const roots: string[] = [];

afterAll(() => {
  shutdownLighterResidentSigner();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const realChild = process.platform === "win32" ? it.skip : it;

describe("Lighter signer adapters with LIGHTER_SIGNER_RESIDENT on", () => {
  realChild("route every signature to one serve-mode child", async () => {
    const root = mkdtempSync(join(os.tmpdir(), "vex-lighter-signer-on-"));
    roots.push(root);
    const log = join(root, "events.log");
    const helper = join(root, "helper");
    writeFileSync(helper, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ start: process.argv.slice(2) }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ id: envelope.id, operation: envelope.request.operation }) + "\\n");
  process.stdout.write(JSON.stringify({ id: envelope.id, ok: true, publicKey: "b".repeat(80) }) + "\\n");
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

    const events = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as unknown);
    expect(events).toEqual([
      { start: ["--serve"] },
      { id: "1", operation: "checkClient" },
      { id: "2", operation: "checkClient" },
    ]);
  });
});
