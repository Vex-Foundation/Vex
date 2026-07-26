/**
 * The Jupiter Prediction FILL-SETTLEMENT lane
 * (`sync/solana-prediction-fill-settlement.ts`) — driven by the REAL captures
 * in `./fixtures/prediction-fill-settlement/` (see that directory's README for
 * capture provenance and the three-transaction lifecycle they prove).
 *
 * The defect this lane closes: a prediction sell/close pays out in a KEEPER's
 * later settle transaction, so the transaction Vex broadcast moves nothing and
 * the own-tx payout decoder correctly declines forever. Two live rows sat
 * `pending` with real money already in the wallet.
 *
 * Pins, in the order the lane runs:
 *   - who may enter: only `predict_sell`/`predict_close` on `jupiter`;
 *     `predict_claim` and every non-Jupiter row stay on the existing path;
 *   - the provider match is EXACT on all four of eventType/owner/signature/
 *     position — a near-miss leaves the row pending, never guesses;
 *   - ONE history request per (owner, position), cached across rows;
 *   - a provider 429/outage leaves the row pending and never throws;
 *   - the money proof requires BOTH legs in the SAME transaction: a JupUSD
 *     debit on the order's escrow AND a strictly-positive JupUSD credit to our
 *     wallet, of EQUAL magnitude. Credit-only, debit-only, unequal, wrong
 *     escrow, wrong mint, zero and negative all decline;
 *   - a proven payout finalizes through the CAS finalizer with the chain's
 *     number — never the provider's.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import {
  decodeTokenAccountDelta,
  decodeTokenBalanceDelta,
  parseSolanaTransactionResult,
} from "@vex-agent/sync/solana-settlement-decoders.js";
import type { PredictionHistoryEventView } from "@vex-agent/sync/solana-prediction-fill-settlement.js";

const mockConfirmPayoutSettlement = vi.fn();
const mockTouchLastChecked = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/db/repos/agent-activity.js")>();
  return {
    ...actual,
    confirmJupiterPredictionPayoutSettlement: (...args: unknown[]) => mockConfirmPayoutSettlement(...args),
    touchLastChecked: (...args: unknown[]) => mockTouchLastChecked(...args),
  };
});

const {
  createPredictionHistoryCache,
  isPredictionFillSettlementCandidate,
  settlePredictionFillIfProven,
} = await import("@vex-agent/sync/solana-prediction-fill-settlement.js");
const { buildPredictionOrderProvenance } = await import(
  "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-order-provenance.js"
);

type Deps = Parameters<typeof settlePredictionFillIfProven>[0]["deps"];

// ── The captured truth ────────────────────────────────────────────────────

const WALLET = "AeyBYFtgm85BrsZMKrAWdc2qGQqYvwfkt88dZdfYEndS";
const JUPUSD_MINT = "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const ROW_42 = {
  createSignature:
    "5AChd2vmZtjVFJ2wTgBssFwn6oAgJktHUBQkqU8oAwXJ7fJoZNUN6J7jbkmgAHkfEHXLWrSfCeKgvE5626tiFGsx",
  settleSignature:
    "43TvehHpQUNCY2Jw2LZ5KZ2qjWd7hmyxUSnonzhftuUE2cCRvoPApDGScdDhQyrwuip2wKvrq2K2piBJ397fzFzX",
  orderPubkey: "BHhiu4YZpAq4mQBR4ks8QJ2ALt1AMYVDd9D6PxjUgxyK",
  positionPubkey: "JBKuLxTk81jhm5VGmmWxXKxKKz8NAqjYad8TXgWMGkJd",
  escrowAta: "5cPEe71gehe8KWtHZYAMLDRX87nTk6Fm2Uf3UPAse1Hg",
  payoutRaw: "4545860",
  payoutHuman: "4.54586",
} as const;

const ROW_47 = {
  createSignature:
    "CZCecgm3fdpY22bMD8SqGdGhJqewvYgeNm7fBLYNkSHawzcyAas676efWNte9LqDFbLeNMtknQcFTWhsX7gP2pS",
  settleSignature:
    "3PQS8KWHcpz4ioRK6YxwarWjBRpoHTMJx6U3LMSnA9AC8sEErCKFkvjnhtaTmg2yXSDDRECYnS4j2rDF23xb8Sc4",
  orderPubkey: "7UPxH2TGRCZ9QVR5hLxzhb6X831JH9tRjMLrYgeGZoHg",
  positionPubkey: "H84ZBkrgt876mStVprz1tmjEbXPL7BS8Dmhd1EKvtR2H",
  escrowAta: "9b3k1xf3qNUT8LeeR7D7kNienqqui6oAmcRSUfXZ7tfL",
  payoutRaw: "4160120",
  payoutHuman: "4.16012",
} as const;

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/prediction-fill-settlement/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount: { amount: string; decimals: number };
}
interface RawTransaction {
  meta: { err: unknown; preTokenBalances: RawTokenBalance[]; postTokenBalances: RawTokenBalance[] };
}

/** A deep copy of a capture, so a perturbation can never leak into another case. */
function settleTx(row: typeof ROW_42 | typeof ROW_47): RawTransaction {
  return clone(fixture(row === ROW_42 ? "tx-row42-settle" : "tx-row47-settle") as RawTransaction);
}

