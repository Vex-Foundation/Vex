import type { SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLighterResidentSignerRunner,
  LIGHTER_SIGNER_RESIDENT,
  LIGHTER_SIGNER_SERVE_ARGS,
  runLighterSignerResident,
  type LighterResidentSignerRunner,
} from "@tools/lighter/signer-resident-runner.js";
import {
  lighterSignerChildState,
  runLighterSignerBinary,
  selectLighterSignerRunner,
  type LighterSignerBinaryRunRequest,
} from "@tools/lighter/signer-binary-adapter.js";
import { ScriptedResidentSignerChild } from "../helpers/lighter-scripted-signer.js";

const PRIVATE_KEY = `0x${"1".repeat(80)}`;

const AUTH_PAYLOAD = {
  operation: "createAccountAuth",
  privateKey: PRIVATE_KEY,
  chainId: 466324,
  accountIndex: "42",
  apiKeyIndex: 7,
  deadlineUnixSeconds: "1893456600",
} as const;

const AUTH_REQUEST: LighterSignerBinaryRunRequest = {
  binaryPath: "/nonexistent/vex-lighter-signer",
  payload: AUTH_PAYLOAD,
  timeoutMs: 5_000,
};

const AUTH_ANSWER = { ok: true, authToken: `1893456600:42:7:${"a".repeat(128)}`, publicKey: "b".repeat(80) };

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
  readonly child: ScriptedResidentSignerChild;
}

function harness(options: { idleMs?: number; killDrainGraceMs?: number } = {}): {
  runner: LighterResidentSignerRunner;
  spawns: SpawnRecord[];
  child: (index: number) => ScriptedResidentSignerChild;
} {
  const spawns: SpawnRecord[] = [];
  const runner = createLighterResidentSignerRunner({
    spawn: (command, args, spawnOptions) => {
      const child = new ScriptedResidentSignerChild();
      spawns.push({ command, args, options: spawnOptions, child });
      return child;
    },
    killDrainGraceMs: options.killDrainGraceMs ?? 20,
    idleMs: options.idleMs ?? 60_000,
  });
  return {
    runner,
    spawns,
    child: (index) => {
      const record = spawns[index];
      if (record === undefined) throw new Error(`no spawn #${index}`);
      return record.child;
    },
  };
}

/** Let queued promise continuations run. */
async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LIGHTER_SIGNER_RESIDENT switch", () => {
  it("ships on", () => {
    expect(LIGHTER_SIGNER_RESIDENT).toBe(true);
  });

  it("off selects the one-shot runner itself, on selects the resident runner", () => {
    expect(selectLighterSignerRunner(false)).toBe(runLighterSignerBinary);
    expect(selectLighterSignerRunner(true)).toBe(runLighterSignerResident);
  });
});

