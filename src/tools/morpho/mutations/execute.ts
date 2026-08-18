/**
 * The CHAIN-SIDE orchestration of a real Morpho vault operation: everything that
 * has to be true before a leg may be signed, and the post-state arithmetic that
 * says whether what landed matches what was priced.
 *
 * WHAT THIS MODULE IS NOT. It does not sign, broadcast, or record. That protocol
 * has exactly one owner and it is
 * `@vex-agent/tools/protocols/morpho/handlers/signed-broadcast.ts`, for the same
 * reason Pendle's header gives: spreading sign+broadcast+record across call
 * sites produces near-identical copies, and "a copy left behind is
 * under-protected with nothing failing to say so". This module also cannot reach
 * that owner - `src/tools/morpho` must not import `src/vex-agent` - and that
 * boundary is what makes the split honest rather than decorative.
 *
 * ── WHY THE PREPARATION IS TWO PHASES, AND NOT ONE ──────────────────────────
 *
 * A deposit pulls the asset through GeneralAdapter1, so until the exact-amount
 * approval EXISTS ON CHAIN the deposit simulates as a revert and cannot be gas
 * estimated at all (`./preflight.ts` records that reading). A single-phase
 * preparation would therefore have to either skip the simulation for every
 * deposit - throwing away the one check that stops a doomed transaction before
 * it costs gas - or read its revert as a fault and refuse every deposit that
 * needs an approval, which is all of them.
 *
 * So:
 *
 *   PHASE 1 `prepareMorphoVaultExecution` - fresh accrued vault read, the build
 *     and its leg-by-leg decode, and the allowance plan cross-checked against
 *     the SDK. Produces the numbers the intent rows are written from. Nothing
 *     has been signed and every failure here is a clean pre-broadcast refusal.
 *
 *   [the caller stages and broadcasts the approval legs, and awaits a DEFINITIVE
 *    receipt for each]
 *
 *   PHASE 2 `prepareMorphoOperationLeg` - REBUILD against state as it now is,
 *     decode it again, bound its gas with Vex's own headroom, and simulate. A
 *     revert here ABORTS: the deposit is never broadcast.
 *
 * The rebuild in phase 2 is deliberate and is not a wasted call. Between the two
 * phases a transaction of ours has landed and the vault has accrued; the
 * transaction that gets signed must be built from the state it will actually
 * meet, not from the state that was current when the plan was drawn.
 *
 * ── WHY AN AMBIGUOUS SIMULATION ALSO ABORTS ─────────────────────────────────
 *
 * `./preflight.ts` returns a THREE-way verdict on purpose, and this module keeps
 * the three apart: a proven revert and an unanswered node get different error
 * codes and different words, because claiming a provider refused when it merely
 * did not answer is the invented-refusal failure rules/90 names. They do share
 * an outcome - neither one broadcasts - and that is the conservative reading a
 * money path owes: an operation Vex cannot prove would land is not one it spends
 * the user's gas discovering.
 *
 * ── THE RESIDUAL ALLOWANCE, NAMED RATHER THAN HIDDEN ────────────────────────
 *
 * The owner's policy accepted non-atomicity explicitly: two transactions behind
 * one consent, so a failure after a landed approval leaves a standing allowance.
 * It is bounded to EXACTLY one operation's amount, and `describeResidualAllowance`
 * below is how the failure output says so, in the wallet's own units, with the
 * two ways out named. A residual the user is not told about is the same fact
 * with the remediation removed.
 */

import type { Address, Hex } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import { getMorphoActionClient, type MorphoActionClient } from "./client.js";
import { readMorphoVaultState, type MorphoVaultState } from "./vault-state.js";
import { buildMorphoVaultOperation } from "./build.js";
import {
  crossCheckMorphoAllowancePlan,
  planMorphoAllowance,
  type MorphoAllowancePlan,
} from "./allowance-plan.js";
import {
  boundMorphoGas,
  preflightMorphoTransaction,
  probeMorphoReceiptCapability,
  type MorphoGasBound,
  type MorphoPreflight,
} from "./preflight.js";
import type { MorphoBundleReport, MorphoVaultDirection } from "./types.js";

