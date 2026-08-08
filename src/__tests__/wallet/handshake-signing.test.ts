import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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

function codeOf(err: unknown): string | undefined {
  return (err as { code?: string } | undefined)?.code;
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
  agentHash: "abc123",
  nonce: "nonce-1",
  issuedAt: "2026-08-08T00:00:00.000Z",
} as const;

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
          "Agent: abc123\n" +
          "Address: 0xabcdef1234567890abcdef1234567890abcdef12\n" +
          "Chain-Family: eip155\n" +
          "Nonce: nonce-1\n" +
          "Issued-At: 2026-08-08T00:00:00.000Z",
      );
      expect(template.endsWith("\n")).toBe(false);
      expect(template.includes("\r")).toBe(false);
    });

    it("Solana: exact byte-for-byte template, address verbatim (case-sensitive base58)", () => {
      const address = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
      const template = buildHandshakeTemplate({
        ...BASE_TEMPLATE_INPUT,
        address,
        chainFamily: "solana",
      });
      expect(template).toBe(
        "AgentScan Handshake v1\n" +
          "Domain: agentscan.example\n" +
          "Agent: abc123\n" +
          `Address: ${address}\n` +
          "Chain-Family: solana\n" +
          "Nonce: nonce-1\n" +
          "Issued-At: 2026-08-08T00:00:00.000Z",
      );
      expect(template.endsWith("\n")).toBe(false);
      expect(template.includes("\r")).toBe(false);
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
});
