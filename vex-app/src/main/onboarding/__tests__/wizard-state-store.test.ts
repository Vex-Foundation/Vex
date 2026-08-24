/**
 * WizardStateStore tests — atomic update under concurrency, schema
 * recovery, and forward-safe transition enforcement on update.
 *
 * The store accepts a `filePath` override so we use real fs against a
 * tmp dir without needing to mock electron.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WizardStateStore } from "../wizard-state-store.js";

let tmpDir = "";
let filePath = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vex-wizard-state-"));
  filePath = path.join(tmpDir, "wizard-state.json");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("WizardStateStore.load", () => {
  it("first load writes the canonical defaults", async () => {
    const store = new WizardStateStore({ filePath });
    const state = await store.load();
    expect(state.schemaVersion).toBe(2);
    expect(state.currentStepId).toBe("keystore");
    expect(state.completedSteps).toEqual([]);
    expect(state.completed).toBe(false);

    const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(onDisk).toEqual(state);
  });

  it("recovers from corrupted JSON by rewriting defaults", async () => {
    await fs.writeFile(filePath, "{ not json", "utf8");
    const store = new WizardStateStore({ filePath });
    const state = await store.load();
    expect(state.currentStepId).toBe("keystore");

    const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(onDisk.currentStepId).toBe("keystore");
  });

  it("recovers from schema-invalid file by rewriting defaults", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 999,
        currentStepId: "unknown",
        completedSteps: [],
        completed: false,
      }),
      "utf8"
    );
    const store = new WizardStateStore({ filePath });
    const state = await store.load();
    expect(state.schemaVersion).toBe(2);
    expect(state.currentStepId).toBe("keystore");
  });

  /**
   * Codex round-4 guardrail #2 — Phase 2 wizard refactor.
   *
   * A v1 wizard-state.json at `keystore` with `completedSteps: []`
   * is visually identical to the v2 defaults, BUT `schemaVersion: 1`
   * is no longer a valid literal. The store must:
   *   1. reject it through recoverDefaults() (marker-first),
   *   2. cause peekCompleted() to return null until the next
   *      user-driven update() clears the marker.
   * Without this, a v1 file would silently look authoritative and
   * skip the destructive-recovery guard.
   */
  it("v1 keystore-empty file triggers recoverDefaults() and peekCompleted stays null", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        currentStepId: "keystore",
        completedSteps: [],
        completed: false,
      }),
      "utf8",
    );
    const store = new WizardStateStore({ filePath });
    const state = await store.load();
    // Recovery branch: schemaVersion bumped to v2.
    expect(state.schemaVersion).toBe(2);
    expect(state.currentStepId).toBe("keystore");
    expect(state.completedSteps).toEqual([]);
    expect(state.completed).toBe(false);
    // Critically: provenance is "recovered", so peekCompleted refuses
    // to trust the on-disk defaults until the next authoritative
    // update() clears the sidecar marker.
    expect(await store.peekCompleted()).toBeNull();

    // Marker present on disk → survives process restart.
    const second = new WizardStateStore({ filePath });
    expect(await second.peekCompleted()).toBeNull();
  });
});

describe("WizardStateStore.update", () => {
  it("resetForFreshVault persists canonical defaults through the production write chain", async () => {
    const store = new WizardStateStore({ filePath });
    await store.update({
      currentStepId: "review",
      completedSteps: ["keystore", "wallets", "apiKeys", "embedding", "agentCore", "provider"],
      completed: true,
    });
    const reset = await store.resetForFreshVault();
    expect(reset.currentStepId).toBe("keystore");
    expect(reset.completedSteps).toEqual([]);
    expect(reset.completed).toBe(false);
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(reset);
    expect(await store.peekCompleted()).toBe(false);
  });

  it("merges currentStepId + completedSteps and persists atomically", async () => {
    const store = new WizardStateStore({ filePath });
    const next = await store.update({
      currentStepId: "wallets",
      completedSteps: ["keystore"],
    });
    expect(next.currentStepId).toBe("wallets");
    expect(next.completedSteps).toEqual(["keystore"]);
    expect(next.completed).toBe(false);

    const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(onDisk.currentStepId).toBe("wallets");
  });

  it("preserves prior `completed` when not present in the input", async () => {
    const store = new WizardStateStore({ filePath });
    await store.update({
      currentStepId: "review",
      completedSteps: [
        "keystore",
        "wallets",
        "apiKeys",
        "embedding",
        "agentCore",
        "provider",
      ],
      completed: true,
    });
    // Subsequent update without `completed` keeps it true.
    const next = await store.update({
      currentStepId: "review",
      completedSteps: [
        "keystore",
        "wallets",
        "apiKeys",
        "embedding",
        "agentCore",
        "provider",
      ],
    });
    expect(next.completed).toBe(true);
  });

  it("rejects backward transitions at the merge layer", async () => {
    const store = new WizardStateStore({ filePath });
    await expect(
      store.update({
        currentStepId: "keystore",
        completedSteps: ["wallets"],
      })
    ).rejects.toThrow();
  });

  it("rejects duplicate completedSteps entries", async () => {
    const store = new WizardStateStore({ filePath });
    await expect(
      store.update({
        currentStepId: "wallets",
        completedSteps: ["keystore", "keystore"],
      })
    ).rejects.toThrow();
  });

  it("serializes concurrent updates so neither write is torn", async () => {
    const store = new WizardStateStore({ filePath });
    // Fire 5 concurrent updates that walk the steps forward. Without
    // the enqueue chain we'd see torn JSON or lost state.
    const updates = [
      store.update({ currentStepId: "wallets", completedSteps: ["keystore"] }),
      store.update({
        currentStepId: "apiKeys",
        completedSteps: ["keystore", "wallets"],
      }),
      store.update({
        currentStepId: "embedding",
        completedSteps: ["keystore", "wallets", "apiKeys"],
      }),
      store.update({
        currentStepId: "agentCore",
        completedSteps: ["keystore", "wallets", "apiKeys", "embedding"],
      }),
      store.update({
        currentStepId: "provider",
        completedSteps: [
          "keystore",
          "wallets",
          "apiKeys",
          "embedding",
          "agentCore",
        ],
      }),
    ];
    await Promise.all(updates);

    const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(onDisk.currentStepId).toBe("provider");
    expect(onDisk.completedSteps).toEqual([
      "keystore",
      "wallets",
      "apiKeys",
      "embedding",
      "agentCore",
    ]);
  });

  it("a fresh store instance reads the persisted state from a previous run", async () => {
    const first = new WizardStateStore({ filePath });
    await first.update({
      currentStepId: "wallets",
      completedSteps: ["keystore"],
    });

    const second = new WizardStateStore({ filePath });
    const state = await second.load();
    expect(state.currentStepId).toBe("wallets");
    expect(state.completedSteps).toEqual(["keystore"]);
  });
});

