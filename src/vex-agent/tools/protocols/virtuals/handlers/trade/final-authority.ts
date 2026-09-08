/**
 * THE LAST GATE BEFORE THE KEY on a Virtuals curve trade.
 *
 * ## Why a second authority check exists at all
 *
 * `virtuals.trade.execute` holds the whole authority table against the sealed
 * snapshot before it resolves a signing key. That check is necessary and it is
 * NOT sufficient, for two reasons the arc's final review measured:
 *
 *  1. IT RUNS ON THE FALLBACK READER. The reads that decide whether a signature
 *     may happen were taken through `buildEvmTransport` - a viem `fallback` over
 *     the whole endpoint list - while the transaction is prepared, signed and
 *     broadcast through the PINNED endpoint (`buildPinnedEvmTransport`). A tax,
 *     a proxy implementation or a lifecycle flag proven on one node is not
 *     proven on the node that will execute the bytes.
 *  2. IT RUNS BEFORE THE ALLOWANCE LEGS. An approval takes block time - tens of
 *     seconds on Base, and unbounded when the node is slow. Everything the first
 *     check proved is therefore stale by the time the trade itself is signed:
 *     the FFactoryV2 tax can be raised, the BondingV5 or FRouterV3 proxy can be
 *     upgraded, the agent can graduate, and the approved quote can expire. The
 *     sell's gross floor does not protect the wallet from any of that - it
 *     bounds the router's output BEFORE the curve's taxes, so a raised tax takes
 *     its increase out of the wallet's net with the floor intact.
 *
 * So the authority table is re-read HERE, through the pinned signing reader, at
 * the moment the key is about to be used and after every dependent approval has
 * mined. This is MetaMask's `beforePublish` position exactly
 * (`TransactionController.ts:3148` - the transaction is re-fetched after signing
 * and a hook may still refuse to publish), moved one step earlier to before the
 * signature because Vex can refuse there and a browser extension's flow cannot.
 * Rabby's rule that the confirmation names the exact bytes and the signing path
 * builds from that object rather than from the caller's request
 * (`provider/controller.ts:686-745`) is why {@link assertCurveTradeFinalAuthority}
 * also asserts the FINAL PREPARED REQUEST against the planned calldata: the
 * subject of a pre-sign gate must be what will be signed, never what was asked.
 *
 * ## What it refuses, and what it deliberately does not
 *
 * Refuses BY NAME: an expired proposal, a state the pinned node cannot read, a
 * lifecycle change (graduated, trading disabled, not a curve token), an upgraded
 * implementation, a changed tax setup, a changed amount, a changed fee policy,
 * an anti-sniper percent above the accepted bound, a curve that can no longer
 * reach the sealed floor, and calldata that is not the calldata this execution
 * planned.
 *
 * Does NOT refuse: a moved price inside the sealed floor, a decayed anti-sniper
 * percent inside the accepted bound, or a moved SELL fee estimate - all three
 * are expected movement the approval already covers, and refusing them would
 * make every quote unexecutable rather than safer.
 *
 * A refusal from here means NOTHING WAS SIGNED: `signStageBroadcast` runs this
 * as `onBeforeSign`, whose throw aborts before the key is used and before any
 * bytes exist.
 */

import type { Address } from "viem";

import {
  readCurveQuote,
  readCurveState,
  type BuiltCurveTx,
  type CurveStateClient,
} from "@tools/virtuals/curve/index.js";
import type { AgentActivityFailureCode } from "@vex-agent/db/repos/agent-activity.js";
import type { FinalSignedRequest } from "@tools/evm-chains/staged-broadcast.js";
import {
  antiSniperBoundExceededRefusal,
  compareVirtualsExecutionInputs,
  floorUnreachableRefusal,
  type VirtualsExecutionSnapshot,
} from "@vex-agent/tools/protocols/quote-authority/virtuals.js";

import type { TradeParams } from "./params.js";
import { buyTaxedInFor, executionInputsFrom, human, priceCurveTrade } from "./pricing.js";

/** The bounded classes this gate refuses in. Never provider text. */
export type CurveFinalAuthorityKind =
  | "quote_expired"
  | "state_unreadable"
  | "lifecycle_changed"
  | "route_not_found"
  | "anti_sniper_bound_exceeded"
  | "drift"
  | "floor_unreachable"
  | "calldata_changed";

/**
 * A refusal at the last gate. Thrown so that `signStageBroadcast` aborts before
 * the signature; carries the agent-facing sentence and the durable failure code
 * so the leg is terminalized as what it was rather than as an unknown revert.
 */
