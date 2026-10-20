/**
 * Vex Cloud EIP-4361 template signer.
 *
 * WHAT IS PINNED:
 *  - BYTE EQUALITY with viem `createSiweMessage` for exactly the parameters
 *    the backend's own test support signs with
 *    (`VexVirtualsCompute/test/support/siwe.ts`: no scheme, the fixed
 *    statement, version 1, chain 4663, `intentResources`), for all three
 *    intents. The backend re-serialises every message with that function and
 *    refuses anything not byte-identical, so a drift here is a sign-in that
 *    can never succeed;
 *  - a frozen golden, so a viem upgrade that changed the layout fails here
 *    first (checksummed address, ISO dates with milliseconds, resource list);
 *  - the hostile-server matrix: CR or LF (or any off-charset) in the nonce,
 *    domain or uri is refused before a message exists; a hand-built message
 *    with an extra line, a request id, a scheme, another statement, another
 *    chain, unsorted links or a lowercase address is refused by the signer
 *    BEFORE the keystore is touched;
 *  - a real round trip: the signature recovers to the wallet, and the signer
 *    refuses to sign a message that names another address.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { getAddress, verifyMessage } from "viem";
import { createSiweMessage } from "viem/siwe";

const { testDir, testConfigFile, testKeystoreFile, testSolanaKeystoreFile, testBackupsDir, testEnvFile, testVaultFile } =
  vi.hoisted(() => {
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const _dir = join(tmpdir(), `vex-siwe-signing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

const TEST_PASSWORD = "test-password-siwe-signing";

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
const { importEvmWalletEntry } = await import("@tools/wallet/inventory-create.js");
const {
  assertVexCloudSiweMessage,
  buildVexCloudSiweMessage,
  signVexCloudSiweMessage,
  vexCloudSiweResources,
  VEX_CLOUD_SIWE_STATEMENT,
} = await import("@tools/wallet/siwe-signing.js");

/** Throwaway key generated for this suite; it never holds anything. */
const KEY_A = `0x${"7c".repeat(32)}` as const;
const OTHER = "0x89AEF553A06ab0C3173e79DE1Ce241A9ed3b992C";
const LINK_A = "0x1111111111111111111111111111111111111111";
const LINK_B = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const ACCOUNT = "3f0d2f7a-1c2b-4b3c-8d4e-5f6a7b8c9d0e";
const NONCE = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const ISSUED = new Date("2026-10-20T12:00:00.000Z");
const EXPIRES = new Date("2026-10-20T12:05:00.000Z");

/** The backend's `TEST_SIWE` binding (local profile). */
const BINDING = { domain: "localhost", uri: "http://localhost:8787" } as const;

function input(overrides: Partial<Parameters<typeof buildVexCloudSiweMessage>[0]> = {}) {
  return {
    ...BINDING,
    address: "0xabcdef1234567890abcdef1234567890abcdef12",
    nonce: NONCE,
    issuedAt: ISSUED,
    expirationTime: EXPIRES,
    intent: { kind: "signin" as const },
    linkSet: [] as string[],
    ...overrides,
  };
}

