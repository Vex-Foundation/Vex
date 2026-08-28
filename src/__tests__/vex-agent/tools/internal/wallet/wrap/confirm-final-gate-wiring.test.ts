/**
 * THE FINAL GATE IS INSTALLED, and it is installed at the pre-sign point.
 *
 * `final-request.test.ts` proves what the gate DECIDES. A pure verdict function
 * nobody calls decides nothing, so this suite proves the other half: that
 * `handleWalletWrapConfirm` hands a pre-sign hook to `signStageBroadcast`, and
 * that the hook refuses a request which does not match the durable intent.
 *
 * ## Why the signing primitive is faked rather than driven
 *
 * The real `signStageBroadcast` needs a node, a key and a chain, none of which
 * can prove anything about our hook that capturing the hook itself does not.
 * The fake captures `onBeforeSign` and hands it whatever request the case wants
 * to test - which is exactly the position viem's `prepareTransactionRequest`
 * occupies in production, and the reason the gate exists at all: the object
 * arriving there is NOT the triple the caller built.
 *
 * ## Why the fakes are installed as MODULE mocks, not passed in as `deps`
 *
 * `WrapConfirmDeps.signerClientsFactory` must return real viem
 * `PublicClient`/`WalletClient` shapes, which cannot be built in a test without
 * a type escape - and this repository's test gate forbids those escapes for a
 * good reason: a laundered fake stops being checked against the contract it
 * imitates. Mocking the two default factory modules instead keeps the ONE value
 * this suite constructs by hand - the tool context - fully typed and honest.
 *
 * The DB-bound collaborators are faked for the ordinary reason: this suite is
 * about one seam, and their contracts have their own suites. The pure
 * revalidations are left REAL, so a case cannot pass over an inconsistent row.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import type { FinalSignedRequest } from "@tools/evm-chains/staged-broadcast.js";
import type { WalletWrapIntent } from "@vex-agent/db/repos/wallet-wrap-intents.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";

import { consistentWrapIntent } from "./_wrap-row-fixture.js";

const INTENT: WalletWrapIntent = consistentWrapIntent();

/** The hook the handler installs, captured on the way into the signing primitive. */
let capturedOnBeforeSign:
  | ((request: FinalSignedRequest) => Promise<void>)
  | undefined;

/** Set when the handler stages a hash, which is the step that precedes broadcast. */
let staged = false;

const signStageBroadcastCalls = { count: 0 };

vi.mock("@tools/evm-chains/staged-broadcast.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@tools/evm-chains/staged-broadcast.js")
  >();
  return {
    ...actual,
    // The wrap lane signs through the DEFERRED arm, so its pre-sign hook rides
    // on the signer object. This is the hook the real primitive awaits with the
    // request it is about to serialize.
    signStageBroadcast: async (
      _publicClient: unknown,
      signer: { onBeforeSign?: (request: FinalSignedRequest) => Promise<void> },
    ) => {
      signStageBroadcastCalls.count += 1;
      capturedOnBeforeSign = signer.onBeforeSign;
      // An empty log set: this suite is about the pre-sign hook, and the
      // receipt decode has its own suite. No logs means no legs were proven.
      return { kind: "confirmed", txHash: `0x${"a".repeat(64)}`, receipt: { logs: [] } };
    },
  };
});

vi.mock("@vex-agent/tools/internal/wallet/wrap/gate.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@vex-agent/tools/internal/wallet/wrap/gate.js")
  >();
  return {
    ...actual,
    // `revalidateWrapAtCommit` and `revalidateWrapIntentRow` stay REAL: they
    // produce the transaction the handler then asks the signer for, and faking
    // them would let this suite pass over a row that is not consistent.
    gateWrapConfirm: async () => ({
      kind: "proceed",
      intent: INTENT,
      anchor: {
        sessionId: INTENT.sessionId,
        family: "eip155",
        walletAddress: INTENT.walletAddress,
        walletId: "wallet-1",
        permission: "full",
        dispatchGeneration: "1",
        intentId: INTENT.intentId,
      },
      loadSigner: () => ({ kind: "signer", signer: {} }),
    }),
  };
});

vi.mock("@vex-agent/tools/internal/wallet/wrap/activity-writer.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@vex-agent/tools/internal/wallet/wrap/activity-writer.js")
  >();
  return {
    ...actual,
    claimWrapIntent: async () => ({
      ok: true,
      intent: INTENT,
      activity: {
        activityId: 1,
        executionId: 2,
        startedAtMs: Date.now(),
        stageEvm: async () => {
          staged = true;
        },
        reserveEvmNonce: async () => 7,
      },
    }),
  };
});

