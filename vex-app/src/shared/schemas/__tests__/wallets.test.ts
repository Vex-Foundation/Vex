/**
 * Tests for shared/schemas/wallets.ts — IPC boundary contracts for the
 * 6 wallet channels (M8). Schema drift between renderer / preload /
 * main is caught here.
 */

import { describe, expect, it } from "vitest";
import {
  chainSchema,
  preparedIntentDtoSchema,
  walletGenerateInputSchema,
  walletGenerateEvmResultSchema,
  walletGenerateSolanaResultSchema,
  walletImportEvmInputSchema,
  walletImportSolanaInputSchema,
  walletIntentNetworkSchema,
  walletIntentPreviewSchema,
  walletIntentStatusSchema,
  walletOpenBackupFolderInputSchema,
  walletOpenBackupFolderResultSchema,
  walletRestoreInputSchema,
  walletRestoreResultSchema,
  walletsActionResultSchema,
  walletsCancelPreparedIntentInputSchema,
  walletsGetPreparedIntentInputSchema,
} from "../wallets.js";

describe("chainSchema", () => {
  it("accepts evm and solana", () => {
    expect(chainSchema.safeParse("evm").success).toBe(true);
    expect(chainSchema.safeParse("solana").success).toBe(true);
  });

  it("rejects unknown chains", () => {
    expect(chainSchema.safeParse("bitcoin").success).toBe(false);
    expect(chainSchema.safeParse("EVM").success).toBe(false);
    expect(chainSchema.safeParse("").success).toBe(false);
  });
});

describe("walletGenerate input/result schemas", () => {
  it("generate input rejects extra fields (strict)", () => {
    expect(walletGenerateInputSchema.safeParse({}).success).toBe(true);
    expect(
      walletGenerateInputSchema.safeParse({ chain: "evm" }).success
    ).toBe(false);
  });

  it("EVM result accepts a checksum-cased 0x-prefixed 40-hex address", () => {
    const r = walletGenerateEvmResultSchema.safeParse({
      address: "0xAbCdEf0123456789abcdef0123456789ABCDEF01",
    });
    expect(r.success).toBe(true);
  });

  it("EVM result rejects malformed addresses", () => {
    expect(
      walletGenerateEvmResultSchema.safeParse({ address: "0xshort" }).success
    ).toBe(false);
    expect(
      walletGenerateEvmResultSchema.safeParse({
        address: "1234567890123456789012345678901234567890",
      }).success
    ).toBe(false);
    expect(
      walletGenerateEvmResultSchema.safeParse({
        address: "0xZZZZ567890123456789012345678901234567890",
      }).success
    ).toBe(false);
  });

  it("Solana result accepts a typical base58 address (32 bytes -> ~43-44 chars)", () => {
    expect(
      walletGenerateSolanaResultSchema.safeParse({
        address: "11111111111111111111111111111111",
      }).success
    ).toBe(true);
    expect(
      walletGenerateSolanaResultSchema.safeParse({
        address: "DRpbCBMxVnDK7maPM5tGv6MvCsx1WTokJBKVz5Pk5Hxe",
      }).success
    ).toBe(true);
  });

  it("Solana result rejects non-base58 chars and out-of-range lengths", () => {
    expect(
      walletGenerateSolanaResultSchema.safeParse({
        address: "tooShort",
      }).success
    ).toBe(false);
    expect(
      walletGenerateSolanaResultSchema.safeParse({
        address: "0lI0lI0lI0lI0lI0lI0lI0lI0lI0lI0lI",
      }).success
    ).toBe(false);
  });
});

describe("walletImport input schemas", () => {
  it("EVM import requires a non-empty rawKey, strict against extras", () => {
    expect(
      walletImportEvmInputSchema.safeParse({ rawKey: "0xabc" }).success
    ).toBe(true);
    expect(
      walletImportEvmInputSchema.safeParse({ rawKey: "" }).success
    ).toBe(false);
    expect(
      walletImportEvmInputSchema.safeParse({
        rawKey: "0xabc",
        chain: "evm",
      }).success
    ).toBe(false);
  });

  it("Solana import requires a non-empty rawKey, strict against extras", () => {
    expect(
      walletImportSolanaInputSchema.safeParse({ rawKey: "anything" }).success
    ).toBe(true);
    expect(
      walletImportSolanaInputSchema.safeParse({ rawKey: "" }).success
    ).toBe(false);
  });
});

