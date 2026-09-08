import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLighterApiKeyGeneratorBinary,
  createLighterRegisteredKeyCheckerBinary,
  createLighterSignerBinaryAdapter,
  lighterSignerChildState,
  resolveDefaultLighterSignerBinaryPath,
  runLighterSignerBinary,
  type LighterSignerBinaryRunRequest,
} from "@tools/lighter/signer-binary-adapter.js";
import {
  buildLighterAccountAuthSigningInput,
  buildLighterCreateOrderSigningInput,
  createLighterAccountAuthWithAdapter,
  signLighterCreateOrderWithAdapter,
} from "@tools/lighter/signer-adapter.js";
import { buildLighterUnsignedCreateOrderRequest } from "@tools/lighter/signer-order.js";
import { materialFromSecret } from "@tools/lighter/trading-secret.js";
import type { LighterOrderReadyForSignerPlan } from "@vex-agent/tools/protocols/lighter/execution-plan.js";

const PRIVATE_KEY = `0x${"1".repeat(80)}`;

function plan(overrides: Partial<LighterOrderReadyForSignerPlan> = {}): LighterOrderReadyForSignerPlan {
  return {
    // The consent expiry the execution owners revalidate before signing; this
    // fixture only has to carry one, so it is far in the future.
    expiresAt: "2030-01-01T00:00:00.000Z",
    intentId: "lighter-exec-1",
    sessionId: "session-1",
    previewId: "lighter-preview-1",
    matchHash: `${"a".repeat(12)}${"b".repeat(52)}`,
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    marketIndex: 0,
    side: "sell",
    baseAmountInteger: "281474976710655",
    priceInteger: "300000",
    orderType: "limit",
    timeInForce: "good-till-time",
    reduceOnly: false,
    triggerPriceInteger: null,
    orderExpiryMs: 1893456000000,
    clientOrderIndexPolicy: "vex_assigned_uint48",
    providerVersion: "lighter-preview-v1",
    credentialReference: {
      kind: "encrypted_vault_reference",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      vaultCredentialId: "lighter/rhc/account-42/api-key-7",
    },
    nonceScope: {
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
    },
    ...overrides,
  };
}

function signingInput() {
  return buildLighterCreateOrderSigningInput({
    order: buildLighterUnsignedCreateOrderRequest(plan()),
    secret: materialFromSecret(PRIVATE_KEY),
    nonce: "1784732515923",
  });
}

