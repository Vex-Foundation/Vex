/**
 * Tests for env-state helpers — verifies presence-only behavior +
 * URL redaction. Real fetch is left to integration tests; here we
 * pin the parser semantics that protect from key/value leakage.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  gatherWalletProbe,
  readEnvKeyPresence,
  readEnvValue,
  redactEmbeddingUrl,
} = await import("../env-state.js");

// Canonical non-legacy inventory ids (isValidWalletId: `<prefix>_<uuid>`).
const EVM_ID = "evm_0123abcd-0123-0123-0123-0123456789ab";
const SOL_ID = "sol_0123abcd-0123-0123-0123-0123456789ab";
const EVM_ADDR = "0x1111111111111111111111111111111111111111";
const SOL_ADDR = "SoLPrimary11111111111111111111111111111111";
const { log } = await import("../../logger/index.js");

describe("readEnvKeyPresence", () => {
  let tmp = "";
  let envFile = "";

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "vex-envstate-"));
    envFile = path.join(tmp, ".env");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns true when the key has a non-empty value", async () => {
    writeFileSync(envFile, "VEX_KEYSTORE_PASSWORD=correct horse battery staple\n", "utf8");
    expect(await readEnvKeyPresence(envFile, "VEX_KEYSTORE_PASSWORD")).toBe(true);
  });

  it("returns false when the key is absent", async () => {
    writeFileSync(envFile, "OTHER_KEY=value\n", "utf8");
    expect(await readEnvKeyPresence(envFile, "VEX_KEYSTORE_PASSWORD")).toBe(false);
  });

  it("returns false when the key has an empty value", async () => {
    writeFileSync(envFile, "VEX_KEYSTORE_PASSWORD=\n", "utf8");
    expect(await readEnvKeyPresence(envFile, "VEX_KEYSTORE_PASSWORD")).toBe(false);
  });

  it("returns false when the file does not exist", async () => {
    expect(await readEnvKeyPresence(envFile, "ANY")).toBe(false);
  });

  it("escapes regex metacharacters in key names", async () => {
    writeFileSync(envFile, "MY.KEY+VAL=set\n", "utf8");
    expect(await readEnvKeyPresence(envFile, "MY.KEY+VAL")).toBe(true);
    expect(await readEnvKeyPresence(envFile, "MY[KEY]")).toBe(false);
  });
});

describe("readEnvValue", () => {
  let tmp = "";
  let envFile = "";

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "vex-envvalue-"));
    envFile = path.join(tmp, ".env");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the unquoted value", async () => {
    writeFileSync(envFile, 'EMBEDDING_BASE_URL="http://127.0.0.1:12434/engines/llama.cpp/v1"\n', "utf8");
    expect(await readEnvValue(envFile, "EMBEDDING_BASE_URL")).toBe(
      "http://127.0.0.1:12434/engines/llama.cpp/v1"
    );
  });

  it("returns null when key is missing", async () => {
    writeFileSync(envFile, "OTHER=value\n", "utf8");
    expect(await readEnvValue(envFile, "EMBEDDING_BASE_URL")).toBeNull();
  });

  it("returns null when value is empty", async () => {
    writeFileSync(envFile, "EMBEDDING_BASE_URL=\n", "utf8");
    expect(await readEnvValue(envFile, "EMBEDDING_BASE_URL")).toBeNull();
  });
});

// Address resolution is exercised through the production probe
// (`gatherWalletProbe(...).addresses`); these cases don't write keystore
// files, so they assert addresses only (status is covered separately below).
describe("gatherWalletProbe - primary address resolution", () => {
  let tmp = "";
  let configFile = "";

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "vex-walletaddr-"));
    configFile = path.join(tmp, "config.json");
    vi.mocked(log.warn).mockClear();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns both addresses when config.json is fully valid", async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        wallet: {
          address: "0xabc",
          solanaAddress: "SoLanA1111111111111111111111111111111111111",
        },
      }),
      "utf8",
    );
    expect((await gatherWalletProbe(configFile, tmp)).addresses).toEqual({
      evm: "0xabc",
      solana: "SoLanA1111111111111111111111111111111111111",
    });
  });

  it("returns {evm:null, solana:null} when the config file is missing (silent - no warn for expected first-run state)", async () => {
    expect((await gatherWalletProbe(configFile, tmp)).addresses).toEqual({
      evm: null,
      solana: null,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("returns {evm:null, solana:null} when the file contains malformed JSON (warns - corrupt config is operationally meaningful)", async () => {
    writeFileSync(configFile, "{not-valid-json", "utf8");
    expect((await gatherWalletProbe(configFile, tmp)).addresses).toEqual({
      evm: null,
      solana: null,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("returns nulls when wallet key is absent (config exists but has no addresses)", async () => {
    writeFileSync(configFile, JSON.stringify({ chain: "evm" }), "utf8");
    expect((await gatherWalletProbe(configFile, tmp)).addresses).toEqual({
      evm: null,
      solana: null,
    });
  });

  it("returns nulls when wallet object has no address fields", async () => {
    writeFileSync(configFile, JSON.stringify({ wallet: {} }), "utf8");
    expect((await gatherWalletProbe(configFile, tmp)).addresses).toEqual({
      evm: null,
      solana: null,
    });
  });

  it("collapses to nulls when wallet.address is a non-string (schema rejection)", async () => {
    writeFileSync(
      configFile,
      JSON.stringify({ wallet: { address: 12345 } }),
      "utf8",
    );
    expect((await gatherWalletProbe(configFile, tmp)).addresses).toEqual({
      evm: null,
      solana: null,
    });
  });

  it("ignores unknown top-level keys (passthrough on outer object)", async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        wallet: { address: "0xabc", solanaAddress: null },
        chain: "evm",
        unrelated: { nested: true },
      }),
      "utf8",
    );
    expect((await gatherWalletProbe(configFile, tmp)).addresses).toEqual({
      evm: "0xabc",
      solana: null,
    });
  });

  it("returns the primary entry address from the multi-wallet inventory arrays", async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        wallet: {
          evm: [
            { id: EVM_ID, address: EVM_ADDR, label: "Primary", createdAt: "2026-01-01T00:00:00Z" },
          ],
          solana: [
            { id: SOL_ID, address: SOL_ADDR, label: "Primary", createdAt: "2026-01-01T00:00:00Z" },
          ],
        },
      }),
      "utf8",
    );
    expect((await gatherWalletProbe(configFile, tmp)).addresses).toEqual({
      evm: EVM_ADDR,
      solana: SOL_ADDR,
    });
  });

  it("uses the first inventory entry as primary when a family has multiple wallets", async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        wallet: {
          evm: [
            { id: EVM_ID, address: EVM_ADDR, label: "Primary", createdAt: "2026-01-01T00:00:00Z" },
            {
              id: "evm_0123abcd-0123-0123-0123-0123456789ac",
              address: "0x2222222222222222222222222222222222222222",
              label: "Secondary",
              createdAt: "2026-02-01T00:00:00Z",
            },
          ],
          solana: [],
        },
      }),
      "utf8",
    );
    expect((await gatherWalletProbe(configFile, tmp)).addresses).toEqual({
      evm: EVM_ADDR,
      solana: null,
    });
  });

  it("prefers inventory arrays over legacy scalars (all-or-nothing precedence, never per-field)", async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        wallet: {
          // arrays present -> legacy scalars must be ignored entirely
          evm: [
            { id: EVM_ID, address: EVM_ADDR, label: "Primary", createdAt: "2026-01-01T00:00:00Z" },
          ],
          solana: [],
          address: "0xDEADLEGACY",
          solanaAddress: "SoLegacy",
        },
      }),
      "utf8",
    );
    expect((await gatherWalletProbe(configFile, tmp)).addresses).toEqual({
      evm: EVM_ADDR,
      // solana array is present-but-empty -> arrays win, legacy ignored -> null
      solana: null,
    });
  });

  it("drops malformed / non-canonical inventory rows the real inventory would reject", async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        wallet: {
          evm: [
            // non-canonical id (would escape derivePath) -> dropped
            { id: "evm_not-a-uuid", address: EVM_ADDR, label: "x", createdAt: "2026-01-01T00:00:00Z" },
          ],
          solana: [
            // missing required address -> dropped
            { id: SOL_ID, label: "x", createdAt: "2026-01-01T00:00:00Z" },
          ],
        },
      }),
      "utf8",
    );
    expect((await gatherWalletProbe(configFile, tmp)).addresses).toEqual({
      evm: null,
      solana: null,
    });
  });
});

describe("gatherWalletProbe", () => {
  let tmp = "";
  let configFile = "";

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "vex-walletprobe-"));
    configFile = path.join(tmp, "config.json");
    vi.mocked(log.warn).mockClear();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const writeConfig = (wallet: unknown): void => {
    writeFileSync(configFile, JSON.stringify({ wallet }), "utf8");
  };

  it("reports missing + null addresses on a fresh install (no config)", async () => {
    const probe = await gatherWalletProbe(configFile, tmp);
    expect(probe).toEqual({
      addresses: { evm: null, solana: null },
      status: { evm: "missing", solana: "missing" },
    });
  });

  it("reports present for a legacy primary entry whose fixed keystore file exists", async () => {
    writeConfig({
      evm: [{ id: "evm_legacy", address: EVM_ADDR, label: "Primary", createdAt: "1970-01-01T00:00:00Z", legacy: true }],
      solana: [{ id: "sol_legacy", address: SOL_ADDR, label: "Primary", createdAt: "1970-01-01T00:00:00Z", legacy: true }],
    });
    writeFileSync(path.join(tmp, "keystore.json"), "{}", "utf8");
    writeFileSync(path.join(tmp, "solana-keystore.json"), "{}", "utf8");
    expect(await gatherWalletProbe(configFile, tmp)).toEqual({
      addresses: { evm: EVM_ADDR, solana: SOL_ADDR },
      status: { evm: "present", solana: "present" },
    });
  });

  it("reports present for a NON-legacy inventory entry backed by a per-id keystore (restore / add-wallet regression)", async () => {
    writeConfig({
      evm: [{ id: EVM_ID, address: EVM_ADDR, label: "Primary", createdAt: "2026-01-01T00:00:00Z" }],
      solana: [],
    });
    // per-id keystore file written by inventory-create / archive restore
    writeFileSync(path.join(tmp, `wallet-${EVM_ID}.json`), "{}", "utf8");
    const probe = await gatherWalletProbe(configFile, tmp);
    expect(probe.addresses.evm).toBe(EVM_ADDR);
    expect(probe.status.evm).toBe("present");
    expect(probe.status.solana).toBe("missing");
  });

  it("reports missing when the inventory has an entry but its keystore file is gone (config/file drift)", async () => {
    writeConfig({
      evm: [{ id: EVM_ID, address: EVM_ADDR, label: "Primary", createdAt: "2026-01-01T00:00:00Z" }],
      solana: [],
    });
    // no wallet-<id>.json on disk
    const probe = await gatherWalletProbe(configFile, tmp);
    // address still surfaced from the inventory, but presence fails closed
    expect(probe.addresses.evm).toBe(EVM_ADDR);
    expect(probe.status.evm).toBe("missing");
  });
});

describe("redactEmbeddingUrl", () => {
  it("returns scheme+host only", () => {
    expect(redactEmbeddingUrl("http://127.0.0.1:12434/engines/llama.cpp/v1")).toBe(
      "http://127.0.0.1:12434"
    );
  });

  it("returns null on null input", () => {
    expect(redactEmbeddingUrl(null)).toBeNull();
  });

  it("returns null on malformed url (avoid leaking raw input)", () => {
    expect(redactEmbeddingUrl("not a url")).toBeNull();
  });

  it("does not include path/query that may carry tokens", () => {
    expect(
      redactEmbeddingUrl("https://embed.example.com/v1/models?api_key=secret")
    ).toBe("https://embed.example.com");
  });
});