/** The settlement is the OUTPUT of the flow; this suite asserts on its input. */
vi.mock("@vex-agent/tools/internal/wallet/wrap/settlement.js", () => ({
  settleWrapExecution: async () => ({ success: false, data: {} }),
}));

vi.mock("@vex-agent/tools/internal/wallet/transaction/authority-fence.js", () => ({
  recheckAuthority: async () => ({ ok: true }),
  recheckAuthorityWith: async () => ({ ok: true }),
}));

vi.mock("@vex-agent/tools/internal/wallet/wrap/chain.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@vex-agent/tools/internal/wallet/wrap/chain.js")
  >();
  return {
    ...actual,
    defaultWrapChainFactory: async () => ({
      chainId: INTENT.chainId,
      chainAlias: INTENT.chainAlias,
      nativeSymbol: "ETH",
      nativeDecimals: 18,
      getNativeBalance: async () => "100000000000000000000",
      getWrappedBalance: async () => "100000000000000000000",
      simulate: async () => ({ ok: true, value: undefined }),
      estimateFees: async () => ({}),
    }),
  };
});

vi.mock("@vex-agent/tools/internal/wallet/transaction/confirm-evm.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@vex-agent/tools/internal/wallet/transaction/confirm-evm.js")
  >();
  return {
    ...actual,
    // Inert by construction: `signStageBroadcast` is faked above, so nothing
    // ever calls into these clients.
    defaultEvmSignerClientsFactory: async () => ({
      publicClient: {},
      chain: {},
      chainName: "Base",
      createWalletClient: () => ({}),
    }),
  };
});

const { handleWalletWrapConfirm } = await import(
  "@vex-agent/tools/internal/wallet/wrap/confirm.js"
);

/** Fully typed, because it is the one value this suite really constructs. */
const CONTEXT: InternalToolContext = {
  sessionId: INTENT.sessionId,
  loadedDocuments: new Map<string, string>(),
  sessionPermission: "full",
  approved: true,
  missionRunId: null,
  planMode: false,
  missionId: null,
  sessionKind: "agent",
  contextUsageBand: "normal",
  walletResolution: { source: "session", evm: null, solana: null },
  walletPolicy: { kind: "none" },
};

/** The request the signer would be handed for a healthy intent. */
function goodRequest(overrides: Partial<FinalSignedRequest> = {}): FinalSignedRequest {
  return {
    to: INTENT.payload.to as `0x${string}`,
    data: INTENT.payload.data as `0x${string}`,
    value: BigInt(INTENT.payload.valueWei),
    gas: 50_000n,
    nonce: 7,
    ...overrides,
  };
}

async function runConfirmAndCaptureHook(): Promise<
  (request: FinalSignedRequest) => Promise<void>
> {
  await handleWalletWrapConfirm({ intentId: INTENT.intentId }, CONTEXT);
  expect(signStageBroadcastCalls.count).toBeGreaterThan(0);
  const hook = capturedOnBeforeSign;
  if (hook === undefined) {
    throw new Error("the confirm handler installed NO pre-sign hook at all");
  }
  return hook;
}

describe("the wrap confirm handler installs a pre-sign gate on the FINAL request", () => {
  beforeEach(() => {
    capturedOnBeforeSign = undefined;
    signStageBroadcastCalls.count = 0;
    staged = false;
  });

  it("passes a request that is the approved triple", async () => {
    const hook = await runConfirmAndCaptureHook();
    await expect(hook(goodRequest())).resolves.toBeUndefined();
  });

  it("REFUSES a request whose target was redirected", async () => {
    const hook = await runConfirmAndCaptureHook();
    await expect(
      hook(goodRequest({ to: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" })),
    ).rejects.toThrow();
  });

  it("REFUSES a request whose calldata was replaced", async () => {
    const hook = await runConfirmAndCaptureHook();
    await expect(hook(goodRequest({ data: "0x2e1a7d4d" }))).rejects.toThrow();
  });

  it("REFUSES a request that would attach a different native value", async () => {
    // The case the commit-time gate cannot see: `to` and `data` are byte
    // identical to the approved ones, and only the money moved.
    const hook = await runConfirmAndCaptureHook();
    await expect(
      hook(goodRequest({ value: BigInt(INTENT.payload.valueWei) + 1n })),
    ).rejects.toThrow();
  });

  it("refuses BEFORE anything is staged, so nothing could have been broadcast", async () => {
    const hook = await runConfirmAndCaptureHook();
    staged = false;
    await expect(hook(goodRequest({ value: 1n }))).rejects.toThrow();
    // Staging is the step that precedes broadcast. A refusal after it would
    // mean bytes could already be on the network.
    expect(staged).toBe(false);
  });
});