export interface MorphoExecutionRequest {
  readonly chainId: number;
  readonly vaultAddress: Address;
  readonly direction: MorphoVaultDirection;
  /** The ASSET amount, in raw base units. Never a share count. */
  readonly amountRaw: bigint;
  /** Price protection. Resolved by the caller; this layer holds no default. */
  readonly slippageBps: number;
  /** The wallet that will actually sign. Never optional on an execution. */
  readonly walletAddress: Address;
}

/** Phase 1's result: everything the durable intent rows are written from. */
export interface MorphoPreparedExecution {
  /** The FRESH accrued reading every number below came from. */
  readonly state: MorphoVaultState;
  /**
   * `null` on a withdrawal, which pulls nothing and needs no authorisation.
   * On a deposit this is the ONE owner's answer, already cross-checked.
   */
  readonly allowancePlan: MorphoAllowancePlan | null;
  /** Shares the operation is expected to mint (deposit) or burn (withdrawal). */
  readonly expectedSharesRaw: bigint;
  /** The decode of the transaction as it stood at plan time, for the record. */
  readonly bundle: MorphoBundleReport;
}

/** One ready-to-sign transaction, with the evidence that it should be signed. */
export interface MorphoOperationLeg {
  readonly to: Address;
  readonly data: Hex;
  /** Always `0n` for every vault shape this lane builds. Carried explicitly. */
  readonly value: bigint;
  readonly bundle: MorphoBundleReport;
  /** Vex's own bound, computed from a fresh estimate. Never a provider's hint. */
  readonly gas: MorphoGasBound;
  /** Always `ok` by the time this is returned; the other two verdicts throw. */
  readonly preflight: MorphoPreflight;
}

/**
 * PHASE 1. Read the vault fresh, build and decode the operation, and resolve the
 * allowance work it needs.
 *
 * It also runs the ONE check that is about the node rather than the operation:
 * {@link requireMorphoReceiptCapability}. See its own comment for why a node
 * that will not serve receipts must stop an execution here, where the cost of
 * stopping is zero, rather than after a leg has been signed and mined.
 *
 * @throws {VexError} `MORPHO_VAULT_NOT_FOUND` when neither vault reader
 * answered, `MORPHO_BUNDLE_REJECTED` when the built transaction does not survive
 * the decode, `MORPHO_APPROVAL_POLICY_VIOLATION` when the allowance plan and the
 * SDK disagree or the SDK asks for something outside the policy,
 * `MORPHO_RPC_ERROR` when the allowance itself could not be read or when the
 * node refuses `eth_getTransactionReceipt`.
 */
export async function prepareMorphoVaultExecution(
  request: MorphoExecutionRequest,
  options: { client?: MorphoActionClient } = {},
): Promise<MorphoPreparedExecution> {
  requirePositiveAmount(request);

  const client = options.client ?? getMorphoActionClient(request.chainId);
  await requireMorphoReceiptCapability(client);
  const state = await readMorphoVaultState(client, request.chainId, request.vaultAddress);
  const built = await buildMorphoVaultOperation(client, state, {
    chainId: request.chainId,
    direction: request.direction,
    amountRaw: request.amountRaw,
    slippageBps: request.slippageBps,
    userAddress: request.walletAddress,
  });

  let allowancePlan: MorphoAllowancePlan | null = null;
  if (request.direction === "deposit") {
    allowancePlan = await planMorphoAllowance(client, {
      chainId: request.chainId,
      assetAddress: state.assetAddress,
      walletAddress: request.walletAddress,
      requiredAmountRaw: request.amountRaw,
    });
    crossCheckMorphoAllowancePlan(allowancePlan, built.sdkRequirements);
  }

  return {
    state,
    allowancePlan,
    expectedSharesRaw: state.toShares(request.amountRaw),
    bundle: built.bundle,
  };
}