/** The real 7-event page for our wallet — both `order_created` matches present. */
const historyEvents: readonly PredictionHistoryEventView[] = (
  fixture("wallet-history") as { data: PredictionHistoryEventView[] }
).data;

// ── Row + deps builders ───────────────────────────────────────────────────

function predictionRow(overrides: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    id: 42,
    protocolExecutionId: 7,
    eventIndex: 0,
    eventRole: "predict_sell",
    recordVersion: 1,
    kind: "prediction",
    protocol: "jupiter",
    chainId: 20011000000,
    chainSlug: "solana",
    status: "pending",
    failureCode: null,
    failureReason: null,
    tokenInAddress: null,
    tokenInSymbol: null,
    tokenInDecimals: null,
    amountInHuman: null,
    amountInRaw: null,
    tokenOutAddress: USDC_MINT,
    tokenOutSymbol: "USDC",
    tokenOutDecimals: 6,
    amountOutHuman: null,
    amountOutRaw: null,
    executedAmountInHuman: null,
    executedAmountInRaw: null,
    executedAmountOutHuman: null,
    executedAmountOutRaw: null,
    usdInEst: null,
    usdOutEst: null,
    usdFeeEst: null,
    usdNetworkGasEst: null,
    usdVenueFeeEst: null,
    usdDestinationPrepayEst: null,
    usdVexFeeEst: null,
    vexFeeTokenAddress: null,
    vexFeeTokenSymbol: null,
    vexFeeTokenDecimals: null,
    vexFeeAmountRaw: null,
    vexFeeAmountHuman: null,
    usdSource: null,
    txHash: ROW_42.createSignature,
    fromAddress: WALLET,
    nonce: null,
    walletAddress: WALLET,
    sessionId: "00000000-0000-4000-8000-000000000001",
    routeProvenance: buildPredictionOrderProvenance(ROW_42.positionPubkey),
    fromChainId: null,
    fromChainSlug: null,
    toChainId: null,
    toChainSlug: null,
    chainFamily: "solana",
    providerOrderId: null,
    normalizedRoute: null,
    providerStatus: null,
    evidenceSource: null,
    observedAt: null,
    lastAttemptedAt: null,
    submitAttemptedAt: "2026-07-25T10:00:00.000Z",
    recentBlockhash: "11111111111111111111111111111112",
    lastValidBlockHeight: 12345,
    broadcastAt: "2026-07-25T10:00:01.000Z",
    confirmedAt: null,
    lastCheckedAt: null,
    createdAt: "2026-07-25T09:59:00.000Z",
    updatedAt: "2026-07-25T10:00:01.000Z",
    ...overrides,
  };
}

