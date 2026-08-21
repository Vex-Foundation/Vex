/**
 * Compatibility-façade surface test for `solana-transaction.ts` after the
 * structural split into `./solana-transaction/` modules (connection /
 * deserialize / sign / send / confirm / staged).
 *
 * Pins the EXACT runtime export set of the façade + each export's typeof, so a
 * caller importing from the old path (jupiter earn/prediction/swaps services,
 * solana-account, solana-transfer, internal/wallet/send-execute-solana) sees no
 * difference. Type-only imports of the exported types must also compile against
 * the façade.
 *
 * CODEX extra guard: the cached `Connection` singleton must be single-instanced
 * — `getSolanaConnection()` returns the SAME object until `resetSolanaConnection()`,
 * then a NEW object.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@config/store.js", () => ({
  loadConfig: () => ({
    solana: {
      rpcUrl: "http://localhost:8899",
      commitment: "confirmed",
      explorerUrl: "https://explorer.solana.com",
      cluster: "mainnet-beta",
    },
  }),
}));

import * as txMod from "../../tools/solana-ecosystem/shared/solana-transaction.js";

// Type-only imports of the exported types must compile against the façade.
type _Phase = import("../../tools/solana-ecosystem/shared/solana-transaction.js").StagedSubmissionPhase;
type _Result = import("../../tools/solana-ecosystem/shared/solana-transaction.js").StagedSubmissionResult;
type _Prepared = import("../../tools/solana-ecosystem/shared/solana-transaction.js").PreparedSolanaTx;
type _KnownBlockhash = import("../../tools/solana-ecosystem/shared/solana-transaction.js").KnownSolanaBlockhash;
type _PrepareOptions = import("../../tools/solana-ecosystem/shared/solana-transaction.js").PrepareVersionedTxOptions;
type _SubmitOutcome = import("../../tools/solana-ecosystem/shared/solana-transaction.js").SolanaSubmitOutcome;
type _RpcOptions = import("../../tools/solana-ecosystem/shared/solana-transaction.js").SubmitPreparedTxOverRpcOptions;

describe("solana-transaction façade surface", () => {
  it("exposes exactly the expected runtime exports with correct typeof", () => {
    // The exact set of RUNTIME export keys (the type-only exports are erased at runtime).
    const keys = Object.keys(txMod).sort();
    expect(keys).toEqual([
      "classifyProviderSubmitFailure",
      "confirmStagedSignature",
      "confirmVersionedTx",
      "deserializeVersionedTx",
      "getSolanaConnection",
      // Migration 084 split the legacy staged helper into a SIGN-ONLY half, a
      // SUBMIT half and a CONFIRM-ONLY half, so the wallet-send writer can
      // persist the signature plus its blockhash evidence before any bytes reach
      // the network, and can submit through the classifying RPC lane while still
      // reporting one confirmation vocabulary.
      // `signAndSubmitLegacyTxStaged` stays, composed of those halves.
      "prepareLegacyTx",
      "prepareVersionedTx",
      "resetSolanaConnection",
      "sendSignedVersionedTx",
      "signAndSendLegacyTx",
      "signAndSendVersionedTx",
      "signAndSubmitLegacyTxStaged",
      "signAndSubmitVersionedTxStaged",
      "signVersionedTx",
      "submitPreparedLegacyTxStaged",
      "submitPreparedTxOverRpc",
    ]);

    expect(typeof txMod.deserializeVersionedTx).toBe("function");
    expect(typeof txMod.sendSignedVersionedTx).toBe("function");
    expect(typeof txMod.confirmVersionedTx).toBe("function");
    expect(typeof txMod.signAndSubmitVersionedTxStaged).toBe("function");
    expect(typeof txMod.signAndSendVersionedTx).toBe("function");
    expect(typeof txMod.signVersionedTx).toBe("function");
    expect(typeof txMod.getSolanaConnection).toBe("function");
    expect(typeof txMod.resetSolanaConnection).toBe("function");
    expect(typeof txMod.signAndSendLegacyTx).toBe("function");
    expect(typeof txMod.signAndSubmitLegacyTxStaged).toBe("function");
    expect(typeof txMod.prepareLegacyTx).toBe("function");
    expect(typeof txMod.submitPreparedLegacyTxStaged).toBe("function");
    // The confirm-only half, so a caller submitting through another lane still
    // reports the same confirmation vocabulary.
    expect(typeof txMod.confirmStagedSignature).toBe("function");
    expect(typeof txMod.prepareVersionedTx).toBe("function");
    expect(typeof txMod.submitPreparedTxOverRpc).toBe("function");
    expect(typeof txMod.classifyProviderSubmitFailure).toBe("function");

    // Keep the type-only imports referenced so they are not elided as unused.
    const _typeProbe: ReadonlyArray<
      _Phase | _Result | _Prepared | _KnownBlockhash | _PrepareOptions | _SubmitOutcome | _RpcOptions
    > = [];
    void _typeProbe;
  });

  it("caches the Connection singleton until reset (single-instanced)", () => {
    txMod.resetSolanaConnection();

    const first = txMod.getSolanaConnection();
    const second = txMod.getSolanaConnection();
    // Same cached object across calls until reset.
    expect(second).toBe(first);

    txMod.resetSolanaConnection();
    const third = txMod.getSolanaConnection();
    // A fresh object after reset.
    expect(third).not.toBe(first);
  });
});