describe("Lighter resident signer runner", () => {
  it("spawns one serve-mode child with an empty environment and reuses it", async () => {
    const { runner, spawns, child } = harness();

    const first = runner.run(AUTH_REQUEST);
    await flush();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.command).toBe(AUTH_REQUEST.binaryPath);
    expect(spawns[0]?.args).toEqual(LIGHTER_SIGNER_SERVE_ARGS);
    expect(spawns[0]?.args).toEqual(["--serve"]);
    expect(spawns[0]?.options.env).toEqual(process.platform === "win32" ? expect.any(Object) : {});
    expect(child(0).requests()).toEqual([{ id: "1", request: AUTH_REQUEST.payload }]);
    expect(child(0).stdin.lines[0]?.endsWith("\n")).toBe(true);
    child(0).answerLast(AUTH_ANSWER);
    await expect(first).resolves.toEqual(AUTH_ANSWER);

    const second = runner.run(AUTH_REQUEST);
    await flush();
    expect(spawns).toHaveLength(1);
    expect(child(0).requests().map((entry) => entry.id)).toEqual(["1", "2"]);
    child(0).answerLast(AUTH_ANSWER);
    await expect(second).resolves.toEqual(AUTH_ANSWER);
    // An idle resident child never holds the host process open.
    expect(child(0).unreferenced).toBe(true);
    expect(child(0).stdout.unreferenced).toBe(true);
    expect(child(0).stdin.unreferenced).toBe(true);
    runner.shutdown();
  });

  it("serializes requests: the next one is written only after the previous settles", async () => {
    const { runner, child } = harness();
    const first = runner.run(AUTH_REQUEST);
    const second = runner.run(AUTH_REQUEST);
    await flush();
    expect(child(0).stdin.lines).toHaveLength(1);
    child(0).answerLast(AUTH_ANSWER);
    await first;
    await flush();
    expect(child(0).stdin.lines).toHaveLength(2);
    child(0).answerLast(AUTH_ANSWER);
    await expect(second).resolves.toEqual(AUTH_ANSWER);
    runner.shutdown();
  });

  it("maps a helper refusal to the one-shot error shape and keeps the child", async () => {
    const { runner, spawns, child } = harness();
    const refused = runner.run(AUTH_REQUEST);
    await flush();
    child(0).answerLast({ ok: false, errorCode: "invalid_input", error: "invalid nonce" });
    const error: unknown = await refused.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "Lighter signer helper failed (invalid_input)." });
    expect(lighterSignerChildState(error)).toBe("exited");
    expect(child(0).signals).toEqual([]);

    const next = runner.run(AUTH_REQUEST);
    await flush();
    expect(spawns).toHaveLength(1);
    child(0).answerLast(AUTH_ANSWER);
    await expect(next).resolves.toEqual(AUTH_ANSWER);
    runner.shutdown();
  });

  it("after a panic answer waits for the helper to exit, then respawns for the next request", async () => {
    const { runner, spawns, child } = harness();
    const panicked = runner.run(AUTH_REQUEST);
    let settled = false;
    void panicked.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    child(0).answerLast({ ok: false, errorCode: "panic", error: "x" });
    await flush();
    expect(settled).toBe(false);
    expect(child(0).signals).toEqual(["SIGKILL"]);
    child(0).emit("close", 1, null);
    await expect(panicked).rejects.toMatchObject({
      message: "Lighter signer helper failed (panic).",
      lighterSignerChildState: "exited",
    });

    const next = runner.run(AUTH_REQUEST);
    await flush();
    expect(spawns).toHaveLength(2);
    child(1).answerLast(AUTH_ANSWER);
    await expect(next).resolves.toEqual(AUTH_ANSWER);
    runner.shutdown();
  });

  it("on timeout kills the child, settles after its close, and never re-sends the request", async () => {
    const { runner, spawns, child } = harness();
    const timedOut = runner.run({ ...AUTH_REQUEST, timeoutMs: 5 });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(child(0).signals).toEqual(["SIGKILL"]);
    expect(child(0).stdin.endedCount).toBe(1);
    child(0).emit("close", null, "SIGKILL");
    await expect(timedOut).rejects.toMatchObject({
      message: "Lighter signer helper timed out.",
      lighterSignerChildState: "exited",
    });
    expect(child(0).stdin.lines).toHaveLength(1);
    expect(child(0).listenerTotal()).toBe(0);

    const next = runner.run(AUTH_REQUEST);
    await flush();
    expect(spawns).toHaveLength(2);
    expect(child(0).stdin.lines).toHaveLength(1);
    child(1).answerLast(AUTH_ANSWER);
    await expect(next).resolves.toEqual(AUTH_ANSWER);
    runner.shutdown();
  });

  it("abandons a killed child that never closes and reports unknown", async () => {
    const { runner, child } = harness({ killDrainGraceMs: 5 });
    const stuck = runner.run({ ...AUTH_REQUEST, timeoutMs: 5 });
    await expect(stuck).rejects.toMatchObject({
      message: "Lighter signer helper timed out.",
      lighterSignerChildState: "unknown",
    });
    expect(child(0).abandoned()).toBe(true);
    expect(() => child(0).stdout.emit("error", new Error("EPIPE"))).not.toThrow();
    expect(() => child(0).emit("error", new Error("late"))).not.toThrow();
  });

  it.each([
    ["not JSON", "garbage\n"],
    ["a non-object", "[1]\n"],
    ["another request id", `${JSON.stringify({ id: "99", ...AUTH_ANSWER })}\n`],
    ["a missing request id", `${JSON.stringify(AUTH_ANSWER)}\n`],
  ])("treats %s as malformed output: kill, drain, respawn", async (_label, line) => {
    const { runner, spawns, child } = harness();
    const pending = runner.run(AUTH_REQUEST);
    await flush();
    child(0).stdout.emit("data", line);
    await flush();
    expect(child(0).signals).toEqual(["SIGKILL"]);
    child(0).emit("close", null, "SIGKILL");
    await expect(pending).rejects.toMatchObject({
      message: "Lighter signer helper returned invalid output.",
      lighterSignerChildState: "exited",
    });
    const next = runner.run(AUTH_REQUEST);
    await flush();
    expect(spawns).toHaveLength(2);
    child(1).answerLast(AUTH_ANSWER);
    await expect(next).resolves.toEqual(AUTH_ANSWER);
    runner.shutdown();
  });

  it("kills on stdout overflow and reports it", async () => {
    const { runner, child } = harness();
    const pending = runner.run(AUTH_REQUEST);
    await flush();
    child(0).stdout.emit("data", "x".repeat(256 * 1024 + 1));
    child(0).emit("close", null, "SIGKILL");
    await expect(pending).rejects.toMatchObject({
      message: "Lighter signer helper returned too much output.",
      lighterSignerChildState: "exited",
    });
  });

  it("reports a helper that exits mid-request as invalid output, exited", async () => {
    const { runner, spawns, child } = harness();
    const pending = runner.run(AUTH_REQUEST);
    await flush();
    child(0).emit("close", 2, null);
    await expect(pending).rejects.toMatchObject({
      message: "Lighter signer helper returned invalid output.",
      lighterSignerChildState: "exited",
    });
    const next = runner.run(AUTH_REQUEST);
    await flush();
    expect(spawns).toHaveLength(2);
    child(1).answerLast(AUTH_ANSWER);
    await expect(next).resolves.toEqual(AUTH_ANSWER);
    runner.shutdown();
  });

  it("reports a helper that could never be spawned as an exited child", async () => {
    const { runner, child } = harness();
    const pending = runner.run(AUTH_REQUEST);
    await flush();
    child(0).pid = undefined;
    child(0).emit("error", new Error("ENOENT"));
    await expect(pending).rejects.toMatchObject({
      message: "Lighter signer helper is not available.",
      lighterSignerChildState: "exited",
    });
  });

  it("kills and drains when the stdin pipe fails", async () => {
    const { runner, child } = harness();
    const pending = runner.run(AUTH_REQUEST);
    await flush();
    child(0).stdin.emit("error", new Error("EPIPE"));
    child(0).emit("close", null, "SIGKILL");
    await expect(pending).rejects.toMatchObject({
      message: "Lighter signer helper input stream failed.",
      lighterSignerChildState: "exited",
    });
  });

  it("stops an idle child after the idle window and respawns on the next request", async () => {
    const { runner, spawns, child } = harness({ idleMs: 10 });
    const first = runner.run(AUTH_REQUEST);
    await flush();
    child(0).answerLast(AUTH_ANSWER);
    await first;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(child(0).signals).toEqual(["SIGKILL"]);
    child(0).emit("close", null, "SIGKILL");

    const next = runner.run(AUTH_REQUEST);
    await flush();
    expect(spawns).toHaveLength(2);
    child(1).answerLast(AUTH_ANSWER);
    await expect(next).resolves.toEqual(AUTH_ANSWER);
    runner.shutdown();
  });

  it("shutdown terminates the child and fails a request in flight after its close", async () => {
    const { runner, child } = harness();
    const pending = runner.run(AUTH_REQUEST);
    await flush();
    runner.shutdown();
    expect(child(0).signals).toEqual(["SIGKILL"]);
    expect(child(0).stdin.endedCount).toBe(1);
    child(0).emit("close", null, "SIGKILL");
    await expect(pending).rejects.toMatchObject({
      message: "Lighter signer helper stopped because Vex is quitting.",
      lighterSignerChildState: "exited",
    });
  });

  it("a different helper path stops the current child and starts one for the new path", async () => {
    const { runner, spawns, child } = harness();
    const first = runner.run(AUTH_REQUEST);
    await flush();
    child(0).answerLast(AUTH_ANSWER);
    await first;
    const other = runner.run({ ...AUTH_REQUEST, binaryPath: "/nonexistent/other-helper" });
    await flush();
    expect(child(0).signals).toEqual(["SIGKILL"]);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.command).toBe("/nonexistent/other-helper");
    child(1).answerLast(AUTH_ANSWER);
    await expect(other).resolves.toEqual(AUTH_ANSWER);
    runner.shutdown();
  });

  it("stops a child that writes output nobody asked for", async () => {
    const { runner, spawns, child } = harness();
    const first = runner.run(AUTH_REQUEST);
    await flush();
    child(0).answerLast(AUTH_ANSWER);
    await first;
    child(0).stdout.emit("data", "{\"id\":\"7\",\"ok\":true}\n");
    expect(child(0).signals).toEqual(["SIGKILL"]);
    const next = runner.run(AUTH_REQUEST);
    await flush();
    expect(spawns).toHaveLength(2);
    child(1).answerLast(AUTH_ANSWER);
    await expect(next).resolves.toEqual(AUTH_ANSWER);
    runner.shutdown();
  });

  it("keeps the private key out of every rejection", async () => {
    const { runner, child } = harness();
    const pending = runner.run(AUTH_REQUEST);
    await flush();
    child(0).stdout.emit("data", "garbage\n");
    child(0).emit("close", null, "SIGKILL");
    const error: unknown = await pending.catch((caught: unknown) => caught);
    const rendered = `${String(error)} ${JSON.stringify(error)} ${error instanceof Error ? error.stack ?? "" : ""}`;
    expect(rendered).not.toContain("1".repeat(80));
  });
});