describe("walletRestore input/result schemas", () => {
  it("input requires only chain (single roundtrip - no path)", () => {
    expect(
      walletRestoreInputSchema.safeParse({ chain: "evm" }).success
    ).toBe(true);
    expect(
      walletRestoreInputSchema.safeParse({}).success
    ).toBe(false);
    expect(
      walletRestoreInputSchema.safeParse({
        chain: "evm",
        sourcePath: "/tmp/keystore.json",
      }).success
    ).toBe(false);
  });

  it("result accepts nullable replacedAddress + backupDir", () => {
    expect(
      walletRestoreResultSchema.safeParse({
        chain: "evm",
        address: "0xabcdef0123456789abcdef0123456789abcdef01",
        replacedAddress: null,
        backupDir: null,
      }).success
    ).toBe(true);
    expect(
      walletRestoreResultSchema.safeParse({
        chain: "solana",
        address: "DRpbCBMxVnDK7maPM5tGv6MvCsx1WTokJBKVz5Pk5Hxe",
        replacedAddress: "DSomethingElseDifferentAddressForTesting1234",
        backupDir: "/home/user/.config/vex/backups/20260510T120000Z",
      }).success
    ).toBe(true);
  });

  it("result rejects missing required fields", () => {
    expect(
      walletRestoreResultSchema.safeParse({
        chain: "evm",
        address: "0xabcdef0123456789abcdef0123456789abcdef01",
      }).success
    ).toBe(false);
  });
});

describe("walletOpenBackupFolder schemas", () => {
  it("input requires a non-empty backupDir", () => {
    expect(
      walletOpenBackupFolderInputSchema.safeParse({
        backupDir: "/some/path",
      }).success
    ).toBe(true);
    expect(
      walletOpenBackupFolderInputSchema.safeParse({ backupDir: "" }).success
    ).toBe(false);
  });

  it("result is a strict {ok:boolean}", () => {
    expect(
      walletOpenBackupFolderResultSchema.safeParse({ ok: true }).success
    ).toBe(true);
    expect(
      walletOpenBackupFolderResultSchema.safeParse({}).success
    ).toBe(false);
    expect(
      walletOpenBackupFolderResultSchema.safeParse({
        ok: true,
        path: "/foo",
      }).success
    ).toBe(false);
  });
});

// ── Wallet intent schemas ────────────────────────────────────────────────

const SESSION_UUID = "00000000-0000-4000-8000-000000000001";
const ISO = "2026-05-24T20:00:00.000Z";

describe("walletIntentNetworkSchema", () => {
  it("accepts eip155 + solana, rejects other", () => {
    expect(walletIntentNetworkSchema.safeParse("eip155").success).toBe(true);
    expect(walletIntentNetworkSchema.safeParse("solana").success).toBe(true);
    expect(walletIntentNetworkSchema.safeParse("bitcoin").success).toBe(false);
  });
});