describe("WizardStateStore.peekCompleted (write-protection guard)", () => {
  it("returns null when the file does not exist (no side effects)", async () => {
    const store = new WizardStateStore({ filePath });
    const result = await store.peekCompleted();
    expect(result).toBeNull();
    // Critically: peek must NOT have created defaults on disk.
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("returns null when the file is corrupt JSON", async () => {
    await fs.writeFile(filePath, "{ not json", "utf8");
    const store = new WizardStateStore({ filePath });
    expect(await store.peekCompleted()).toBeNull();
  });

  it("returns null when the file fails schema validation", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 999,
        currentStepId: "unknown",
        completedSteps: [],
        completed: true,
      }),
      "utf8"
    );
    const store = new WizardStateStore({ filePath });
    expect(await store.peekCompleted()).toBeNull();
  });

  it("returns true when the persisted file reports completed=true", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 2,
        currentStepId: "review",
        completedSteps: [
          "keystore",
          "wallets",
          "apiKeys",
          "embedding",
          "agentCore",
          "provider",
        ],
        completed: true,
      }),
      "utf8"
    );
    const store = new WizardStateStore({ filePath });
    expect(await store.peekCompleted()).toBe(true);
  });

  it("returns false when the persisted file reports completed=false", async () => {
    // Phase 2 refactor: schemaVersion: 1 now triggers recoverDefaults()
    // (see the v1 migration test above), so the false-completed
    // scenario requires a v2 file with progress that isn't authoritative
    // for completion — use a mid-wizard `apiKeys` step instead.
    await fs.writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 2,
        currentStepId: "apiKeys",
        completedSteps: ["keystore", "wallets"],
        completed: false,
      }),
      "utf8"
    );
    const store = new WizardStateStore({ filePath });
    expect(await store.peekCompleted()).toBe(false);
  });

  it("returns null AFTER load() recovered from a missing file (cache provenance)", async () => {
    // Codex review round 4 RED — `load()` writes defaults
    // (completed:false) to disk when the file is missing. A naive
    // peekCompleted would then read disk and return `false`, but the
    // destructive-recovery guard must treat that as unknown. The
    // store tracks provenance so peekCompleted returns null when the
    // current cached/disk state came from auto-recovery.
    const store = new WizardStateStore({ filePath });
    const loaded = await store.load();
    expect(loaded.completed).toBe(false); // defaults were written
    expect(await store.peekCompleted()).toBeNull();
  });

  it("returns null AFTER load() recovered from corrupt JSON", async () => {
    await fs.writeFile(filePath, "{ broken", "utf8");
    const store = new WizardStateStore({ filePath });
    await store.load();
    expect(await store.peekCompleted()).toBeNull();
  });

  it("trusts cache AFTER an authoritative update() (provenance becomes persisted)", async () => {
    // load() recovers defaults — peek returns null. User-driven
    // update() bumps the cache to "persisted" provenance, so the
    // next peek returns the actual flag value.
    const store = new WizardStateStore({ filePath });
    await store.load();
    expect(await store.peekCompleted()).toBeNull();

    await store.update({
      currentStepId: "review",
      completedSteps: [
        "keystore",
        "wallets",
        "apiKeys",
        "embedding",
        "agentCore",
        "provider",
      ],
      completed: true,
    });
    expect(await store.peekCompleted()).toBe(true);
  });

  it("cross-process: recovery marker on disk survives store restart", async () => {
    // Codex review round 5 RED — provenance is in-memory only; the
    // sidecar marker file is what protects the destructive-recovery
    // guard across process restarts. Simulate by recovering with one
    // store instance, then creating a FRESH store with the same
    // filePath and peeking.
    const first = new WizardStateStore({ filePath });
    await first.load(); // recovery branch - defaults written + marker touched

    const second = new WizardStateStore({ filePath });
    expect(await second.peekCompleted()).toBeNull();
  });

  it("cross-process: an authoritative update() clears the marker for future runs", async () => {
    const first = new WizardStateStore({ filePath });
    await first.load();
    await first.update({
      currentStepId: "review",
      completedSteps: [
        "keystore",
        "wallets",
        "apiKeys",
        "embedding",
        "agentCore",
        "provider",
      ],
      completed: true,
    });

    const second = new WizardStateStore({ filePath });
    expect(await second.peekCompleted()).toBe(true);
  });
});
