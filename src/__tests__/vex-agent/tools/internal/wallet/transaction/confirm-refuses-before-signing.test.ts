/**
 * THE CONFIRM HANDLERS REFUSE BEFORE THEY CLAIM, AND BEFORE THEY SIGN.
 *
 * The property under test is a negative one, and it is the one that matters on
 * this path: for every refusal reachable before the sign boundary, the intent
 * must NOT be claimed, no key may be resolved, and no chain client may be
 * built. A refusal that has already consumed the intent leaves a `consuming`
 * row nobody may execute; one that has already decrypted a key has widened the
 * blast radius of a bug for no benefit.
 *
 * So the claim, the signer resolution and the client factory are all observed,
 * and every case asserts the call count is zero.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { WalletTransactionIntent } from "@vex-agent/db/repos/wallet-transaction-intents.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";

const getById = vi.fn();
vi.mock("@vex-agent/db/repos/wallet-transaction-intents.js", () => ({ getById }));

const claimTransactionIntent = vi.fn();
vi.mock("@vex-agent/tools/internal/wallet/transaction/activity-writer.js", () => ({
  claimTransactionIntent,
}));

const resolveSigningWallet = vi.fn();
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSigningWallet,
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : "wallet scope error",
  }),
}));

const getByIdForSession = vi.fn();
vi.mock("@vex-agent/db/repos/approvals.js", () => ({ getByIdForSession }));

const { handleWalletEvmTransactionConfirm } = await import(
  "@vex-agent/tools/internal/wallet/transaction/confirm-evm.js"
);
const { handleWalletSolanaTransactionConfirm } = await import(
  "@vex-agent/tools/internal/wallet/transaction/confirm-solana.js"
);
const { digestOfIntent } = await import(
  "@vex-agent/tools/internal/wallet/transaction/revalidate.js"
);
const { canonicalTransactionPreview } = await import(
  "@vex-agent/tools/internal/wallet/transaction/preview.js"
);

const WALLET = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";

const chainFactory = vi.fn();
const signerClientsFactory = vi.fn();
const solanaChainFactory = vi.fn();
const signing = {
  sign: vi.fn(),
  submit: vi.fn(),
  confirm: vi.fn(),
};

function context(overrides: Partial<InternalToolContext> = {}): InternalToolContext {
  return {
    sessionId: "session-1",
    sessionPermission: "full",
    approved: false,
    ...overrides,
  } as InternalToolContext;
}

function intent(overrides: Partial<WalletTransactionIntent> = {}): WalletTransactionIntent {
  const base: WalletTransactionIntent = {
    intentId: "wtx-1",
    sessionId: "session-1",
    walletAddress: WALLET,
    family: "eip155",
    chainAlias: "base",
    chainId: 8453,
    payload: { family: "eip155", evm: { to: TO, data: "0x", valueWei: "1000" } },
    decoded: {
      family: "eip155",
      role: "native_transfer",
      standard: "native",
      functionName: "nativeTransfer",
      contract: null,
      criticalArgs: { recipient: TO, valueWei: "1000" },
      unlimitedApproval: false,
      warnings: [],
    },
    // Placeholder; replaced below by the CANONICAL card unless a case
    // deliberately supplies its own (V2 binds the card into the digest and
    // refuses a row whose stored card is not the one its fields render).
    preview: { label: "placeholder", criticalArgs: {} },
    feeBounds: {
      mode: "eip1559",
      gasLimit: "21000",
      maxFeePerGasWei: "1000000000",
      maxPriorityFeePerGasWei: "1000000",
      maxTotalFeeWei: "21000000000000",
    },
    proposalDigest: "",
    proposalDigestVersion: PROPOSAL_DIGEST_VERSION,
    recentBlockhash: null,
    lastValidBlockHeight: null,
    status: "pending",
    failureStage: null,
    activityId: null,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    consumedAt: null,
    cancelledAt: null,
    txHash: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  const carded: WalletTransactionIntent =
    overrides.preview === undefined
      ? {
          ...base,
          preview: canonicalTransactionPreview({
            family: base.family,
            chainAlias: base.chainAlias,
            decoded: base.decoded,
            feeBounds: base.feeBounds,
            evmValueWei:
              base.payload.family === "eip155" ? base.payload.evm.valueWei : null,
          }),
        }
      : base;
  return { ...carded, proposalDigest: carded.proposalDigest || digestOfIntent(carded) };
}

function expectNothingHappened(): void {
  expect(claimTransactionIntent).not.toHaveBeenCalled();
  expect(resolveSigningWallet).not.toHaveBeenCalled();
  expect(signerClientsFactory).not.toHaveBeenCalled();
  expect(signing.sign).not.toHaveBeenCalled();
  expect(signing.submit).not.toHaveBeenCalled();
}

const evmDeps = { chainFactory, signerClientsFactory };
const solanaDeps = { chainFactory: solanaChainFactory, signing };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("no broadcast without an intent that is actually approvable", () => {
  it("refuses an unknown intent id without touching anything", async () => {
    getById.mockResolvedValue(null);
    const result = await handleWalletEvmTransactionConfirm(
      { intentId: "wtx-missing" },
      context(),
      evmDeps,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("no prepared transaction intent");
    expectNothingHappened();
  });

  it("refuses an intent that is no longer pending - a second confirm cannot double-spend", async () => {
    getById.mockResolvedValue(intent({ status: "consuming" }));
    const result = await handleWalletEvmTransactionConfirm({ intentId: "wtx-1" }, context(), evmDeps);
    expect(result.success).toBe(false);
    expect(result.output).toContain("only a pending intent");
    expectNothingHappened();
  });

  it("refuses an expired intent", async () => {
    getById.mockResolvedValue(intent({ expiresAt: new Date(Date.now() - 1).toISOString() }));
    const result = await handleWalletEvmTransactionConfirm({ intentId: "wtx-1" }, context(), evmDeps);
    expect(result.success).toBe(false);
    expect(result.output).toContain("expired");
    expectNothingHappened();
  });

  it("refuses a row whose digest no longer describes its own fields", async () => {
    const tampered = intent();
    getById.mockResolvedValue({ ...tampered, proposalDigest: "digest-from-before-the-edit" });
    const result = await handleWalletEvmTransactionConfirm({ intentId: "wtx-1" }, context(), evmDeps);
    expect(result.success).toBe(false);
    expect(result.output).toContain("changed after it was prepared");
    expectNothingHappened();
  });
});

describe("cross-kind and cross-family, refused BY NAME in both directions", () => {
  it("the EVM confirm cannot consume a Solana intent", async () => {
    getById.mockResolvedValue(
      intent({
        family: "solana",
        chainAlias: null,
        chainId: null,
        payload: { family: "solana", solana: { messageBase64: "QUJD", feePayer: "So1111" } },
        recentBlockhash: "hash",
        lastValidBlockHeight: 10,
        proposalDigest: "",
      }),
    );
    const result = await handleWalletEvmTransactionConfirm({ intentId: "wtx-1" }, context(), evmDeps);
    expect(result.success).toBe(false);
    expect(result.output).toContain("was prepared for solana");
    expectNothingHappened();
  });

  it("the Solana confirm cannot consume an EVM intent", async () => {
    getById.mockResolvedValue(intent());
    const result = await handleWalletSolanaTransactionConfirm(
      { intentId: "wtx-1" },
      context(),
      solanaDeps,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("was prepared for eip155");
    expectNothingHappened();
  });
});

describe("the approval gate", () => {
  it("stops a restricted session with the binding attached and nothing claimed", async () => {
    const row = intent();
    getById.mockResolvedValue(row);
    const result = await handleWalletEvmTransactionConfirm(
      { intentId: "wtx-1" },
      context({ sessionPermission: "restricted" }),
      evmDeps,
    );
    expect(result.pendingApproval).toBe(true);
    expect(result.preparedApprovalBinding?.proposalDigest).toBe(row.proposalDigest);
    expect(result.actionKind).toBe("user_wallet_broadcast");
    expectNothingHappened();
  });

  it("refuses an approved resume whose approval names a DIFFERENT prepared action", async () => {
    getById.mockResolvedValue(intent());
    getByIdForSession.mockResolvedValue({
      id: "approval-1",
      toolCall: {
        command: "WalletEvmTransactionConfirm",
        args: { intentId: "wtx-other" },
        proposalBinding: {
          // A well-formed V2 block: the resource check must be what refuses,
          // not a binding that failed to parse.
          preview: { label: "Send 1 wei", criticalArgs: { chain: "base" } },
          proposalDigest: "some-other-digest",
          proposalDigestVersion: PROPOSAL_DIGEST_VERSION,
          resource: { table: "wallet_transaction_intents", intentId: "wtx-other" },
        },
      },
    });
    const result = await handleWalletEvmTransactionConfirm(
      { intentId: "wtx-1" },
      context({ sessionPermission: "restricted", approved: true, approvalId: "approval-1" }),
      evmDeps,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("different prepared action");
    expectNothingHappened();
  });

  it("refuses an approved resume whose approval carries NO binding at all", async () => {
    getById.mockResolvedValue(intent());
    getByIdForSession.mockResolvedValue({
      id: "approval-1",
      toolCall: { command: "WalletEvmTransactionConfirm", args: { intentId: "wtx-1" } },
    });
    const result = await handleWalletEvmTransactionConfirm(
      { intentId: "wtx-1" },
      context({ sessionPermission: "restricted", approved: true, approvalId: "approval-1" }),
      evmDeps,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("no record of WHICH transaction");
    expectNothingHappened();
  });
});