/**
 * PHASE 2. Rebuild the operation against state as it stands NOW, decode it,
 * bound its gas, and simulate it. Returns only a transaction the node proved
 * would not revert.
 *
 * `state` is re-read here rather than reused from phase 1 on purpose: the
 * approval legs have landed since, and the accrued share price the transaction
 * will meet is the current one.
 *
 * @throws {VexError} `MORPHO_PREFLIGHT_REVERTED` when the node PROVED a revert,
 * `MORPHO_PREFLIGHT_UNPROVEN` when it did not answer, plus every throw
 * `buildMorphoVaultOperation` can raise. In all cases NOTHING has been signed or
 * broadcast for this leg.
 */
export async function prepareMorphoOperationLeg(
  request: MorphoExecutionRequest,
  options: { client?: MorphoActionClient } = {},
): Promise<MorphoOperationLeg> {
  requirePositiveAmount(request);

  const client = options.client ?? getMorphoActionClient(request.chainId);
  const state = await readMorphoVaultState(client, request.chainId, request.vaultAddress);
  const built = await buildMorphoVaultOperation(client, state, {
    chainId: request.chainId,
    direction: request.direction,
    amountRaw: request.amountRaw,
    slippageBps: request.slippageBps,
    userAddress: request.walletAddress,
  });

  const to = built.tx.to as Address;
  const data = built.tx.data as Hex;
  const value = built.tx.value ?? 0n;

  const [gas, preflight] = await Promise.all([
    boundMorphoGas(client, built.tx, request.walletAddress, request.direction),
    preflightMorphoTransaction(client, built.tx, request.walletAddress, request.direction),
  ]);

  if (preflight.verdict === "reverted") {
    throw new VexError(
      ErrorCodes.MORPHO_PREFLIGHT_REVERTED,
      `Refusing to send the Morpho ${request.direction}: the node simulated it against current state and proved it `
      + `reverts. Reason: ${preflight.revertReason ?? "the node reported a revert with no reason attached"}.`,
      "NOTHING was signed or sent for this step, so no gas was spent on it. This is a definitive refusal from the "
      + "chain rather than a transient failure: re-quote and check the amount, the vault's own deposit or withdrawal "
      + "gating, and the wallet's balance before trying again.",
    );
  }
  if (preflight.verdict === "transport-ambiguous") {
    throw new VexError(
      ErrorCodes.MORPHO_PREFLIGHT_UNPROVEN,
      `Refusing to send the Morpho ${request.direction}: the node did not answer the simulation, so whether this `
      + "transaction would succeed is UNKNOWN. Vex does not spend the wallet's gas finding out.",
      "NOTHING was signed or sent for this step. This is a gap in the check rather than a verdict on the operation: "
      + "retry it, and if the node keeps refusing to simulate, report the RPC rather than the vault.",
    );
  }

  return { to, data, value, bundle: built.bundle, gas, preflight };
}

/**
 * Refuse the whole execution when the node will not serve
 * `eth_getTransactionReceipt`.
 *
 * ── WHY THIS IS A HARD STOP AND NOT A WARNING (funded live probe, 2026-08-17) ─
 *
 * The pinned Base endpoint refused that one method, method-level, for a
 * head-block transaction. Everything upstream worked: the build, the decode, the
 * gas bound, the staging and the broadcast all behaved correctly against real
 * Base state, and a real ERC-20 approval for 0.2 USDC MINED. It still ended
 * `unproven`, because the confirm read could not be answered, and the deposit it
 * existed to enable was abandoned. The user paid gas for a leg no part of the
 * system could prove, and was left with a standing allowance.
 *
 * Against such a node EVERY write has that ending, so there is no amount of
 * retrying, waiting or care that reaches a confirmed outcome. Continuing would
 * be spending the user's funds on a result Vex already knows it cannot read.
 * Stopping here costs exactly nothing: no signature exists yet, no durable row
 * exists yet, and no gas has been touched.
 *
 * ONLY A STATED REFUSAL STOPS US. `probeMorphoReceiptCapability` returns
 * `unproven` for an empty block or a transport that did not answer, and those
 * pass through: a check that could not run is a gap, never a verdict, and
 * blocking a healthy deposit on a momentary transport failure would be its own
 * defect.
 *
 * @throws {VexError} `MORPHO_RPC_ERROR` when the node stated the refusal.
 */
