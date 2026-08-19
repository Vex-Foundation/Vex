/**
 * D1 (funded live audit, 2026-08-18): A DEPOSIT MUST NOT BE REFUSED AS
 * DEFINITIVE ON A STALE READ OF ITS OWN APPROVAL.
 *
 * What happened, on real funds: the deposit broadcast its approval legs, awaited
 * a definitive receipt for each, then rebuilt and simulated against a node that
 * had not applied the approval's block. The revert was terminalized as "a
 * definitive refusal from the chain rather than a transient failure". On chain
 * the allowance was already exactly 100000 raw, and the identical call minutes
 * later confirmed. The user paid for two approval transactions and got no
 * deposit.
 *
 * The reproduction below is that sequence: `context.priorLeg` set (an allowance
 * leg of THIS execution confirmed at a known block) and a phase-2 preparation
 * that raises `MORPHO_PREFLIGHT_REVERTED`. Before the fix the first case ended
 * with the definitive wording and a `simulation_reverted` row.
 *
 * The three properties pinned here are the whole contract:
 *   - with an approval of ours behind it, the simulation is retried after the
 *     node is given a chance to reach that approval's block, and a node that
 *     catches up lets the deposit proceed rather than dying;
 *   - a revert that survives every attempt is NOT definitive, says the approval
 *     is standing, and is recorded as `unknown`, never `simulation_reverted`;
 *   - with NO approval of ours behind it, nothing changes: one attempt, the
 *     original definitive refusal, unretried. A first-touch revert has no stale
 *     state of ours to blame.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { VexError, ErrorCodes } from "../../../../../errors.js";

const curatesVault = vi.hoisted(() => vi.fn(async (_chainId: number, _vaultAddress: string) => undefined));
const prepareLeg = vi.hoisted(() => vi.fn());
const broadcast = vi.hoisted(() => vi.fn());
const failEvent = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@tools/morpho/mutations.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tools/morpho/mutations.js")>(),
  assertMorphoCuratesVault: curatesVault,
  prepareMorphoOperationLeg: prepareLeg,
}));

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  confirmActivityEvent: vi.fn(async () => undefined),
  failActivityEvent: failEvent,
  notePendingReason: vi.fn(async () => undefined),
}));

// The broadcast is the line a pre-signature refusal must never cross.
vi.mock(
  "@vex-agent/tools/protocols/morpho/handlers/signed-broadcast/leg-broadcast.js",
  () => ({
    broadcastMorphoLeg: broadcast,
    finalizeMorphoFailSoft: async (_toolId: string, write: () => Promise<unknown>) => { await write(); },
    noteMorphoSettledBlockTime: vi.fn(async () => undefined),
  }),
);

vi.mock("@vex-agent/tools/protocols/runtime/pending-provenance.js", () => ({
  noteHandlerPendingReason: vi.fn(async () => undefined),
}));

const { runOperationLeg } = await import(
  "@vex-agent/tools/protocols/morpho/handlers/signed-broadcast/operation-leg.js"
);
const { POST_APPROVAL_PREFLIGHT_ATTEMPTS } = await import(
  "@vex-agent/tools/protocols/morpho/handlers/signed-broadcast/post-approval-preflight.js"
);
import type {
  MorphoExecutionContext,
} from "@vex-agent/tools/protocols/morpho/handlers/signed-broadcast/run.js";

const VAULT = "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9";
const TARGET = "0x6BFd8137e702540E7A42B74178A4a49Ba43920C4";
const WALLET = "0xaaaaBBBBccccDDDDEeeeFFff0000111122223333";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const APPROVAL_BLOCK = 34_000_100n;

/** The exact refusal `prepareMorphoOperationLeg` raises on a PROVEN revert. */
function preflightRevert(): VexError {
  return new VexError(
    ErrorCodes.MORPHO_PREFLIGHT_REVERTED,
    "Refusing to send the Morpho deposit: the node simulated it against current state and proved it reverts. "
    + "Reason: execution reverted: ERC20: transfer amount exceeds allowance.",
    "NOTHING was signed or sent for this step, so no gas was spent on it. This is a definitive refusal from the "
    + "chain rather than a transient failure.",
  );
}

function preparedLeg() {
  return { to: TARGET, data: "0x", value: 0n, bundle: {}, gas: {}, preflight: { verdict: "ok" } };
}

/**
 * The vault context as `run.ts` assembles it, reduced to the parts this leg
 * reads, and returned through the REAL exported type so a change to the context
 * breaks these cases instead of letting them pass against a local shape.
 *
 * `heads` is the head-height script the simulating client answers with.
 */