export class CurveFinalAuthorityError extends Error {
  readonly kind: CurveFinalAuthorityKind;
  readonly failureCode: AgentActivityFailureCode;
  /** The whole agent-facing sentence, already ending in "Nothing was signed". */
  readonly refusal: string;

  constructor(input: {
    readonly kind: CurveFinalAuthorityKind;
    readonly failureCode: AgentActivityFailureCode;
    readonly refusal: string;
  }) {
    super(input.refusal);
    this.name = "CurveFinalAuthorityError";
    this.kind = input.kind;
    this.failureCode = input.failureCode;
    this.refusal = input.refusal;
  }
}

const NOTHING_SIGNED =
  "Nothing was signed and nothing was re-cut to make the trade fit; any approval this execution already mined stands.";

function refuse(
  kind: CurveFinalAuthorityKind,
  failureCode: AgentActivityFailureCode,
  what: string,
): never {
  throw new CurveFinalAuthorityError({
    kind,
    failureCode,
    refusal: `Refused at the final signing check: ${what} ${NOTHING_SIGNED}`,
  });
}

export interface CurveFinalAuthorityInput {
  /** The PINNED signing reader - the same node that will broadcast these bytes. */
  readonly client: CurveStateClient;
  /** The sealed snapshot the human approved. The only authority here. */
  readonly approved: VirtualsExecutionSnapshot;
  readonly params: TradeParams;
  readonly wallet: Address;
  /** The calldata this execution planned for the trade leg. */
  readonly plannedTx: BuiltCurveTx;
  /** What `signStageBroadcast` is about to serialize. */
  readonly request: FinalSignedRequest;
  /**
   * The clock, READ EACH TIME rather than sampled once.
   *
   * A single `nowMs` would be the defect this seam exists to make testable: the
   * gate awaits the pinned node twice after its first expiry check, and the
   * proposal's deadline keeps running through both round trips. Injectable for
   * tests; `Date.now` in production.
   */
  readonly now?: () => number;
}

/**
 * Re-establish every authority row through the pinned signing reader and refuse
 * by name on any drift. Resolves only when the bytes may be signed.
 *
 * THE ORDER IS DELIBERATE and mirrors the pre-claim walk: the cheapest and most
 * final fact first (has the proposal expired at all), then what the pinned node
 * says the contracts are, then whether the trade still prices inside what was
 * approved, then whether the bytes are the planned bytes - and the deadline
 * ONCE MORE at the very end, because the two reads in the middle are network
 * round trips the proposal's own life keeps running through.
 */
