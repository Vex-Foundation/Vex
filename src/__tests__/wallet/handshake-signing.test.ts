import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { verifyMessage } from "viem";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair, Message, Transaction, VersionedMessage } from "@solana/web3.js";

const { testDir, testConfigFile, testKeystoreFile, testSolanaKeystoreFile, testBackupsDir, testEnvFile, testVaultFile } =
  vi.hoisted(() => {
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const _dir = join(tmpdir(), `vex-handshake-signing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

const TEST_PASSWORD = "test-password-handshake-signing";

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

const { ErrorCodes } = await import("../../errors.js");
const { importEvmWalletEntry, importSolanaWalletEntry } = await import("@tools/wallet/inventory-create.js");
const { buildHandshakeTemplate, signHandshakeEvm, signHandshakeSolana } = await import(
  "@tools/wallet/handshake-signing.js"
);

const KEY_A = "0x" + "ab".repeat(32);
const KEY_B_ADDRESS = "0x89AEF553A06ab0C3173e79DE1Ce241A9ed3b992C";

/** Real wire-contract shapes (task-9): 64 lowercase hex agentHash, 43-char base64url nonce over 32 CSPRNG bytes. */
const VALID_AGENT_HASH = randomBytes(32).toString("hex");
const VALID_NONCE = randomBytes(32).toString("base64url");
const VALID_EVM_ADDRESS = "0xABCDEF1234567890ABCDEF1234567890ABCDEF12";
const VALID_SOLANA_ADDRESS = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

function codeOf(err: unknown): string | undefined {
  return (err as { code?: string } | undefined)?.code;
}

function codeOfSync(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return codeOf(err);
  }
  return undefined;
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    return codeOf(err);
  }
  return undefined;
}

const BASE_TEMPLATE_INPUT = {
  domain: "agentscan.example",
  agentHash: VALID_AGENT_HASH,
  nonce: VALID_NONCE,
  issuedAt: "2026-08-08T00:00:00.000Z",
} as const;

function evmInput(overrides: Partial<Record<string, unknown>> = {}) {
  return { ...BASE_TEMPLATE_INPUT, address: VALID_EVM_ADDRESS, chainFamily: "eip155" as const, ...overrides };
}

describe("handshake-signing", () => {
  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("buildHandshakeTemplate — goldens (AC1)", () => {
    it("EVM: exact byte-for-byte template, address lowercased, LF newlines, no trailing newline", () => {
      const template = buildHandshakeTemplate({
        ...BASE_TEMPLATE_INPUT,
        address: "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
        chainFamily: "eip155",
      });
      expect(template).toBe(
        "AgentScan Handshake v1\n" +
          "Domain: agentscan.example\n" +
          `Agent: ${VALID_AGENT_HASH}\n` +
          "Address: 0xabcdef1234567890abcdef1234567890abcdef12\n" +
          "Chain-Family: eip155\n" +
          `Nonce: ${VALID_NONCE}\n` +
          "Issued-At: 2026-08-08T00:00:00.000Z",
      );
      expect(template.endsWith("\n")).toBe(false);
      expect(template.includes("\r")).toBe(false);
    });

    it("Solana: exact byte-for-byte template, address verbatim (case-sensitive base58)", () => {
      const template = buildHandshakeTemplate({
        ...BASE_TEMPLATE_INPUT,
        address: VALID_SOLANA_ADDRESS,
        chainFamily: "solana",
      });
      expect(template).toBe(
        "AgentScan Handshake v1\n" +
          "Domain: agentscan.example\n" +
          `Agent: ${VALID_AGENT_HASH}\n` +
          `Address: ${VALID_SOLANA_ADDRESS}\n` +
          "Chain-Family: solana\n" +
          `Nonce: ${VALID_NONCE}\n` +
          "Issued-At: 2026-08-08T00:00:00.000Z",
      );
      expect(template.endsWith("\n")).toBe(false);
      expect(template.includes("\r")).toBe(false);
    });
  });

  describe("buildHandshakeTemplate — field validation (hostile-server injection guard)", () => {
    it("rejects a newline-bearing nonce — the hostile-server injection scenario — with a typed throw", () => {
      // A rogue (or compromised) agentscanApiUrl answers session/start with a
      // nonce that embeds an extra "line": if interpolated raw, this would
      // smuggle an attacker-chosen line into what the trading key signs.
      const hostileNonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nAnything: attacker text";
      const code = codeOfSync(() => buildHandshakeTemplate(evmInput({ nonce: hostileNonce })));
      expect(code).toBe(ErrorCodes.AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED);
    });

    it("rejects a nonce that isn't exactly 43 base64url characters", () => {
      const badNonces = ["too-short", "n".repeat(44), "n".repeat(42), `${VALID_NONCE.slice(0, 42)}+`, ""];
      for (const bad of badNonces) {
        expect(
          codeOfSync(() => buildHandshakeTemplate(evmInput({ nonce: bad }))),
          `nonce ${JSON.stringify(bad)} should be rejected`,
        ).toBe(ErrorCodes.AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED);
      }
    });

    it("rejects an agentHash that isn't exactly 64 lowercase hex characters", () => {
      const badHashes = ["abc123", VALID_AGENT_HASH.toUpperCase(), VALID_AGENT_HASH.slice(0, 63), `${VALID_AGENT_HASH}0`, "not-hex".repeat(9)];
      for (const bad of badHashes) {
        expect(
          codeOfSync(() => buildHandshakeTemplate(evmInput({ agentHash: bad }))),
          `agentHash ${JSON.stringify(bad)} should be rejected`,
        ).toBe(ErrorCodes.AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED);
      }
    });

    it("rejects domain / address / issuedAt carrying an embedded CR or LF", () => {
      expect(codeOfSync(() => buildHandshakeTemplate(evmInput({ domain: "agentscan.example\nInjected: x" })))).toBe(
        ErrorCodes.AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED,
      );
      expect(codeOfSync(() => buildHandshakeTemplate(evmInput({ domain: "agentscan.example\rInjected: x" })))).toBe(
        ErrorCodes.AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED,
      );
      expect(codeOfSync(() => buildHandshakeTemplate(evmInput({ address: `${VALID_EVM_ADDRESS}\nInjected: x` })))).toBe(
        ErrorCodes.AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED,
      );
      expect(
        codeOfSync(() => buildHandshakeTemplate(evmInput({ issuedAt: "2026-08-08T00:00:00.000Z\nInjected: x" }))),
      ).toBe(ErrorCodes.AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED);
    });

    it("still builds (and does not throw) with a real 43-char base64url nonce — positive control", () => {
      expect(() => buildHandshakeTemplate(evmInput())).not.toThrow();
    });
  });

  describe("signHandshakeEvm — round trip (AC1)", () => {
    it("produces a personal_sign signature that verifies with viem verifyMessage", async () => {
      const entry = importEvmWalletEntry(KEY_A);
      const template = buildHandshakeTemplate({
        ...BASE_TEMPLATE_INPUT,
        address: entry.address,
        chainFamily: "eip155",
      });

      const signature = await signHandshakeEvm(entry, template);
      expect(signature.startsWith("0x")).toBe(true);

      const valid = await verifyMessage({
        address: entry.address as `0x${string}`,
        message: template,
        signature,
      });
      expect(valid).toBe(true);

      const tampered = await verifyMessage({
        address: entry.address as `0x${string}`,
        message: `${template}\nExtra: tampered`,
        signature,
      });
      expect(tampered).toBe(false);
    });

    it("still signs successfully with a valid 43-char base64url nonce end-to-end", async () => {
      const entry = importEvmWalletEntry(KEY_A);
      const template = buildHandshakeTemplate({ ...BASE_TEMPLATE_INPUT, address: entry.address, chainFamily: "eip155" });
      await expect(signHandshakeEvm(entry, template)).resolves.toEqual(expect.stringMatching(/^0x/));
    });
  });

  describe("signHandshakeSolana — round trip + prefix proof (AC1, AC5)", () => {
    async function importFreshSolanaWallet() {
      const keypair = Keypair.generate();
      return importSolanaWalletEntry(bs58.encode(keypair.secretKey));
    }

    it("produces a base58 ed25519 signature that verifies against the 0xFF-prefixed payload but NOT the bare template", async () => {
      const entry = await importFreshSolanaWallet();
      const template = buildHandshakeTemplate({
        ...BASE_TEMPLATE_INPUT,
        address: entry.address,
        chainFamily: "solana",
      });

      const signature = await signHandshakeSolana(entry, template);
      const signatureBytes = bs58.decode(signature);
      const pubkeyBytes = bs58.decode(entry.address);

      const prefixedPayload = Buffer.concat([
        Buffer.from([0xff]),
        Buffer.from("solana offchain", "ascii"),
        Buffer.from(template, "utf-8"),
      ]);
      expect(nacl.sign.detached.verify(prefixedPayload, signatureBytes, pubkeyBytes)).toBe(true);

      const barePayload = Buffer.from(template, "utf-8");
      expect(nacl.sign.detached.verify(barePayload, signatureBytes, pubkeyBytes)).toBe(false);
    });

    it("the signed payload cannot be parsed as a Solana transaction message (structurally unspendable) — AC5", async () => {
      const entry = await importFreshSolanaWallet();
      const template = buildHandshakeTemplate({
        ...BASE_TEMPLATE_INPUT,
        address: entry.address,
        chainFamily: "solana",
      });

      const payload = Buffer.concat([
        Buffer.from([0xff]),
        Buffer.from("solana offchain", "ascii"),
        Buffer.from(template, "utf-8"),
      ]);

      // The 0xFF signing-domain byte has its high bit set, which the SDK
      // treats as "this is a versioned message" (legacy messages start with
      // a plain u8 numRequiredSignatures whose high bit conventionally stays
      // clear); version 127 is not a version Solana has ever defined, so
      // every parse path this SDK exposes refuses the bytes.
      expect(payload[0]).toBe(0xff);
      expect(() => VersionedMessage.deserialize(payload)).toThrow();
      expect(() => Message.from(payload)).toThrow();
      expect(() => Transaction.from(payload)).toThrow();
    });
  });

  describe("refusal matrix (AC2)", () => {
    const BAD_TEMPLATES = [
      "",
      "random unrelated message",
      "AgentScan Handshake v1", // correct text, missing the mandatory newline
      "agentscan handshake v1\nDomain: x", // wrong case
      " AgentScan Handshake v1\nDomain: x", // leading whitespace
    ];

    it.each(BAD_TEMPLATES)("signHandshakeEvm refuses %j BEFORE touching the keystore", async (bad) => {
      // No keystore was ever written for this id — if the refusal fires
      // before decrypt, the error is the template code, never KEYSTORE_NOT_FOUND.
      const phantomEntry = {
        id: "evm_00000000-0000-0000-0000-000000000000",
        address: "0x0000000000000000000000000000000000dEaD",
        label: "phantom",
        createdAt: new Date(0).toISOString(),
      };
      const code = await codeOfAsync(() => signHandshakeEvm(phantomEntry, bad));
      expect(code).toBe(ErrorCodes.AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED);
    });

    it.each(BAD_TEMPLATES)("signHandshakeSolana refuses %j BEFORE touching the keystore", async (bad) => {
      const phantomEntry = {
        id: "sol_00000000-0000-0000-0000-000000000000",
        address: "11111111111111111111111111111111111111111",
        label: "phantom",
        createdAt: new Date(0).toISOString(),
      };
      const code = await codeOfAsync(() => signHandshakeSolana(phantomEntry, bad));
      expect(code).toBe(ErrorCodes.AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED);
    });

    it("signHandshakeEvm fails closed (SIGNER_MISMATCH) when the entry's address does not match the decrypted key", async () => {
      const entry = importEvmWalletEntry(KEY_A);
      const mismatched = { ...entry, address: KEY_B_ADDRESS };
      const template = buildHandshakeTemplate({
        ...BASE_TEMPLATE_INPUT,
        address: mismatched.address,
        chainFamily: "eip155",
      });
      const code = await codeOfAsync(() => signHandshakeEvm(mismatched, template));
      expect(code).toBe(ErrorCodes.SIGNER_MISMATCH);
    });

    it("signHandshakeSolana fails closed (SIGNER_MISMATCH) when the entry's address does not match the decrypted key", async () => {
      const keypair = Keypair.generate();
      const entry = importSolanaWalletEntry(bs58.encode(keypair.secretKey));
      const otherKeypair = Keypair.generate();
      const mismatched = { ...entry, address: otherKeypair.publicKey.toBase58() };
      const template = buildHandshakeTemplate({
        ...BASE_TEMPLATE_INPUT,
        address: mismatched.address,
        chainFamily: "solana",
      });
      const code = await codeOfAsync(() => signHandshakeSolana(mismatched, template));
      expect(code).toBe(ErrorCodes.SIGNER_MISMATCH);
    });
  });

  describe("signer-level structural defense (Layer B) — a hand-crafted, bypass-built template is rejected too", () => {
    // Simulates what a template would look like if a hostile nonce's
    // embedded line survived past buildHandshakeTemplate's field validation
    // (Layer A) — assembled by hand here, bypassing the builder entirely, to
    // prove the SIGNERS' own full-shape check (Layer B) independently
    // refuses it. Both fields around the injected line are otherwise
    // well-formed, so the ONLY reason for the throw is the extra line.
    function injectedTemplate(address: string): string {
      return [
        "AgentScan Handshake v1",
        "Domain: agentscan.example",
        `Agent: ${VALID_AGENT_HASH}`,
        `Address: ${address}`,
        "Chain-Family: eip155",
        `Nonce: ${VALID_NONCE.slice(0, 3)}`,
        "Anything: attacker text",
        "Issued-At: 2026-08-08T00:00:00.000Z",
      ].join("\n");
    }

    it("signHandshakeEvm rejects the hand-crafted injected template BEFORE touching the keystore", async () => {
      const phantomEntry = {
        id: "evm_00000000-0000-0000-0000-000000000003",
        address: VALID_EVM_ADDRESS,
        label: "phantom",
        createdAt: new Date(0).toISOString(),
      };
      const code = await codeOfAsync(() => signHandshakeEvm(phantomEntry, injectedTemplate(VALID_EVM_ADDRESS.toLowerCase())));
      expect(code).toBe(ErrorCodes.AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED);
    });

    it("signHandshakeSolana rejects the hand-crafted injected template BEFORE touching the keystore", async () => {
      const phantomEntry = {
        id: "sol_00000000-0000-0000-0000-000000000003",
        address: VALID_SOLANA_ADDRESS,
        label: "phantom",
        createdAt: new Date(0).toISOString(),
      };
      const code = await codeOfAsync(() =>
        signHandshakeSolana(phantomEntry, injectedTemplate(VALID_SOLANA_ADDRESS).replace("Chain-Family: eip155", "Chain-Family: solana")),
      );
      expect(code).toBe(ErrorCodes.AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED);
    });
  });
});
