/**
 * PHASE 2 RE-ASKS THE VAULT CURATION GATE, and it does so BEFORE anything is
 * signed - on a DEPOSIT, and never on a withdrawal.
 *
 * The gate's claim is that curation is read AT EXECUTION TIME. On the deposit's
 * approve-then-operate path the handler's gate runs before the APPROVAL, which
 * is one transaction and one confirmation earlier than the deposit itself.
 * Without a re-run the claim would be true of the approval and merely inherited
 * by the deposit, so a vault delisted in that window would be funded on an
 * expired check. The API detail read is served through a 15-second cache and the
 * simulation only proves the call succeeds, so neither one closes this.
 *
 * THE WITHDRAWAL EXEMPTION IS TESTED AS HARD AS THE GATE ITSELF. Delisting must
 * never trap a depositor inside, so an exit is not gated on curation even when
 * the gate would refuse. That asymmetry is policy; a future change that makes
 * the lane "consistent" by gating both directions is a regression, and the last
 * case here is what says so.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import { definedValue } from "../../../../_test-value-guards.js";

const curatesVault = vi.hoisted(() => vi.fn(async (_chainId: number, _vaultAddress: string) => undefined));
const prepareLeg = vi.hoisted(() => vi.fn());
const broadcast = vi.hoisted(() => vi.fn());
const failEvent = vi.hoisted(() => vi.fn(async () => undefined));

// Only the pre-signature gate and the rebuild are replaced. The gate's own
// predicate has its own suite; what is under test here is whether this leg ASKS
// it, on which direction, and in which order relative to the rebuild.
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

// The broadcast is the line these cases must prove is never crossed on a refusal.
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
import type {
  MorphoExecutionContext,
} from "@vex-agent/tools/protocols/morpho/handlers/signed-broadcast/run.js";

const VAULT = "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9";
const TARGET = "0x6BFd8137e702540E7A42B74178A4a49Ba43920C4";
const WALLET = "0xaaaaBBBBccccDDDDEeeeFFff0000111122223333";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function context(direction: "deposit" | "withdraw"): MorphoExecutionContext {
  const built: Record<string, unknown> = {
    clients: { actionClient: {}, publicClient: {}, walletClient: {} },
    request: {
      toolId: `morpho.vault.${direction}`,
      sessionId: "s1",
      intentParams: {},
      chainId: 8453,
      vaultAddress: VAULT,
      walletAddress: WALLET,
      amountRaw: 1_000_000n,
      slippageBps: 50,
    },
    direction,
    executionId: 7,
    events: [{ id: 11, tokenInAddress: ASSET, tokenOutAddress: VAULT, amountInRaw: "1000000", amountOutRaw: "97" }],
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
    operationLabel: `vault ${direction}`,
    approvalAmountRaw: 1_000_000n,
    residual: null,
    priorLeg: undefined,
  };
  // Assembled by `run.ts` from live reads. This is the same shape reduced to the
  // parts this leg touches - the viem clients and the broadcast are mocked, so
  // they are never read - and it is returned through the REAL exported type, so
  // a change to the context this leg depends on breaks these cases rather than
  // letting them keep passing against a private local shape.
  return built as MorphoExecutionContext;
}

function delisted(): VexError {
  return new VexError(
    ErrorCodes.MORPHO_VAULT_POLICY_VIOLATION,
    `Refusing the deposit: FAILING PREDICATE "vault-listed". Morpho does not curate vault ${VAULT} on chain 8453.`,
    "Nothing was approved, signed or sent.",
  );
}

describe("Morpho vault operation leg re-asks the curation gate before signing a deposit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    curatesVault.mockResolvedValue(undefined);
    prepareLeg.mockResolvedValue({
      to: TARGET,
      data: "0x",
      value: 0n,
      bundle: {},
      gas: {},
      preflight: { verdict: "ok" },
    });
    broadcast.mockResolvedValue({ kind: "confirmed", txHash: "0xabc", receipt: { logs: [] } });
  });

  it("ASKS THE GATE AGAIN, with this execution's own chain and vault", async () => {
    await runOperationLeg(context("deposit"));

    expect(curatesVault).toHaveBeenCalledTimes(1);
    const [chainId, vaultAddress] = definedValue(curatesVault.mock.calls[0], "the vault gate's first call");
    expect(chainId).toBe(8453);
    expect(vaultAddress).toBe(VAULT);
  });

  it("REFUSES BEFORE SIGNING when the vault was delisted after the approval landed", async () => {
    curatesVault.mockRejectedValue(delisted());

    const outcome = await runOperationLeg(context("deposit"));

    expect(outcome.kind).toBe("refused");
    // The broadcast is the line that must never be crossed.
    expect(broadcast).not.toHaveBeenCalled();
    // Nor is the transaction even built: a refusal costs no rebuild either.
    expect(prepareLeg).not.toHaveBeenCalled();
    // The agent is told the real cause, not a generic "unexpected error".
    expect(outcome.message).toContain('FAILING PREDICATE "vault-listed"');
    expect(failEvent).toHaveBeenCalledWith(11, expect.objectContaining({
      failureReason: expect.stringContaining("refused before signing"),
    }));
  });

  it("runs the gate BEFORE the rebuild, so a delisted vault costs no build work either", async () => {
    const order: string[] = [];
    curatesVault.mockImplementation(async () => { order.push("gate"); return undefined; });
    prepareLeg.mockImplementation(async () => {
      order.push("rebuild");
      return { to: TARGET, data: "0x", value: 0n, bundle: {}, gas: {}, preflight: { verdict: "ok" } };
    });

    await runOperationLeg(context("deposit"));

    expect(order).toEqual(["gate", "rebuild"]);
  });

  it("NEVER GATES A WITHDRAWAL ON CURATION, so a delisted vault cannot trap a depositor inside", async () => {
    // The gate is rigged to refuse everything. The withdrawal must not consult
    // it at all, and must still rebuild, simulate and broadcast as before.
    curatesVault.mockRejectedValue(delisted());

    const outcome = await runOperationLeg(context("withdraw"));

    expect(curatesVault).not.toHaveBeenCalled();
    expect(prepareLeg).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(outcome.kind).not.toBe("refused");
  });
});