/** What the backend's test support produces for the same fields. */
function backendMessage(address: string, intentResources: string[]): string {
  return createSiweMessage({
    address: getAddress(address),
    chainId: 4663,
    domain: BINDING.domain,
    uri: BINDING.uri,
    version: "1",
    nonce: NONCE,
    statement: "Sign in to Vex Cloud with this wallet.",
    issuedAt: ISSUED,
    expirationTime: EXPIRES,
    resources: intentResources,
  });
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

describe("siwe-signing", () => {
  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("byte equality with the backend's message for every intent", () => {
    it("signin: no link resources", () => {
      const address = input().address;
      expect(buildVexCloudSiweMessage(input())).toBe(backendMessage(address, ["urn:vex:intent:signin"]));
    });

    it("create: the link set lowercased, deduplicated and sorted", () => {
      const message = buildVexCloudSiweMessage(
        input({ intent: { kind: "create" }, linkSet: [LINK_B, LINK_A, LINK_A.toUpperCase().replace("0X", "0x")] }),
      );
      expect(message).toBe(
        backendMessage(input().address, [
          "urn:vex:intent:create",
          `urn:vex:link:${LINK_A.toLowerCase()}`,
          `urn:vex:link:${LINK_B.toLowerCase()}`,
        ]),
      );
    });

    it("link: names the account and the new wallets", () => {
      const message = buildVexCloudSiweMessage(input({ intent: { kind: "link", accountId: ACCOUNT }, linkSet: [LINK_A] }));
      expect(message).toBe(
        backendMessage(input().address, [`urn:vex:intent:link:${ACCOUNT}`, `urn:vex:link:${LINK_A}`]),
      );
    });

    it("matches a frozen golden: checksummed address, millisecond ISO dates, LF only", () => {
      const message = buildVexCloudSiweMessage(input({ intent: { kind: "create" }, linkSet: [LINK_A] }));
      expect(message).toBe(
        [
          "localhost wants you to sign in with your Ethereum account:",
          "0xabCDEF1234567890ABcDEF1234567890aBCDeF12",
          "",
          "Sign in to Vex Cloud with this wallet.",
          "",
          "URI: http://localhost:8787",
          "Version: 1",
          "Chain ID: 4663",
          `Nonce: ${NONCE}`,
          "Issued At: 2026-10-20T12:00:00.000Z",
          "Expiration Time: 2026-10-20T12:05:00.000Z",
          "Resources:",
          "- urn:vex:intent:create",
          `- urn:vex:link:${LINK_A}`,
        ].join("\n"),
      );
      expect(message.includes("\r")).toBe(false);
      expect(VEX_CLOUD_SIWE_STATEMENT).toBe("Sign in to Vex Cloud with this wallet.");
    });

    it("builds the backend's canonical resources", () => {
      expect(vexCloudSiweResources({ kind: "create" }, [LINK_B, LINK_A])).toEqual([
        "urn:vex:intent:create",
        `urn:vex:link:${LINK_A}`,
        `urn:vex:link:${LINK_B.toLowerCase()}`,
      ]);
    });
  });

  describe("hostile-server fields are refused before any message exists", () => {
    it.each([
      ["a nonce carrying a line break", { nonce: `${NONCE}\nURI: https://evil.example` }],
      ["a nonce carrying a carriage return", { nonce: `${NONCE}\rx` }],
      ["a nonce shorter than 8", { nonce: "abc123" }],
      ["a nonce with punctuation", { nonce: "abcd-efgh-1234" }],
      ["a domain carrying a line break", { domain: "localhost\nURI: https://evil.example" }],
      ["a domain with a space", { domain: "local host" }],
      ["a uri carrying a line break", { uri: "http://localhost:8787\nVersion: 1" }],
      ["a uri with a path", { uri: "http://localhost:8787/steal" }],
      ["a uri for another host than the domain", { uri: "https://evil.example" }],
      ["a malformed address", { address: "0x1234" }],
      ["a validity window over one hour", { expirationTime: new Date(ISSUED.getTime() + 3_600_001) }],
      ["an expiry before issue", { expirationTime: new Date(ISSUED.getTime() - 1) }],
      ["sign-in carrying a link set", { linkSet: [LINK_A] }],
      ["create without a link set", { intent: { kind: "create" as const } }],
      ["link to a non-uuid account", { intent: { kind: "link" as const, accountId: "acct-1" }, linkSet: [LINK_A] }],
    ])("refuses %s", (_name, overrides) => {
      expect(codeOf(() => buildVexCloudSiweMessage(input(overrides)))).toBe(ErrorCodes.VEX_CLOUD_SIWE_TEMPLATE_REJECTED);
    });
  });

  describe("the signer refuses any message that is not the exact shape, before the keystore", () => {
    const good = (): string => buildVexCloudSiweMessage(input({ address: OTHER }));
    const phantomEntry = {
      id: "evm_00000000-0000-0000-0000-000000000000",
      address: OTHER,
      label: "phantom",
      createdAt: new Date(0).toISOString(),
    };

    const MUTATIONS: ReadonlyArray<readonly [string, (message: string) => string]> = [
      ["an extra trailing line", (m) => `${m}\nRequest ID: 1`],
      ["an injected line after the nonce", (m) => m.replace(`Nonce: ${NONCE}`, `Nonce: ${NONCE}\nNot Before: 2026-10-20T12:00:00.000Z`)],
      ["a scheme on the origin line", (m) => `http://${m}`],
      ["another statement", (m) => m.replace(VEX_CLOUD_SIWE_STATEMENT, "Approve everything.")],
      ["another chain", (m) => m.replace("Chain ID: 4663", "Chain ID: 1")],
      ["another version", (m) => m.replace("Version: 1", "Version: 2")],
      ["a lowercase address", (m) => m.replace(OTHER, OTHER.toLowerCase())],
      ["a non-vex resource", (m) => m.replace("urn:vex:intent:signin", "https://evil.example")],
      ["a CRLF line ending", (m) => m.replace("\nURI:", "\r\nURI:")],
      ["no expiration", (m) => m.replace(/\nExpiration Time: [^\n]+/, "")],
    ];

    it.each(MUTATIONS)("refuses %s", async (_name, mutate) => {
      const bad = mutate(good());
      expect(codeOf(() => assertVexCloudSiweMessage(bad))).toBe(ErrorCodes.VEX_CLOUD_SIWE_TEMPLATE_REJECTED);
      // No keystore exists for the phantom: a refusal after decrypt would be KEYSTORE_NOT_FOUND.
      expect(await codeOfAsync(() => signVexCloudSiweMessage(phantomEntry, bad))).toBe(
        ErrorCodes.VEX_CLOUD_SIWE_TEMPLATE_REJECTED,
      );
    });

    it("refuses unsorted link resources", () => {
      const sorted = buildVexCloudSiweMessage(input({ intent: { kind: "create" }, linkSet: [LINK_A, LINK_B] }));
      const unsorted = sorted.replace(
        `- urn:vex:link:${LINK_A}\n- urn:vex:link:${LINK_B.toLowerCase()}`,
        `- urn:vex:link:${LINK_B.toLowerCase()}\n- urn:vex:link:${LINK_A}`,
      );
      expect(unsorted).not.toBe(sorted);
      expect(codeOf(() => assertVexCloudSiweMessage(unsorted))).toBe(ErrorCodes.VEX_CLOUD_SIWE_TEMPLATE_REJECTED);
    });
  });

  describe("round trip", () => {
    it("signs with the wallet's own key: the signature recovers to it, a tampered message does not", async () => {
      const entry = await importEvmWalletEntry(KEY_A);
      const message = buildVexCloudSiweMessage(input({ address: entry.address }));

      const signature = await signVexCloudSiweMessage(entry, message);

      await expect(verifyMessage({ address: getAddress(entry.address), message, signature })).resolves.toBe(true);
      await expect(
        verifyMessage({ address: getAddress(entry.address), message: `${message}\n- urn:vex:link:${LINK_A}`, signature }),
      ).resolves.toBe(false);
    });

    it("refuses to sign a message that names another wallet, before the keystore", async () => {
      const entry = await importEvmWalletEntry(KEY_A);
      const foreign = buildVexCloudSiweMessage(input({ address: OTHER }));
      expect(await codeOfAsync(() => signVexCloudSiweMessage(entry, foreign))).toBe(
        ErrorCodes.VEX_CLOUD_SIWE_TEMPLATE_REJECTED,
      );
    });
  });
});