describe("walletIntentStatusSchema", () => {
  it("accepts all 7 lifecycle values", () => {
    for (const status of [
      "pending",
      "consuming",
      "executed",
      "failed",
      "audit_failed",
      "cancelled",
      "expired",
    ]) {
      expect(walletIntentStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it("rejects unknown status", () => {
    expect(walletIntentStatusSchema.safeParse("unknown").success).toBe(false);
  });
});

describe("walletIntentPreviewSchema", () => {
  it("accepts well-formed preview with allow-listed scalar criticalArgs", () => {
    expect(
      walletIntentPreviewSchema.safeParse({
        label: "Send 1.5 ETH to 0xfed…cba09 on base",
        criticalArgs: {
          network: "eip155",
          chain: "base",
          to: "0xfed",
          amount: "1.5",
          token: null,
        },
      }).success,
    ).toBe(true);
  });

  it("rejects nested object in criticalArgs (allow-list scalars only)", () => {
    expect(
      walletIntentPreviewSchema.safeParse({
        label: "x",
        criticalArgs: { nested: { evil: "blob" } },
      }).success,
    ).toBe(false);
  });

  it("rejects oversized label (>200 chars)", () => {
    expect(
      walletIntentPreviewSchema.safeParse({
        label: "x".repeat(201),
        criticalArgs: {},
      }).success,
    ).toBe(false);
  });
});

describe("preparedIntentDtoSchema", () => {
  function validDto() {
    return {
      intentId: "intent-1",
      sessionId: SESSION_UUID,
      walletAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
      network: "eip155" as const,
      chain: "base",
      to: "0xfedcba0987654321fedcba0987654321fedcba09",
      amount: "1.5",
      token: null,
      status: "pending" as const,
      createdAt: ISO,
      expiresAt: ISO,
      consumedAt: null,
      cancelledAt: null,
      txHash: null,
      preview: { label: "Test", criticalArgs: {} },
    };
  }

  it("accepts a complete DTO", () => {
    expect(preparedIntentDtoSchema.safeParse(validDto()).success).toBe(true);
  });

  it("accepts null preview (mapper drops malformed JSONB)", () => {
    expect(
      preparedIntentDtoSchema.safeParse({ ...validDto(), preview: null }).success,
    ).toBe(true);
  });

  it("accepts txHash set with status='failed' (broadcasted failure)", () => {
    expect(
      preparedIntentDtoSchema.safeParse({
        ...validDto(),
        status: "failed",
        txHash: "0xtx",
      }).success,
    ).toBe(true);
  });

  it("rejects legacy minimal payload without walletAddress/network fields", () => {
    expect(
      preparedIntentDtoSchema.safeParse({
        intentId: "intent-1",
        sessionId: SESSION_UUID,
        expiresAt: ISO,
      }).success,
    ).toBe(false);
  });

  it("REJECTS failureReason field (defense-in-depth - never crosses boundary)", () => {
    expect(
      preparedIntentDtoSchema.safeParse({
        ...validDto(),
        failureReason: "TypeError:abc",
      }).success,
    ).toBe(false);
  });
});

describe("walletsGetPreparedIntentInputSchema", () => {
  it("requires both sessionId + intentId", () => {
    expect(
      walletsGetPreparedIntentInputSchema.safeParse({
        sessionId: SESSION_UUID,
        intentId: "intent-1",
      }).success,
    ).toBe(true);
  });

  it("rejects intent-only input without sessionId", () => {
    expect(
      walletsGetPreparedIntentInputSchema.safeParse({ intentId: "intent-1" })
        .success,
    ).toBe(false);
  });

  it("REJECTS invalid sessionId UUID", () => {
    expect(
      walletsGetPreparedIntentInputSchema.safeParse({
        sessionId: "not-a-uuid",
        intentId: "intent-1",
      }).success,
    ).toBe(false);
  });
});

describe("walletsCancelPreparedIntentInputSchema", () => {
  it("same shape as get input - sessionId required", () => {
    expect(
      walletsCancelPreparedIntentInputSchema.safeParse({
        sessionId: SESSION_UUID,
        intentId: "intent-1",
      }).success,
    ).toBe(true);
    expect(
      walletsCancelPreparedIntentInputSchema.safeParse({ intentId: "intent-1" })
        .success,
    ).toBe(false);
  });
});

describe("walletsActionResultSchema", () => {
  it("accepts 'cancelled' status", () => {
    expect(
      walletsActionResultSchema.safeParse({
        intentId: "intent-1",
        status: "cancelled",
        message: "Intent cancelled.",
      }).success,
    ).toBe(true);
  });

  it("accepts 'already_terminal' (cross-session cancel + race miss)", () => {
    expect(
      walletsActionResultSchema.safeParse({
        intentId: "intent-1",
        status: "already_terminal",
        message: "No pending intent for this session.",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown status", () => {
    expect(
      walletsActionResultSchema.safeParse({
        intentId: "intent-1",
        status: "blasted",
        message: "x",
      }).success,
    ).toBe(false);
  });
});
