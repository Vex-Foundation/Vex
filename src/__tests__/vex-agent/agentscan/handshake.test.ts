import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { verifyMessage } from "viem";
import nacl from "tweetnacl";
import bs58 from "bs58";

const { testDir, testConfigFile, testKeystoreFile, testSolanaKeystoreFile, testBackupsDir, testEnvFile, testVaultFile } =
  vi.hoisted(() => {
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const _dir = join(tmpdir(), `vex-agentscan-handshake-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    return {
      testDir: _dir,
      testConfigFile: join(_dir, "config.json"),
      testKeystoreFile: join(_dir, "keystore.json"),
      testSolanaKeystoreFile: join(_dir, "solana-keystore.json"),
      testBackupsDir: join(_dir, "backups"),
      testEnvFile: join(_dir, ".env"),
      testVaultFile: join(_dir, "secrets.vault.json"),
    };
  });

const TEST_PASSWORD = "test-password-agentscan-handshake";

vi.mock("@config/paths.js", () => ({
  CONFIG_DIR: testDir,
  CONFIG_FILE: testConfigFile,
  KEYSTORE_FILE: testKeystoreFile,
  SOLANA_KEYSTORE_FILE: testSolanaKeystoreFile,
  BACKUPS_DIR: testBackupsDir,
  ENV_FILE: testEnvFile,
  SECRETS_VAULT_FILE: testVaultFile,
}));

vi.mock("@utils/env.js", () => ({
  requireKeystorePassword: vi.fn(() => TEST_PASSWORD),
  getKeystorePassword: vi.fn(() => TEST_PASSWORD),
}));

vi.mock("@utils/logger-shim.js", () => ({
  minLogger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const envMod = await import("@utils/env.js");
const { createEvmWalletEntry, createSolanaWalletEntry, importSolanaWalletEntry } = await import(
  "@tools/wallet/inventory-create.js"
);
const handshakeSigningMod = await import("@tools/wallet/handshake-signing.js");
const { signAgentscanChallenge } = await import("../../../vex-agent/agentscan/handshake.js");
const { Keypair } = await import("@solana/web3.js");

const CHALLENGE_INPUT = { domain: "agentscan.example", agentHash: "abc123", nonce: "nonce-1" };

describe("signAgentscanChallenge", () => {
  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    vi.mocked(envMod.getKeystorePassword).mockReturnValue(TEST_PASSWORD);
    vi.mocked(envMod.requireKeystorePassword).mockReturnValue(TEST_PASSWORD);
  });

  it("returns no_wallets for an empty inventory", async () => {
    const result = await signAgentscanChallenge(CHALLENGE_INPUT);
    expect(result).toEqual({ kind: "no_wallets" });
  });

  it("signs one proof per wallet, covering every EVM + Solana entry, with a single shared issuedAt", async () => {
    const evm1 = createEvmWalletEntry();
    const evm2 = createEvmWalletEntry();
    const sol1 = createSolanaWalletEntry();

    const result = await signAgentscanChallenge(CHALLENGE_INPUT);
    expect(result.kind).toBe("signed");
    if (result.kind !== "signed") throw new Error("expected signed");

    expect(result.proofs).toHaveLength(3);

    const byAddress = new Map(result.proofs.map((p) => [p.address, p]));
    for (const entry of [evm1, evm2]) {
      const proof = byAddress.get(entry.address);
      if (!proof) throw new Error(`expected a proof for ${entry.address}`);
      expect(proof.chainFamily).toBe("eip155");
      expect(proof.signature.startsWith("0x")).toBe(true);
    }
    const solProof = byAddress.get(sol1.address);
    if (!solProof) throw new Error(`expected a proof for ${sol1.address}`);
    expect(solProof.chainFamily).toBe("solana");
    expect(() => bs58.decode(solProof.signature)).not.toThrow();

    const issuedAtValues = new Set(result.proofs.map((p) => p.issuedAt));
    expect(issuedAtValues.size).toBe(1);
    const [firstProof] = result.proofs;
    if (!firstProof) throw new Error("expected at least one proof");
    expect(Number.isNaN(Date.parse(firstProof.issuedAt))).toBe(false);
  });

  it("every proof is cryptographically valid against the exact binding template", async () => {
    const evm = createEvmWalletEntry();
    const keypair = Keypair.generate();
    const sol = importSolanaWalletEntry(bs58.encode(keypair.secretKey));

    const result = await signAgentscanChallenge(CHALLENGE_INPUT);
    expect(result.kind).toBe("signed");
    if (result.kind !== "signed") throw new Error("expected signed");

    const evmProof = result.proofs.find((p) => p.chainFamily === "eip155");
    const solProof = result.proofs.find((p) => p.chainFamily === "solana");
    if (!evmProof) throw new Error("expected an eip155 proof");
    if (!solProof) throw new Error("expected a solana proof");

    const evmTemplate =
      "AgentScan Handshake v1\n" +
      `Domain: ${CHALLENGE_INPUT.domain}\n` +
      `Agent: ${CHALLENGE_INPUT.agentHash}\n` +
      `Address: ${evm.address.toLowerCase()}\n` +
      "Chain-Family: eip155\n" +
      `Nonce: ${CHALLENGE_INPUT.nonce}\n` +
      `Issued-At: ${evmProof.issuedAt}`;
    const evmValid = await verifyMessage({
      address: evm.address as `0x${string}`,
      message: evmTemplate,
      signature: evmProof.signature as `0x${string}`,
    });
    expect(evmValid).toBe(true);

    const solTemplate =
      "AgentScan Handshake v1\n" +
      `Domain: ${CHALLENGE_INPUT.domain}\n` +
      `Agent: ${CHALLENGE_INPUT.agentHash}\n` +
      `Address: ${sol.address}\n` +
      "Chain-Family: solana\n" +
      `Nonce: ${CHALLENGE_INPUT.nonce}\n` +
      `Issued-At: ${solProof.issuedAt}`;
    const solPayload = Buffer.concat([
      Buffer.from([0xff]),
      Buffer.from("solana offchain", "ascii"),
      Buffer.from(solTemplate, "utf-8"),
    ]);
    const solValid = nacl.sign.detached.verify(
      solPayload,
      bs58.decode(solProof.signature),
      bs58.decode(sol.address),
    );
    expect(solValid).toBe(true);
  });

  it("returns vault_locked with zero decrypt attempts when the keystore password is absent", async () => {
    createEvmWalletEntry();
    createSolanaWalletEntry();

    const evmSpy = vi.spyOn(handshakeSigningMod, "signHandshakeEvm");
    const solSpy = vi.spyOn(handshakeSigningMod, "signHandshakeSolana");
    try {
      vi.mocked(envMod.getKeystorePassword).mockReturnValueOnce(null);
      const result = await signAgentscanChallenge(CHALLENGE_INPUT);
      expect(result).toEqual({ kind: "vault_locked" });
      expect(evmSpy).not.toHaveBeenCalled();
      expect(solSpy).not.toHaveBeenCalled();
    } finally {
      evmSpy.mockRestore();
      solSpy.mockRestore();
    }
  });

  it("maps a mid-loop vault lock (KEYSTORE_PASSWORD_NOT_SET) to vault_locked rather than a raw throw", async () => {
    createEvmWalletEntry();
    createSolanaWalletEntry();

    const { VexError, ErrorCodes } = await import("../../../errors.js");
    const evmSpy = vi
      .spyOn(handshakeSigningMod, "signHandshakeEvm")
      .mockRejectedValue(
        new VexError(ErrorCodes.KEYSTORE_PASSWORD_NOT_SET, "VEX_KEYSTORE_PASSWORD environment variable is required."),
      );
    try {
      const result = await signAgentscanChallenge(CHALLENGE_INPUT);
      expect(result).toEqual({ kind: "vault_locked" });
    } finally {
      evmSpy.mockRestore();
    }
  });

  it("propagates any OTHER signing error typed, rather than swallowing it", async () => {
    createEvmWalletEntry();

    const { VexError, ErrorCodes } = await import("../../../errors.js");
    const evmSpy = vi
      .spyOn(handshakeSigningMod, "signHandshakeEvm")
      .mockRejectedValue(new VexError(ErrorCodes.KEYSTORE_CORRUPT, "keystore corrupt"));
    try {
      await expect(signAgentscanChallenge(CHALLENGE_INPUT)).rejects.toMatchObject({
        code: ErrorCodes.KEYSTORE_CORRUPT,
      });
    } finally {
      evmSpy.mockRestore();
    }
  });
});