async function requireMorphoReceiptCapability(client: MorphoActionClient): Promise<void> {
  const capability = await probeMorphoReceiptCapability(client);
  if (capability.verdict !== "refuses") return;

  throw new VexError(
    ErrorCodes.MORPHO_RPC_ERROR,
    "Refusing to start this Morpho vault operation: the configured RPC for this chain will not answer "
    + `eth_getTransactionReceipt. Asked about a transaction from the chain's own latest block${
      capability.probedTxHash === null ? "" : ` (${capability.probedTxHash})`
    }, it refused the method: ${capability.detail ?? "no reason given"}.`,
    "This RPC cannot confirm transactions; NO FUNDS WERE SPENT and nothing was signed, staged or sent. Vex stops "
    + "before the first broadcast because against this node every transaction it sends would mine and still end "
    + "unproven, leaving real gas spent on a result nothing could read. Point this chain at an RPC that serves "
    + "receipts and run the operation again.",
  );
}

/**
 * The per-operation share bound the settlement is judged against,
 * derived from the slippage the user actually approved.
 *
 * ── WHY THIS REPLACED A FIXED 1e-9-SHARE TOLERANCE (coordinator ruling,
 * 2026-08-17) ───────────────────────────────────────────────────────────────
 *
 * The previous bound was one billionth of a whole share, and the fork run of
 * 2026-08-17 measured a 1 USDC deposit settling 1.0106e-9 shares from its quote:
 * just outside it. That drift is NOT rounding. It is dominated by the interest
 * the vault ACCRUES between the block the quote was read at and the block the
 * transaction settled in, so it grows with both the delay and the position, and
 * an ordinary healthy deposit tripped the alarm routinely. A warning that fires
 * on every success teaches the agent to ignore warnings, which is worse than no
 * warning at all.
 *
 * ── WHAT THE BOUND IS NOW ───────────────────────────────────────────────────
 *
 * The SAME bound the chain itself enforces. `./build.ts` raises the vault's
 * current share price by the approved basis points and holds the built
 * transaction's `maxSharePrice` at or below that ceiling; a deposit that pays
 * more than that ceiling per share CANNOT mine. Read the other way round, the
 * worst share count the approved transaction can legally return is
 * `quoted * 10000 / (10000 + bps)`, and that is this floor.
 *
 * ── WHAT IT DOES AND DOES NOT SCALE WITH, STATED PLAINLY ────────────────────
 *
 * IT DOES SCALE WITH SIZE. `morphoShareBoundRaw` is proportional to `quotedRaw`,
 * and `share-bound.test.ts` pins exactly that: double the quote and the bound
 * doubles. Any comment claiming otherwise is wrong, and one used to.
 *
 * That is not the property rule 90 asks for and it is not a defect here,
 * because this is not a tolerance Vex invented to make a comparison pass. It is
 * a per-share PRICE bound, and a price bound necessarily applies to whatever
 * size is traded - which is precisely how the on-chain guard behaves. The chain
 * enforces `maxSharePrice` on this same operation; a settlement worse than this
 * floor is a settlement the transaction itself would have refused to mine.
 * Restating the chain's own guard cannot be looser than the chain.
 *
 * What rule 90 actually forbids is a tolerance that stretches to cover whatever
 * turns up, so that a bigger loss passes because the loss itself was bigger.
 * This bound cannot do that. It is computed ONCE, from the QUOTE and the
 * basis points the user approved, BEFORE the settlement is known, and nothing
 * about what settles can widen it.
 *
 * ── DIRECTION MATTERS AND IS NOT SMOOTHED OVER ──────────────────────────────
 *
 * A deposit MINTS shares, so a worse-than-approved outcome is FEWER shares than
 * the floor. A withdrawal BURNS them, so fewer is better and a floor would flag
 * every good withdrawal; the worse-than-approved outcome there is MORE shares
 * burned than the mirrored ceiling. A withdrawal also has no on-chain
 * share-price leg at all (`./build.ts` returns a null ceiling for it), so its
 * bound is Vex's own report rather than something the chain refused, and
 * {@link compareMorphoShares} says so in its own words.
 */