function row47(): AgentActivityEvent {
  return predictionRow({
    id: 47,
    eventRole: "predict_close",
    txHash: ROW_47.createSignature,
    routeProvenance: buildPredictionOrderProvenance(ROW_47.positionPubkey),
  });
}

interface DepsOptions {
  readonly settleTransactions?: Record<string, unknown>;
  readonly signatures?: Record<string, ReadonlyArray<{ signature: string; err: unknown }>>;
  readonly historyOutcome?: "found" | "unavailable";
}

function buildDeps(options: DepsOptions = {}): { deps: Deps; historyCalls: unknown[][]; signatureCalls: unknown[][] } {
  const historyCalls: unknown[][] = [];
  const signatureCalls: unknown[][] = [];
  const settleTransactions = options.settleTransactions ?? {
    [ROW_42.settleSignature]: settleTx(ROW_42),
    [ROW_47.settleSignature]: settleTx(ROW_47),
  };
  const signatures = options.signatures ?? {
    [ROW_42.escrowAta]: [
      { signature: ROW_42.settleSignature, err: null },
      { signature: ROW_42.createSignature, err: null },
    ],
    [ROW_47.escrowAta]: [
      { signature: ROW_47.settleSignature, err: null },
      { signature: ROW_47.createSignature, err: null },
    ],
  };

  const deps: Deps = {
    getFinalizedTransaction: async (signature: string) => {
      const tx = settleTransactions[signature];
      return tx === undefined ? { outcome: "not_found" as const } : { outcome: "found" as const, value: tx };
    },
    getSignaturesForAddress: async (address: string, limit: number) => {
      signatureCalls.push([address, limit]);
      const entries = signatures[address];
      return entries === undefined
        ? { outcome: "found" as const, value: [] }
        : { outcome: "found" as const, value: entries };
    },
    getPredictionOrderHistory: async (query: unknown) => {
      historyCalls.push([query]);
      if (options.historyOutcome === "unavailable") return { outcome: "unavailable" as const };
      return { outcome: "found" as const, events: historyEvents };
    },
  };
  return { deps, historyCalls, signatureCalls };
}

async function settle(event: AgentActivityEvent, deps: Deps, cache = createPredictionHistoryCache()) {
  return settlePredictionFillIfProven({ event, deps, historyCache: cache });
}

beforeEach(() => {
  mockConfirmPayoutSettlement.mockReset();
  mockConfirmPayoutSettlement.mockResolvedValue({ applied: true, row: predictionRow({ status: "confirmed" }) });
  mockTouchLastChecked.mockReset();
  mockTouchLastChecked.mockResolvedValue(undefined);
});

// ── Who may enter ─────────────────────────────────────────────────────────

describe("lane entry condition", () => {
  it("admits a Jupiter predict_sell and predict_close", () => {
    expect(isPredictionFillSettlementCandidate(predictionRow())).toBe(true);
    expect(isPredictionFillSettlementCandidate(row47())).toBe(true);
  });

  it("never admits predict_claim — the claim path has never run live and is not proven by this lane", () => {
    expect(isPredictionFillSettlementCandidate(predictionRow({ eventRole: "predict_claim" }))).toBe(false);
  });

  it.each([
    ["a non-Jupiter prediction row", { protocol: "polymarket" } as Partial<AgentActivityEvent>],
    ["a non-prediction kind", { kind: "swap" } as Partial<AgentActivityEvent>],
    ["a swap role", { eventRole: "swap" } as Partial<AgentActivityEvent>],
    ["a buy (it debits, and the debit is in our own tx)", { eventRole: "predict_buy" } as Partial<AgentActivityEvent>],
    ["a row with no signature", { txHash: null } as Partial<AgentActivityEvent>],
  ])("never admits %s", (_label, overrides) => {
    expect(isPredictionFillSettlementCandidate(predictionRow(overrides))).toBe(false);
  });
});