describe("Lighter signer binary adapter", () => {
  it("generates and independently re-derives an ecgfp5 keypair", async () => {
    const calls: LighterSignerBinaryRunRequest[] = [];
    const generator = createLighterApiKeyGeneratorBinary({
      binaryPath: "/tmp/vex-lighter-signer-test",
      runner: async (request) => {
        calls.push(request);
        if (request.payload.operation === "generateApiKey") {
          return {
            ok: true,
            privateKey: PRIVATE_KEY,
            publicKey: `0x${"b".repeat(80)}`,
          };
        }
        return { ok: true, publicKey: "b".repeat(80) };
      },
    });

    const generated = await generator.generate();

    expect(generated.publicKey).toBe("b".repeat(80));
    expect(generated.secret.privateKey).toBe(PRIVATE_KEY);
    expect(JSON.stringify(generated)).not.toContain(PRIVATE_KEY);
    expect(calls.map((call) => call.payload.operation)).toEqual([
      "generateApiKey",
      "derivePublicKey",
    ]);
    expect(calls[0]?.payload).toEqual({ operation: "generateApiKey" });
    expect(calls[1]?.payload).toEqual({
      operation: "derivePublicKey",
      privateKey: PRIVATE_KEY,
    });
  });

  it("refuses a generated keypair whose derived public key differs", async () => {
    const generator = createLighterApiKeyGeneratorBinary({
      binaryPath: "/tmp/vex-lighter-signer-test",
      runner: async (request) => request.payload.operation === "generateApiKey"
        ? { ok: true, privateKey: PRIVATE_KEY, publicKey: "b".repeat(80) }
        : { ok: true, publicKey: "c".repeat(80) },
    });

    await expect(generator.generate()).rejects.toThrow(
      "Lighter signer helper failed (keypair_mismatch)",
    );
  });

  it("creates canonical account auth without putting the key in process arguments", async () => {
    const calls: LighterSignerBinaryRunRequest[] = [];
    const input = buildLighterAccountAuthSigningInput({
      order: buildLighterUnsignedCreateOrderRequest(plan()),
      secret: materialFromSecret(PRIVATE_KEY),
      deadlineUnixSeconds: 1_893_456_600,
    });
    const adapter = createLighterSignerBinaryAdapter({
      binaryPath: "/tmp/vex-lighter-signer-test",
      runner: async (request) => {
        calls.push(request);
        return {
          ok: true,
          authToken: `1893456600:42:7:${"a".repeat(128)}`,
          publicKey: "b".repeat(80),
        };
      },
    });

    await expect(createLighterAccountAuthWithAdapter(input, adapter)).resolves.toMatchObject({
      authToken: `1893456600:42:7:${"a".repeat(128)}`,
      publicKey: "b".repeat(80),
    });
    expect(calls[0]?.payload).toEqual({
      operation: "createAccountAuth",
      privateKey: PRIVATE_KEY,
      chainId: 466324,
      accountIndex: "42",
      apiKeyIndex: 7,
      deadlineUnixSeconds: "1893456600",
    });
  });

  it.each([
    ["core", 304],
    ["rhc", 466324],
  ] as const)("runs official CheckClient for %s through a separate privileged surface", async (
    environment,
    chainId,
  ) => {
    const calls: LighterSignerBinaryRunRequest[] = [];
    const checker = createLighterRegisteredKeyCheckerBinary({
      binaryPath: "/tmp/vex-lighter-signer-test",
      runner: async (request) => {
        calls.push(request);
        return { ok: true, publicKey: `0x${"b".repeat(80)}` };
      },
    });

    await expect(checker.check({
      environment,
      accountIndex: 42,
      apiKeyIndex: 7,
      secret: materialFromSecret(PRIVATE_KEY),
    })).resolves.toEqual({ publicKey: "b".repeat(80) });
    expect(calls[0]?.payload).toEqual({
      operation: "checkClient",
      privateKey: PRIVATE_KEY,
      chainId,
      accountIndex: "42",
      apiKeyIndex: 7,
    });
  });

  it("maps signer input into the helper stdin payload with exact decimal strings", async () => {
    const calls: LighterSignerBinaryRunRequest[] = [];
    const input = signingInput();
    const adapter = createLighterSignerBinaryAdapter({
      binaryPath: "/tmp/vex-lighter-signer-test",
      runner: async (request) => {
        calls.push(request);
        return {
          ok: true,
          txType: 14,
          txInfo: "{\"Tx\":\"signed\"}",
          txHash: "0xabc123",
        };
      },
    });

    const result = await signLighterCreateOrderWithAdapter(input, adapter);

    expect(result).toMatchObject({
      txType: 14,
      txInfo: "{\"Tx\":\"signed\"}",
      txHash: "0xabc123",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.binaryPath).toBe("/tmp/vex-lighter-signer-test");
    expect(calls[0]?.payload).toMatchObject({
      operation: "signCreateOrder",
      privateKey: PRIVATE_KEY,
      chainId: 466324,
      accountIndex: "42",
      apiKeyIndex: 7,
      nonce: "1784732515923",
      order: {
        marketIndex: 0,
        clientOrderIndex: input.order.clientOrderIndex,
        baseAmount: "281474976710655",
        price: "300000",
        isAsk: 1,
        orderType: 0,
        timeInForce: 1,
        reduceOnly: 0,
        triggerPrice: "0",
        orderExpiry: "1893456000000",
      },
    });
  });

  it("returns structural helper failures without echoing helper error text", async () => {
    const adapter = createLighterSignerBinaryAdapter({
      binaryPath: "/tmp/vex-lighter-signer-test",
      runner: async () => ({
        ok: false,
        errorCode: "signing_failed",
        error: `bad private key ${"1".repeat(80)} tx_info Sig`,
      }),
    });

    await expect(signLighterCreateOrderWithAdapter(signingInput(), adapter))
      .rejects.toMatchObject({
        message: "Lighter signer helper failed (signing_failed).",
      });
  });

  it("resolves packaged and local signer helper paths", () => {
    expect(resolveDefaultLighterSignerBinaryPath({
      resourcesPath: "/Applications/Vex.app/Contents/Resources",
      platform: "darwin",
      arch: "arm64",
    })).toBe("/Applications/Vex.app/Contents/Resources/lighter-signer/vex-lighter-signer-darwin-arm64");

    expect(resolveDefaultLighterSignerBinaryPath({
      cwd: "/repo",
      platform: "win32",
      arch: "x64",
    })).toBe(join("/repo", "vex-app", "resources", "lighter-signer", "vex-lighter-signer-win32-x64.exe"));

    expect(resolveDefaultLighterSignerBinaryPath({
      resourcesPath: "/Applications/Electron.app/Contents/Resources",
      cwd: "/repo/vex-app",
      platform: "darwin",
      arch: "arm64",
      defaultApp: true,
    })).toBe(join("/repo", "vex-app", "resources", "lighter-signer", "vex-lighter-signer-darwin-arm64"));
  });

});


describe("Lighter signed fee attribute binding", () => {
  it("rejects missing, changed and undisclosed collector attributes", async () => {
    const base = signingInput();
    const integratorFees = { integratorAccountIndex: 123, integratorMakerFee: 1000, integratorTakerFee: 1000 };
    const input = { ...base, order: { ...base.order, integratorFees } };
    const run = (attributes: unknown) => createLighterSignerBinaryAdapter({
      runner: async (request) => {
        expect(request.payload.operation).toBe("signCreateOrder");
        if (request.payload.operation === "signCreateOrder") expect(request.payload.integratorFees).toEqual(integratorFees);
        return { ok: true, txType: 14, txInfo: JSON.stringify({ L2TxAttributes: attributes }), txHash: "ab".repeat(40) };
      },
    }).signCreateOrder(input);
    await expect(run({ "1": 123, "2": 1000, "3": 1000 })).resolves.toMatchObject({ txType: 14 });
    for (const attrs of [null, {}, { "1": 124, "2": 1000, "3": 1000 }, { "1": 123, "2": 999, "3": 1000 }, { "1": 123, "2": 1000, "3": 1000, "4": 1 }]) {
      await expect(run(attrs)).rejects.toThrow();
    }
    const unexpected = createLighterSignerBinaryAdapter({ runner: async () => ({ ok: true, txType: 14,
      txInfo: JSON.stringify({ L2TxAttributes: { "1": 123, "2": 1000, "3": 1000 } }), txHash: "ab".repeat(40) }) });
    await expect(unexpected.signCreateOrder(base)).rejects.toThrow();
  });
});

/**
 * THE CHILD-PROCESS CONTRACT of the signer helper (plan section 12.4).
 *
 * Two kinds of evidence, on purpose. The REAL-CHILD tests spawn an actual
 * executable, so they prove what only a real process can: that the helper is
 * started with no arguments, that its environment is empty, and that a hung
 * child is killed and still awaited. The SCRIPTED-CHILD tests drive an injected
 * spawner, because the state that matters most - a child that does not close
 * even after SIGKILL - cannot be produced by a real process on purpose (SIGKILL
 * is not catchable), and a race that cannot be produced cannot be tested with
 * wall-clock sleeps either.
 *
 * The listener assertion follows the pattern of VS Code's
 * `ptyHostService.test.ts` ("listener counts should not grow"): the interesting
 * failure is not one leaked handle, it is the per-signature accumulation in a
 * process that signs all day.
 */

const temporaryRoots: string[] = [];

function temporaryHelper(body: string): string {
  const root = mkdtempSync(join(os.tmpdir(), "vex-lighter-signer-"));
  temporaryRoots.push(root);
  const file = join(root, "helper");
  writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A child whose every transition this test decides. */
class ScriptedChild extends EventEmitter {
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  readonly stderr = new EventEmitter();
  readonly stdin = Object.assign(new EventEmitter(), { end: () => undefined });
  pid: number | undefined = 4242;
  readonly signals: string[] = [];
  unreferenced = false;

  kill(signal: string): boolean {
    this.signals.push(signal);
    return true;
  }

  unref(): void {
    this.unreferenced = true;
  }

  /** Every listener this runner registered, across the child and its pipes. */
  listenerTotal(): number {
    const emitters = [this, this.stdout, this.stderr, this.stdin];
    return emitters.reduce(
      (total, emitter) => total + emitter.eventNames().reduce(
        (sum, name) => sum + emitter.listenerCount(name as string),
        0,
      ),
      0,
    );
  }
}

function scriptedDependencies(child: ScriptedChild, killDrainGraceMs = 20) {
  return {
    spawn: () => child,
    killDrainGraceMs,
  };
}

const REQUEST: LighterSignerBinaryRunRequest = {
  binaryPath: "/nonexistent/vex-lighter-signer",
  payload: { operation: "generateApiKey" },
  timeoutMs: 5_000,
};

describe("Lighter signer helper child lifecycle", () => {
  const realChild = process.platform === "win32" ? it.skip : it;

  realChild("runs the helper with no arguments and an empty environment", async () => {
    process.env.VEX_SIGNER_ENV_LEAK_PROBE = "must-not-reach-the-helper";
    try {
      const helper = temporaryHelper(`
        let input = "";
        process.stdin.on("data", (chunk) => { input += chunk; });
        process.stdin.on("end", () => {
          process.stdout.write(JSON.stringify({
            ok: true,
            publicKey: "b".repeat(80),
            privateKey: "0x" + "1".repeat(80),
            argv: process.argv.slice(2),
            envKeys: Object.keys(process.env).sort(),
            sawPayload: JSON.parse(input).operation,
          }));
        });
      `);

      const result = await runLighterSignerBinary({
        binaryPath: helper,
        payload: { operation: "generateApiKey" },
        timeoutMs: 10_000,
      }) as {
        argv: string[];
        envKeys: string[];
        sawPayload: string;
      };

      expect(result.sawPayload).toBe("generateApiKey");
      expect(result.argv).toEqual([]);
      // The vault-populated environment of the privileged process never reaches
      // the process that holds a trading private key.
      expect(result.envKeys).toEqual([]);
    } finally {
      delete process.env.VEX_SIGNER_ENV_LEAK_PROBE;
    }
  });

  realChild("kills a hung helper, waits for its close, and reports an exited child", async () => {
    const helper = temporaryHelper(`
      process.stdin.resume();
      setInterval(() => {}, 1000);
    `);

    await expect(runLighterSignerBinary({
      binaryPath: helper,
      payload: { operation: "generateApiKey" },
      timeoutMs: 150,
    })).rejects.toMatchObject({
      message: "Lighter signer helper timed out.",
      lighterSignerChildState: "exited",
    });
  });

  it("does not settle before the child's close event", async () => {
    const child = new ScriptedChild();
    const pending = runLighterSignerBinary(REQUEST, scriptedDependencies(child));

    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    child.stdout.emit("data", JSON.stringify({ ok: true, publicKey: "b".repeat(80) }));
    child.emit("exit", 0, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit("close", 0);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(child.listenerTotal()).toBe(0);
  });

  it("drains a killed child before settling, and settles as exited when it closes", async () => {
    const child = new ScriptedChild();
    const pending = runLighterSignerBinary(
      { ...REQUEST, timeoutMs: 5 } as LighterSignerBinaryRunRequest,
      scriptedDependencies(child, 10_000),
    );
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(child.signals).toEqual(["SIGKILL"]);
    expect(settled).toBe(false);

    child.emit("close", null);
    await expect(pending).rejects.toMatchObject({
      message: "Lighter signer helper timed out.",
      lighterSignerChildState: "exited",
    });
    expect(child.unreferenced).toBe(false);
    expect(child.listenerTotal()).toBe(0);
  });

  it("settles with an unknown child state when a killed child never closes", async () => {
    const child = new ScriptedChild();
    const pending = runLighterSignerBinary(
      { ...REQUEST, timeoutMs: 5 } as LighterSignerBinaryRunRequest,
      scriptedDependencies(child, 15),
    );

    const error = await pending.then(() => null, (err: unknown) => err);
    expect(lighterSignerChildState(error)).toBe("unknown");
    expect(child.signals).toEqual(["SIGKILL"]);
    // Unref'd so a wedged helper cannot hold the app open, and no listener is
    // left behind waiting for a close that will never come.
    expect(child.unreferenced).toBe(true);
    expect(child.listenerTotal()).toBe(0);
  });

  it("kills and drains on output overflow, reporting the first failure", async () => {
    const child = new ScriptedChild();
    const pending = runLighterSignerBinary(REQUEST, scriptedDependencies(child));

    child.stdout.emit("data", "x".repeat(256 * 1024 + 1));
    await Promise.resolve();
    expect(child.signals).toEqual(["SIGKILL"]);

    child.emit("close", 3);
    await expect(pending).rejects.toMatchObject({
      message: "Lighter signer helper returned too much output.",
      lighterSignerChildState: "exited",
    });
    expect(child.listenerTotal()).toBe(0);
  });

  it("kills and drains when the stdin pipe fails", async () => {
    const child = new ScriptedChild();
    const pending = runLighterSignerBinary(REQUEST, scriptedDependencies(child));

    child.stdin.emit("error", new Error("EPIPE"));
    await Promise.resolve();
    expect(child.signals).toEqual(["SIGKILL"]);

    child.emit("close", null);
    await expect(pending).rejects.toMatchObject({
      message: "Lighter signer helper input stream failed.",
      lighterSignerChildState: "exited",
    });
    expect(child.listenerTotal()).toBe(0);
  });

  it("reports a helper that could never be spawned as an exited child", async () => {
    const child = new ScriptedChild();
    child.pid = undefined;
    const pending = runLighterSignerBinary(REQUEST, scriptedDependencies(child));

    child.emit("error", new Error("ENOENT"));
    await expect(pending).rejects.toMatchObject({
      message: "Lighter signer helper is not available.",
      lighterSignerChildState: "exited",
    });
    expect(child.signals).toEqual([]);
    expect(child.listenerTotal()).toBe(0);
  });

  it("passes an empty environment to the child on this platform", async () => {
    const child = new ScriptedChild();
    let seen: Record<string, unknown> | undefined;
    const pending = runLighterSignerBinary(REQUEST, {
      spawn: (_path: string, _args: readonly string[], options: SpawnOptions) => {
        seen = options.env;
        return child;
      },
      killDrainGraceMs: 20,
    });
    child.stdout.emit("data", JSON.stringify({ ok: true }));
    child.emit("close", 0);
    await pending;

    expect(seen).toBeDefined();
    const inherited = Object.keys(seen ?? {});
    expect(process.platform === "win32"
      ? inherited.every((name) => name === "SystemRoot" || name === "windir")
      : inherited.length === 0).toBe(true);
  });
});

describe("Lighter signer helper path override", () => {
  const OVERRIDE = "/tmp/attacker-supplied-signer";

  afterEach(() => {
    delete process.env.VEX_LIGHTER_SIGNER_BINARY_PATH;
  });

  it("ignores VEX_LIGHTER_SIGNER_BINARY_PATH unless the caller allows the override", () => {
    process.env.VEX_LIGHTER_SIGNER_BINARY_PATH = OVERRIDE;

    // The packaged app (and any caller that never made the decision) runs the
    // helper that ships inside the bundle: the private key goes to a signed,
    // digest-verified binary or to nothing.
    expect(resolveDefaultLighterSignerBinaryPath({
      resourcesPath: "/Applications/Vex.app/Contents/Resources",
      platform: "darwin",
      arch: "arm64",
    })).toBe("/Applications/Vex.app/Contents/Resources/lighter-signer/vex-lighter-signer-darwin-arm64");

    expect(resolveDefaultLighterSignerBinaryPath({
      resourcesPath: "/Applications/Vex.app/Contents/Resources",
      platform: "darwin",
      arch: "arm64",
      allowBinaryPathOverride: false,
    })).toBe("/Applications/Vex.app/Contents/Resources/lighter-signer/vex-lighter-signer-darwin-arm64");

    // An unpackaged build may point at a locally built helper.
    expect(resolveDefaultLighterSignerBinaryPath({
      resourcesPath: "/Applications/Vex.app/Contents/Resources",
      platform: "darwin",
      arch: "arm64",
      allowBinaryPathOverride: true,
    })).toBe(OVERRIDE);
  });

  it("keeps the packaged helper when an adapter is built without an explicit decision", () => {
    process.env.VEX_LIGHTER_SIGNER_BINARY_PATH = OVERRIDE;
    const calls: LighterSignerBinaryRunRequest[] = [];
    const adapter = createLighterSignerBinaryAdapter({
      runner: async (request) => {
        calls.push(request);
        return { ok: true, txType: 14, txInfo: JSON.stringify({}), txHash: "ab".repeat(40) };
      },
    });

    return signLighterCreateOrderWithAdapter(signingInput(), adapter).then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0].binaryPath).not.toBe(OVERRIDE);
      expect(calls[0].binaryPath).toContain("vex-lighter-signer-");
    });
  });
});