export function morphoShareBoundRaw(
  quotedRaw: bigint,
  slippageBps: number,
  direction: MorphoVaultDirection,
): bigint {
  const bps = BigInt(Math.max(0, Math.trunc(slippageBps)));
  const denominator = 10_000n;
  return direction === "deposit"
    ? (quotedRaw * denominator) / (denominator + bps)
    : (quotedRaw * (denominator + bps)) / denominator;
}

export interface MorphoSharesVerdict {
  /** True when the settlement is no worse than the approved bound. */
  readonly withinApprovedBound: boolean;
  readonly quotedRaw: string;
  /** What the receipt PROVED, never what was hoped for. */
  readonly actualRaw: string;
  /** The raw quoted-vs-settled difference. DATA, not a verdict. */
  readonly accrualDriftRaw: string;
  /**
   * The bound the approved slippage allows for THIS operation, in raw shares.
   * Derived once from the quote and the approved bps, so it is proportional to
   * the quoted size (as the chain's own per-share guard is) but cannot widen to
   * fit whatever settled.
   */
  readonly approvedBoundRaw: string;
  /** Which way the bound binds: a floor on a mint, a ceiling on a burn. */
  readonly boundSide: "minimum_shares_received" | "maximum_shares_burned";
  readonly slippageBps: number;
  readonly shareDecimals: number;
  readonly note: string;
}

/**
 * Judge the shares the settlement PROVED against the bound the approved
 * slippage allows, and report the raw quoted-vs-settled difference beside it as
 * accrual drift.
 *
 * TWO NUMBERS, TWO MEANINGS, DELIBERATELY NOT COLLAPSED. `withinApprovedBound`
 * is the verdict and answers "did the user get what they approved".
 * `accrualDriftRaw` is DATA and answers "how far did the vault move between the
 * quote and the settlement"; it is normal, it grows with delay and size, and it
 * is never by itself a problem. Reporting only the second as if it were the
 * first is what made every ordinary deposit look like a fault.
 *
 * The ACTUAL is always reported either way: a check that only says "within
 * bound" hides the number the user actually received.
 */
export function compareMorphoShares(
  quotedRaw: bigint,
  actualRaw: bigint,
  shareDecimals: number,
  slippageBps: number,
  direction: MorphoVaultDirection,
): MorphoSharesVerdict {
  const bound = morphoShareBoundRaw(quotedRaw, slippageBps, direction);
  const drift = quotedRaw > actualRaw ? quotedRaw - actualRaw : actualRaw - quotedRaw;
  const withinApprovedBound = direction === "deposit" ? actualRaw >= bound : actualRaw <= bound;
  return {
    withinApprovedBound,
    quotedRaw: quotedRaw.toString(),
    actualRaw: actualRaw.toString(),
    accrualDriftRaw: drift.toString(),
    approvedBoundRaw: bound.toString(),
    boundSide: direction === "deposit" ? "minimum_shares_received" : "maximum_shares_burned",
    slippageBps,
    shareDecimals,
    note:
      "Every figure is in raw share units at `shareDecimals`, which is a different scale from the asset's. "
      + "`approvedBoundRaw` is the share count this operation's APPROVED SLIPPAGE allows, derived once from the "
      + "quote and those basis points before the settlement was known. Being a per-share price bound it is "
      + "proportional to the size quoted, exactly as the chain's own `maxSharePrice` guard is; what it cannot do is "
      + "widen to accommodate whatever actually settled. `accrualDriftRaw` is the plain difference between the "
      + "quoted and the settled share count: it is the interest the vault accrued between the block the quote was "
      + "read at and the block this settled in, it grows with both the delay and the position, and on its own it is "
      + "normal rather than a fault. "
      + (direction === "deposit"
        ? "On a deposit the bound is the same one the transaction's own `maxSharePrice` guard enforced ON CHAIN, so a "
          + "settlement below it could not have mined."
        : "A withdrawal carries no on-chain share-price leg, so this bound is Vex's own report on the burn rather "
          + "than something the chain refused."),
  };
}