// ── The provider match ────────────────────────────────────────────────────

describe("provider history match", () => {
  it("settles row 42 from the real capture: order_created + owner + signature + position all agree", async () => {
    const { deps } = buildDeps();

    const outcome = await settle(predictionRow(), deps);

    expect(outcome).toBe("confirmed");
    expect(mockConfirmPayoutSettlement).toHaveBeenCalledTimes(1);
    const [id, input] = mockConfirmPayoutSettlement.mock.calls[0]!;
    expect(id).toBe(42);
    expect(input).toMatchObject({
      executedAmountOutRaw: ROW_42.payoutRaw,
      executedAmountOutHuman: ROW_42.payoutHuman,
      orderPubkey: ROW_42.orderPubkey,
      createSignature: ROW_42.createSignature,
      matchedEventType: "order_created",
      settleSignature: ROW_42.settleSignature,
      escrowAta: ROW_42.escrowAta,
    });
  });

  it("settles row 47 from its own capture — a different position, a different escrow, a different amount", async () => {
    const { deps } = buildDeps();

    const outcome = await settle(row47(), deps);

    expect(outcome).toBe("confirmed");
    const [id, input] = mockConfirmPayoutSettlement.mock.calls[0]!;
    expect(id).toBe(47);
    expect(input).toMatchObject({
      executedAmountOutRaw: ROW_47.payoutRaw,
      orderPubkey: ROW_47.orderPubkey,
      escrowAta: ROW_47.escrowAta,
    });
  });

  it("derives the escrow ATA from the order key and scans exactly that address", async () => {
    const { deps, signatureCalls } = buildDeps();

    await settle(predictionRow(), deps);

    expect(signatureCalls).toHaveLength(1);
    expect(signatureCalls[0]![0]).toBe(ROW_42.escrowAta);
  });

  it.each([
    ["the signature belongs to another transaction", { txHash: ROW_47.createSignature.replace(/.$/, "9") }],
    ["the wallet is not the event owner", { walletAddress: "So11111111111111111111111111111111111111112" }],
  ])("leaves the row pending when %s", async (_label, overrides) => {
    const { deps } = buildDeps();

    const outcome = await settle(predictionRow(overrides as Partial<AgentActivityEvent>), deps);

    expect(outcome).toBe("pending");
    expect(mockConfirmPayoutSettlement).not.toHaveBeenCalled();
  });

  it("leaves the row pending when the matched history event is not an order_created", async () => {
    // The `order_filled` event for the same order carries a DIFFERENT
    // signature; pointing the row at it must not match.
    const filled = historyEvents.find((e) => e.eventType === "order_filled");
    if (!filled) throw new Error("fixture must contain an order_filled event");
    const { deps } = buildDeps();

    const outcome = await settle(predictionRow({ txHash: filled.signature }), deps);

    expect(outcome).toBe("pending");
    expect(mockConfirmPayoutSettlement).not.toHaveBeenCalled();
  });

  it("leaves the row pending when the row's own provenance names a different position than the matched event", async () => {
    const { deps } = buildDeps();

    const outcome = await settle(
      predictionRow({ routeProvenance: buildPredictionOrderProvenance(ROW_47.positionPubkey) }),
      deps,
    );

    expect(outcome).toBe("pending");
    expect(mockConfirmPayoutSettlement).not.toHaveBeenCalled();
  });

  it("leaves the row pending when the matched event's order key is not a valid public key", async () => {
    const broken = clone(historyEvents).map((event) =>
      event.signature === ROW_42.createSignature ? { ...event, orderPubkey: "not-a-real-pubkey!!" } : event,
    );
    const { deps } = buildDeps();
    const patched: Deps = {
      ...deps,
      getPredictionOrderHistory: async () => ({ outcome: "found" as const, events: broken }),
    };

    expect(await settle(predictionRow(), patched)).toBe("pending");
    expect(mockConfirmPayoutSettlement).not.toHaveBeenCalled();
  });
});

