/**
 * Façade surface guard for `internal/wallet/send.ts`.
 *
 * After the structural split into `./send/{validation,prepare,confirm,
 * finalize,results}.ts`, the original module stays a compatibility façade.
 * This test pins the EXACT runtime export-key set + each runtime export's
 * `typeof`, so callers (db/repos/wallet-intents.ts, engine/types.ts,
 * tools/dispatcher/internal-loaders.ts, tools/internal/wallet.ts) see no
 * difference in the public surface.
 *
 * The executor + resolve boundaries are mocked exactly as in send.test.ts so
 * the façade's transitive import graph stays light (avoids @solana/web3.js and
 * the DB) — this is a surface assertion, not a behavioural test.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../../../../vex-agent/tools/internal/wallet/send-execute-solana.js", () => ({
  executeSolanaTransfer: vi.fn(),
}));

vi.mock("../../../../../vex-agent/tools/internal/wallet/send-execute-evm.js", () => ({
  executeEvmTransfer: vi.fn(),
}));

vi.mock("../../../../../vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(),
  resolveSigningWallet: vi.fn(),
  walletScopeErrorToResult: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/wallet-intents.js", () => ({
  createWith: vi.fn(),
  getById: vi.fn(),
  consumeIfPendingWith: vi.fn(),
  markExecutedWith: vi.fn(),
  markFailedWith: vi.fn(),
  markAuditFailedWith: vi.fn(),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const send = await import(
  "../../../../../vex-agent/tools/internal/wallet/send.js"
);

describe("internal/wallet/send façade surface", () => {
  it("exposes exactly the expected runtime export keys", () => {
    expect(Object.keys(send).sort()).toEqual(
      ["handleWalletSendPrepare", "handleWalletSendConfirm"].sort(),
    );
  });

  it("each runtime export has the expected typeof", () => {
    expect(typeof send.handleWalletSendPrepare).toBe("function");
    expect(typeof send.handleWalletSendConfirm).toBe("function");
  });
});