/**
 * The sentence a failure output owes the user when a landed approval was not
 * consumed by the operation that followed it.
 *
 * Both ways out are named because only one of them is free: a retry SPENDS the
 * allowance on the operation it was granted for, and a reset revokes it at the
 * cost of one transaction. Stating the amount in the wallet's own units is the
 * part that makes it actionable - rules/90, a raw amount travels with the
 * decimals needed to read it.
 */
export function describeResidualAllowance(
  amountHuman: string,
  assetSymbol: string | null,
  spender: string,
): string {
  const asset = assetSymbol ?? "the vault asset";
  return (
    `The approval DID land before this failed, so GeneralAdapter1 (${spender}) can still move ${amountHuman} ${asset} `
    + "from this wallet. It is capped at exactly this one operation's amount, not an open-ended grant. Retrying the "
    + "same deposit consumes it and grants nothing further; leaving it standing is also safe, and it can be revoked "
    + "by approving zero to that same spender."
  );
}

/**
 * The sentence a failure output owes the user when an approval was BROADCAST and
 * its fate could not be established.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM `describeResidualAllowance` (funded live
 * probe, 2026-08-17) ────────────────────────────────────────────────────────
 *
 * `context.residual` is only set once an allowance leg CONFIRMS, which is the
 * right rule for a confirmed one and leaves exactly one hole: an approval that
 * lands and then goes ambiguous at the confirm stage. That is not hypothetical.
 * It is what the funded probe hit, and the wallet was left with 0.2 USDC of real
 * spending authority standing to GeneralAdapter1 while the agent-facing output
 * said only that the vault operation was not attempted. This module's own header
 * already names the standard being missed there: a residual the user is not told
 * about is the same fact with the remediation removed.
 *
 * WHY IT IS HEDGED AND NOT ASSERTED. Vex does not know. Claiming the approval
 * landed would be the invented-certainty failure in the other direction, so the
 * wording says MAY, says why it cannot say more, and gives both remediations
 * anyway, since both are correct whether or not it landed. The amount travels
 * with its own units for the same reason the confirmed sentence carries them.
 */
export function describePossibleResidualAllowance(
  amountHuman: string,
  assetSymbol: string | null,
  spender: string,
): string {
  const asset = assetSymbol ?? "the vault asset";
  return (
    `An approval transaction for exactly ${amountHuman} ${asset} to GeneralAdapter1 (${spender}) was signed and `
    + "broadcast before this went unproven, so that allowance MAY now be standing. Vex could not read the receipt, so "
    + "it does not claim either way. If it did land it is capped at exactly this one operation's amount and grants "
    + `nothing further: retrying the same deposit later consumes it, and approving zero ${asset} to that same spender `
    + "clears it. Neither of those is a reason to re-broadcast THIS transaction, which must not be sent again."
  );
}

function requirePositiveAmount(request: MorphoExecutionRequest): void {
  if (request.amountRaw <= 0n) {
    throw new VexError(
      ErrorCodes.MORPHO_INVALID_RESPONSE,
      `A Morpho vault ${request.direction} needs a positive amount; ${request.amountRaw} raw units is not one.`,
      "Nothing was signed or sent. Send the amount in the vault asset's RAW base units as a whole-number string.",
    );
  }
}