// ── Request economy + provider outage ─────────────────────────────────────

describe("history request economy", () => {
  /**
   * THE REQUEST IS NEVER POSITION-SCOPED. Probed live 2026-07-26: the provider
   * accepts `positionPubkey` and then returns an EMPTY page while reporting a
   * non-zero count — `{ownerPubkey}` gave 7 events of `total: 21`, adding row
   * 42's position gave 0 events of `total: 4`, row 47's gave 0 of `total: 2`.
   * A fresh row WITH provenance stalled forever on that empty answer while
   * legacy rows kept settling, because only the legacy path was unfiltered.
   * This is the regression guard for that.
   */
  it("asks per WALLET and never sends a positionPubkey, even when the row knows its position", async () => {
    const { deps, historyCalls } = buildDeps();

    await settle(predictionRow(), deps);

    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0]![0]).toEqual({ ownerPubkey: WALLET });
    expect(historyCalls[0]![0]).not.toHaveProperty("positionPubkey");
  });

  it("issues ONE history request for two rows of the SAME position", async () => {
    const { deps, historyCalls } = buildDeps();
    const cache = createPredictionHistoryCache();

    await settle(predictionRow(), deps, cache);
    await settle(predictionRow({ id: 43 }), deps, cache);

    expect(historyCalls).toHaveLength(1);
  });

  it("issues ONE history request for rows of DIFFERENT positions — one wallet page answers both", async () => {
    const { deps, historyCalls } = buildDeps();
    const cache = createPredictionHistoryCache();

    expect(await settle(predictionRow(), deps, cache)).toBe("confirmed");
    expect(await settle(row47(), deps, cache)).toBe("confirmed");

    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0]![0]).toEqual({ ownerPubkey: WALLET });
    // and each row still settled against ITS OWN position's money
    expect(mockConfirmPayoutSettlement.mock.calls.map((call) => call[1].executedAmountOutRaw)).toEqual([
      ROW_42.payoutRaw,
      ROW_47.payoutRaw,
    ]);
  });

  it("uses the same per-wallet request for a legacy row with no provenance", async () => {
    const { deps, historyCalls } = buildDeps();
    const cache = createPredictionHistoryCache();

    const outcome = await settle(predictionRow({ routeProvenance: null }), deps, cache);
    await settle(predictionRow({ id: 43, routeProvenance: null }), deps, cache);

    expect(outcome).toBe("confirmed");
    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0]![0]).toEqual({ ownerPubkey: WALLET });
  });

  it("leaves the row pending — never throws — when the provider is rate-limited or unavailable", async () => {
    const { deps } = buildDeps({ historyOutcome: "unavailable" });

    const outcome = await settle(predictionRow(), deps);

    expect(outcome).toBe("pending");
    expect(mockConfirmPayoutSettlement).not.toHaveBeenCalled();
  });

  it("does not re-request an unavailable history within the same sweep run, across DIFFERENT positions", async () => {
    const { deps, historyCalls } = buildDeps({ historyOutcome: "unavailable" });
    const cache = createPredictionHistoryCache();

    await settle(predictionRow(), deps, cache);
    await settle(row47(), deps, cache);

    expect(historyCalls).toHaveLength(1);
  });
});

// ── The both-legs equality matrix ─────────────────────────────────────────