/**
 * The packaged helper itself, when it has been built on this machine
 * (`node scripts/build-lighter-signer-runtime.mjs`). Binaries are not tracked,
 * so this suite skips where none was built.
 */
const builtHelper = join(
  process.cwd(),
  "vex-app",
  "resources",
  "lighter-signer",
  process.platform === "win32"
    ? `vex-lighter-signer-${process.platform}-${process.arch}.exe`
    : `vex-lighter-signer-${process.platform}-${process.arch}`,
);

describe.skipIf(!existsSync(builtHelper))("Lighter resident signer runner over the built helper", () => {
  it("signs several requests on one child with the one-shot output shape", async () => {
    const runner = createLighterResidentSignerRunner();
    try {
      const request = { ...AUTH_REQUEST, binaryPath: builtHelper };
      const oneShot = await runLighterSignerBinary(request) as Record<string, unknown>;
      const answers = [
        await runner.run(request),
        await runner.run(request),
        await runner.run(request),
      ] as Array<Record<string, unknown>>;
      for (const answer of answers) {
        expect(Object.keys(answer).sort()).toEqual(Object.keys(oneShot).sort());
        expect(answer.ok).toBe(true);
        expect(answer.publicKey).toBe(oneShot.publicKey);
        expect(String(answer.authToken).split(":").slice(0, 3)).toEqual(
          String(oneShot.authToken).split(":").slice(0, 3),
        );
      }

      const refusal = await runner.run({
        ...request,
        payload: { ...AUTH_PAYLOAD, apiKeyIndex: 2 },
      }).catch((caught: unknown) => caught);
      const oneShotRefusal = await runLighterSignerBinary({
        ...request,
        payload: { ...AUTH_PAYLOAD, apiKeyIndex: 2 },
      }).catch((caught: unknown) => caught);
      expect(refusal).toMatchObject({ message: "Lighter signer helper failed (invalid_input)." });
      expect(oneShotRefusal).toMatchObject({ message: "Lighter signer helper failed (invalid_input)." });
      expect(lighterSignerChildState(refusal)).toBe("exited");

      // The child survived the refusal and still answers.
      await expect(runner.run(request)).resolves.toMatchObject({ ok: true });
    } finally {
      runner.shutdown();
    }
  });
});