function context(options: { approvalBlock: bigint | undefined; heads?: bigint[] }): MorphoExecutionContext {
  const heads = options.heads ?? [APPROVAL_BLOCK];
  let call = 0;
  const built: Record<string, unknown> = {
    clients: {
      actionClient: {
        getBlockNumber: async () => heads[Math.min(call++, heads.length - 1)] ?? APPROVAL_BLOCK,
      },
      publicClient: {},
      walletClient: {},
    },
    request: {
      toolId: "morpho.vault.deposit",
      sessionId: "s1",
      intentParams: {},
      chainId: 8453,
      vaultAddress: VAULT,
      walletAddress: WALLET,
      amountRaw: 100_000n,
      slippageBps: 50,
    },
    direction: "deposit",
    executionId: 7,
    events: [{ id: 11, tokenInAddress: ASSET, tokenOutAddress: VAULT, amountInRaw: "100000", amountOutRaw: "97" }],
    legs: [{}],
    state: {
      address: VAULT,
      assetAddress: ASSET,
      assetSymbol: "USDC",
      assetDecimals: 6,
      shareSymbol: "mwUSDC",
      shareDecimals: 18,
    },
    allowancePlan: null,
    expectedSharesRaw: 97n,
    verifiedTarget: TARGET,
    operationLegIndex: 0,
    operationLabel: "vault deposit",
    approvalAmountRaw: 100_000n,
    residual: null,
    priorLeg: options.approvalBlock === undefined ? undefined : { blockNumber: options.approvalBlock },
  };
  // Deliberate test-double bridge: viem clients and broadcast methods are
  // mocked and never read here, so this reduced runtime shape cannot satisfy
  // the complete production context structurally.
  return built as unknown as MorphoExecutionContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Real backoff would make this suite wait ~4.5 seconds per case for nothing:
  // the behaviour under test is the retry and the classification, not the wall
  // clock. Timer control keeps both while the assertions stay on the outcome.
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 20 });
  curatesVault.mockResolvedValue(undefined);
  broadcast.mockResolvedValue({ kind: "confirmed", txHash: "0xabc", receipt: { logs: [] } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("D1: a revert after this execution's own approval landed is never terminalized", () => {
  it("RETRIES the simulation instead of refusing on the node's first stale answer", async () => {
    // The audit's exact shape: the allowance IS on chain, the node has not
    // applied it yet, and the very next look is clean.
    prepareLeg.mockRejectedValueOnce(preflightRevert()).mockResolvedValue(preparedLeg());

    const outcome = await runOperationLeg(context({ approvalBlock: APPROVAL_BLOCK }));

    expect(prepareLeg).toHaveBeenCalledTimes(2);
    // It REACHES the broadcast, which is the whole point: the deposit lives.
    // (The stub receipt carries no logs, so the settlement decode declines
    // afterwards; that ending belongs to the decoder's own suite.)
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(outcome.kind).not.toBe("refused");
    expect(failEvent).not.toHaveBeenCalled();
  });

  it("classifies a surviving revert as NOT definitive, and tells the agent the approval is standing", async () => {
    prepareLeg.mockRejectedValue(preflightRevert());

    const outcome = await runOperationLeg(context({ approvalBlock: APPROVAL_BLOCK }));

    expect(prepareLeg).toHaveBeenCalledTimes(POST_APPROVAL_PREFLIGHT_ATTEMPTS);
    // Nothing was signed, so the honest ending is a refusal that costs no gas -
    // never `unproven`, which would leave the repair sweep a row to resolve
    // about a transaction that does not exist.
    expect(outcome.kind).toBe("refused");
    expect(broadcast).not.toHaveBeenCalled();
    expect(outcome.message).toContain("NOT a definitive refusal from the chain");
    expect(outcome.message).toContain(String(APPROVAL_BLOCK));
    expect(outcome.message).toContain("approval is already in place");
    expect(outcome.message).toContain("re-running cannot duplicate anything");
    // The node's own words survive the hedge: a genuine revert stays visible.
    expect(outcome.message).toContain("ERC20: transfer amount exceeds allowance");
    // And the retrying is capped rather than invited to loop.
    expect(outcome.message).toContain("stop retrying");
  });

  it("records the row as `unknown`, never as a chain verdict it could not establish", async () => {
    prepareLeg.mockRejectedValue(preflightRevert());

    await runOperationLeg(context({ approvalBlock: APPROVAL_BLOCK }));

    expect(failEvent).toHaveBeenCalledWith(11, expect.objectContaining({
      failureCode: "unknown",
      failureReason: expect.stringContaining("NOT definitively"),
    }));
  });

  it("waits for the simulating node to reach the approval's block before believing it", async () => {
    // Behind, behind, then caught up. The estimate is only trusted once the head
    // has had its bounded chance to arrive.
    prepareLeg.mockRejectedValueOnce(preflightRevert()).mockResolvedValue(preparedLeg());

    const outcome = await runOperationLeg(
      context({ approvalBlock: APPROVAL_BLOCK, heads: [APPROVAL_BLOCK - 3n, APPROVAL_BLOCK - 1n, APPROVAL_BLOCK] }),
    );

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(outcome.kind).not.toBe("refused");
  });

  it("does NOT retry or hedge a first-touch revert, which has no approval of ours behind it", async () => {
    // A withdrawal sends no approval, so `priorLeg` is undefined and a revert is
    // the chain's own answer. Weakening that would be the defect in reverse.
    prepareLeg.mockRejectedValue(preflightRevert());

    const outcome = await runOperationLeg(context({ approvalBlock: undefined }));

    expect(prepareLeg).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("refused");
    expect(outcome.message).toContain("definitive refusal from the chain rather than a transient failure");
    expect(failEvent).toHaveBeenCalledWith(11, expect.objectContaining({ failureCode: "simulation_reverted" }));
  });

  it("still refuses a NON-revert pre-sign failure on the first attempt, unhedged", async () => {
    // A delisted vault, an unanswered node or a build failure each own an honest
    // ending already; the stale-approval hedge must not be draped over them.
    const unproven = new VexError(
      ErrorCodes.MORPHO_PREFLIGHT_UNPROVEN,
      "Refusing to send the Morpho deposit: the node did not answer the simulation.",
      "NOTHING was signed or sent for this step.",
    );
    prepareLeg.mockRejectedValue(unproven);

    const outcome = await runOperationLeg(context({ approvalBlock: APPROVAL_BLOCK }));

    expect(prepareLeg).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("refused");
    expect(outcome.message).toContain("did not answer the simulation");
    expect(outcome.message).not.toContain("NOT a definitive refusal from the chain");
  });
});