describe("both-legs equality matrix", () => {
  async function settleWith(tx: RawTransaction): Promise<string> {
    const { deps } = buildDeps({ settleTransactions: { [ROW_42.settleSignature]: tx } });
    return settle(predictionRow(), deps);
  }

  function escrowLeg(tx: RawTransaction, side: "preTokenBalances" | "postTokenBalances"): RawTokenBalance | undefined {
    return tx.meta[side].find((b) => b.owner === ROW_42.orderPubkey && b.mint === JUPUSD_MINT);
  }
  function walletLeg(tx: RawTransaction, side: "preTokenBalances" | "postTokenBalances"): RawTokenBalance | undefined {
    return tx.meta[side].find((b) => b.owner === WALLET && b.mint === JUPUSD_MINT);
  }

  it("ACCEPTS the untouched real settle capture", async () => {
    expect(await settleWith(settleTx(ROW_42))).toBe("confirmed");
    expect(mockConfirmPayoutSettlement.mock.calls[0]![1]).toMatchObject({
      executedAmountOutRaw: ROW_42.payoutRaw,
    });
  });

  it("rejects credit-only: our wallet is credited but no escrow was debited", async () => {
    const tx = settleTx(ROW_42);
    tx.meta.preTokenBalances = tx.meta.preTokenBalances.filter((b) => b.owner !== ROW_42.orderPubkey);
    expect(await settleWith(tx)).toBe("pending");
  });

  it("rejects debit-only: the escrow drained but our wallet is not a party", async () => {
    const tx = settleTx(ROW_42);
    tx.meta.preTokenBalances = tx.meta.preTokenBalances.filter((b) => b.owner !== WALLET);
    tx.meta.postTokenBalances = tx.meta.postTokenBalances.filter((b) => b.owner !== WALLET);
    expect(await settleWith(tx)).toBe("pending");
  });

  it("rejects debit-only against the REAL keeper fill capture (vault → escrow, wallet untouched)", async () => {
    const fill = clone(fixture("tx-row42-fill") as RawTransaction);
    expect(await settleWith(fill)).toBe("pending");
  });

  it("rejects unequal magnitudes — the escrow debit must equal our credit exactly", async () => {
    const tx = settleTx(ROW_42);
    escrowLeg(tx, "preTokenBalances")!.uiTokenAmount.amount = "4545861";
    expect(await settleWith(tx)).toBe("pending");
  });

  /**
   * THE ADVERSARIAL CASE (Codex final review). Binding the debit to the
   * escrow's OWNER is not the same claim as binding it to the escrow. An order
   * PDA may own more than one JupUSD account and anyone may create another one
   * with that owner, so a transaction that merely TOUCHES the derived escrow —
   * enough to be returned by `getSignaturesForAddress` — while draining a
   * different order-owned account and crediting our wallet the same amount
   * satisfies an owner+mint rule completely.
   *
   * The fixture is that transaction, derived from the real settle capture; see
   * its `_derivedFixture` header.
   */
  it("REJECTS a decoy account owned by the same order — only the DERIVED escrow may pay", async () => {
    const decoy = clone(fixture("tx-row42-settle-decoy-escrow") as RawTransaction);

    expect(await settleWith(decoy)).toBe("pending");
    expect(mockConfirmPayoutSettlement).not.toHaveBeenCalled();
  });

  it("and that decoy WOULD have satisfied the owner+mint rule this replaced", () => {
    const decoy = clone(fixture("tx-row42-settle-decoy-escrow") as RawTransaction);
    const parsed = parseSolanaTransactionResult(decoy);
    if (!parsed) throw new Error("fixture must parse");

    // the old rule's two numbers: equal magnitudes, opposite signs
    expect(decodeTokenBalanceDelta(parsed, ROW_42.orderPubkey, JUPUSD_MINT)).toBe(-4545860n);
    expect(decodeTokenBalanceDelta(parsed, WALLET, JUPUSD_MINT)).toBe(4545860n);
    // the new rule's: the derived escrow itself never moved
    expect(
      decodeTokenAccountDelta(parsed, {
        address: ROW_42.escrowAta,
        mint: JUPUSD_MINT,
        owner: ROW_42.orderPubkey,
      }),
    ).toBeNull();
  });

  it("still accepts the real capture through the account-bound rule", () => {
    const parsed = parseSolanaTransactionResult(settleTx(ROW_42));
    if (!parsed) throw new Error("fixture must parse");

    expect(
      decodeTokenAccountDelta(parsed, {
        address: ROW_42.escrowAta,
        mint: JUPUSD_MINT,
        owner: ROW_42.orderPubkey,
      }),
    ).toBe(-4545860n);
  });

  it("rejects a debit on an escrow belonging to a DIFFERENT order", async () => {
    const tx = settleTx(ROW_42);
    escrowLeg(tx, "preTokenBalances")!.owner = ROW_47.orderPubkey;
    expect(await settleWith(tx)).toBe("pending");
  });

  it("rejects a settlement carrying a foreign mint", async () => {
    const tx = settleTx(ROW_42);
    for (const side of ["preTokenBalances", "postTokenBalances"] as const) {
      for (const balance of tx.meta[side]) balance.mint = USDC_MINT;
    }
    expect(await settleWith(tx)).toBe("pending");
  });

  it("rejects a zero credit (an untouched wallet balance is not a payout)", async () => {
    const tx = settleTx(ROW_42);
    const pre = walletLeg(tx, "preTokenBalances")!;
    const post = walletLeg(tx, "postTokenBalances")!;
    post.uiTokenAmount.amount = pre.uiTokenAmount.amount;
    escrowLeg(tx, "preTokenBalances")!.uiTokenAmount.amount = "0";
    expect(await settleWith(tx)).toBe("pending");
  });

  it("rejects a NEGATIVE wallet movement (a debit is never a payout)", async () => {
    const tx = settleTx(ROW_42);
    walletLeg(tx, "postTokenBalances")!.uiTokenAmount.amount = "1";
    expect(await settleWith(tx)).toBe("pending");
  });

  it("rejects the create transaction itself — zero movement is why the row was stuck", async () => {
    const create = clone(fixture("tx-row42-create") as RawTransaction);
    expect(await settleWith(create)).toBe("pending");
  });

  it("skips a failed candidate transaction and keeps scanning", async () => {
    const failed = settleTx(ROW_42);
    failed.meta.err = { InstructionError: [3, "ProgramFailedToComplete"] };
    const { deps } = buildDeps({
      settleTransactions: { "FailedSig1111": failed, [ROW_42.settleSignature]: settleTx(ROW_42) },
      signatures: {
        [ROW_42.escrowAta]: [
          { signature: "FailedSig1111", err: { InstructionError: [3, "x"] } },
          { signature: ROW_42.settleSignature, err: null },
        ],
      },
    });

    expect(await settle(predictionRow(), deps)).toBe("confirmed");
  });

  it("leaves the row pending when no escrow signature proves anything", async () => {
    const { deps } = buildDeps({ signatures: { [ROW_42.escrowAta]: [] } });
    expect(await settle(predictionRow(), deps)).toBe("pending");
  });
});

// ── Finalize handoff ──────────────────────────────────────────────────────

describe("finalize handoff", () => {
  it("reports a duplicate CAS miss as duplicate, never as a second confirm", async () => {
    mockConfirmPayoutSettlement.mockResolvedValue({
      applied: false,
      row: predictionRow({ status: "confirmed" }),
    });
    const { deps } = buildDeps();

    expect(await settle(predictionRow(), deps)).toBe("duplicate");
  });

  it("reports a still-pending CAS miss as pending, so the sweep re-checks it", async () => {
    mockConfirmPayoutSettlement.mockResolvedValue({ applied: false, row: predictionRow() });
    const { deps } = buildDeps();

    expect(await settle(predictionRow(), deps)).toBe("pending");
  });

  it("renders the human amount from the ROW's persisted decimals, never a hardcoded scale", async () => {
    const { deps } = buildDeps();

    await settle(predictionRow({ tokenOutDecimals: 9 }), deps);

    expect(mockConfirmPayoutSettlement.mock.calls[0]![1]).toMatchObject({
      executedAmountOutRaw: "4545860",
      executedAmountOutHuman: "0.00454586",
    });
  });
});