export async function assertCurveTradeFinalAuthority(
  input: CurveFinalAuthorityInput,
): Promise<void> {
  const { approved, params, client } = input;
  const now = input.now ?? Date.now;

  // ── THE PROPOSAL'S OWN DEADLINE, FIRST TIME ──
  //
  // The claim proved the row was unexpired when it was consumed. An allowance
  // leg sits between that moment and this one, so the expiry is re-asserted
  // against the clock HERE. `deadline_expired` is the durable code for exactly
  // this, and it is not an unknown failure.
  //
  // This check is the CHEAP one: it costs nothing and spares the pinned node two
  // round trips for a proposal that is already dead. It is NOT the authoritative
  // one - see the second assertion at the end of this function.
  const expiresAtMs = Date.parse(approved.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    refuse(
      "quote_expired",
      "deadline_expired",
      `the approved quote carries an expiry this build cannot read (${approved.expiresAt}), so it cannot be proven current.`,
    );
  }
  assertUnexpired(
    approved.expiresAt,
    expiresAtMs,
    now(),
    "the approval that preceded it took longer than the quote's own life",
  );

  // ── THE CHAIN, AS THE SIGNING NODE SEES IT ──
  let state: Awaited<ReturnType<typeof readCurveState>>;
  try {
    state = await readCurveState({
      client, deployment: params.deployment, token: params.token, side: params.side, wallet: input.wallet,
    });
  } catch {
    // The class only. A provider payload carries urls, request bodies and auth
    // headers, and this sentence reaches an agent and a durable row (rule 07).
    refuse(
      "state_unreadable",
      "simulation_reverted",
      "the node that would broadcast this trade could not be asked for the curve's state, so the taxes and implementations behind the signature are UNKNOWN rather than unchanged.",
    );
  }
  if (!state.ok) {
    refuse(
      state.code === "implementation_moved" ? "drift" : "lifecycle_changed",
      "simulation_reverted",
      `${state.reason} This was read on the signing node immediately before the signature.`,
    );
  }

  // ── THE PRICE, RE-ASKED AT THAT SAME BLOCK ──
  const amountRaw = params.side === "buy" ? buyTaxedInFor(params, state) : params.amountInRaw;
  const quotedOutRaw = amountRaw <= 0n
    ? null
    : await readCurveQuote({
        client, deployment: params.deployment, token: state.token, side: params.side,
        amountRaw, blockNumber: state.blockNumber,
      });
  if (quotedOutRaw === null || quotedOutRaw <= 0n) {
    refuse(
      "route_not_found",
      "route_not_found",
      `FRouterV3 could not price this ${params.side} at block ${state.blockNumber} on the signing node.`,
    );
  }

  const priced = priceCurveTrade({ params, state, quotedOutRaw });
  if (!priced.ok) {
    const anti = antiSniperBoundExceededRefusal({
      approvedPct: params.acceptAntiSniperTaxPct,
      currentPct: state.antiSniper[params.side === "buy" ? "rawBuyPct" : "rawSellPct"],
      side: params.side,
      remainingSeconds: state.antiSniper.remainingSeconds,
    });
    refuse("anti_sniper_bound_exceeded", "simulation_reverted", `${anti.message} ${anti.hint}`);
  }
  const trade = priced.priced;

  // ── EVERY "YES" ROW OF THE AUTHORITY TABLE, held against the approval ──
  const drift = compareVirtualsExecutionInputs(approved, executionInputsFrom({ params, state, priced: trade }));
  if (drift) {
    refuse("drift", "simulation_reverted", `${drift.message} ${drift.hint}`);
  }

  // ── THE SEALED FLOOR, still reachable ──
  const contractFloorRaw = BigInt(approved.contractFloorRaw);
  if (trade.quotedOutRaw < contractFloorRaw) {
    const unreachable = floorUnreachableRefusal({
      snapshot: approved,
      outSymbol: trade.receiveTokenSymbol,
      outHuman: human(trade.quotedOutRaw, trade.receiveTokenDecimals),
      floorHuman: human(contractFloorRaw, trade.receiveTokenDecimals),
    });
    refuse("floor_unreachable", "slippage", `${unreachable.message} ${unreachable.hint}`);
  }

  // ── THE BYTES THEMSELVES ──
  //
  // Asserted against the REQUEST, not against the object this closure captured:
  // the request is what viem is about to serialize, and a target, a calldata
  // blob or an attached value altered on the preparation path would otherwise be
  // signed under a verdict that never looked at it.
  const planned = input.plannedTx;
  const request = input.request;
  if (
    request.to === null
    || request.to === undefined
    || request.to.toLowerCase() !== planned.to.toLowerCase()
    || request.data !== planned.data
    || request.value !== planned.value
  ) {
    refuse(
      "calldata_changed",
      "simulation_reverted",
      "the transaction about to be signed is not the transaction this execution planned and priced.",
    );
  }

  // ── THE PROPOSAL'S OWN DEADLINE, AND THIS IS THE ONE THAT DECIDES ──
  //
  // Everything above this line was proven against the pinned node, and reaching
  // it took two awaited round trips on a node whose latency Vex does not
  // control. A quote with seconds of life left can therefore pass the first
  // check and lapse inside `readCurveState` or `readCurveQuote`, and every fact
  // established in between would then be attached to an approval that had
  // already expired.
  //
  // So the clock is read once more, AFTER the last awaited operation this gate
  // performs and immediately before it resolves. `signStageBroadcast` awaits
  // nothing that reaches a provider between this return and the signature (the
  // trade leg signs offline), so what is proven here is what the bytes commit
  // to. MetaMask's controller does the structural equivalent: after the
  // `beforeSign` hook and after every awaited step inside signing it RE-READS
  // the transaction and signs `finalTxParams` rather than the object it started
  // with (`TransactionController.ts:3664-3730`).
  assertUnexpired(
    approved.expiresAt,
    expiresAtMs,
    now(),
    "the final authority reads on the signing node themselves outlasted the quote",
  );
}

/**
 * Refuse when the approved proposal's deadline has passed at `nowMs`.
 *
 * Called TWICE by design, and the second call is the authoritative one; `why`
 * names which window consumed the remaining life so the durable row says what
 * actually happened rather than only that a deadline passed.
 */
function assertUnexpired(
  expiresAt: string,
  expiresAtMs: number,
  nowMs: number,
  why: string,
): void {
  if (nowMs < expiresAtMs) return;
  refuse(
    "quote_expired",
    "deadline_expired",
    `the approved quote expired at ${expiresAt}, before this trade reached its signature - ${why}.`,
  );
}
