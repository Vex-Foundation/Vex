/**
 * What Vex TELLS THE AGENT when the landing step refused a Jupiter swap
 * BEFORE broadcast.
 *
 * WHY IT EXISTS — the third instance of one defect, on the venue with the most
 * swap volume. `solana-jupiter/handlers/core.ts` proved nothing had gone
 * on-chain and then told the agent "do not retry until the cause is fixed",
 * naming no cause and no parameter. An autonomous agent's own doctrine on an
 * unexplained refusal is to stop, so it stopped permanently on the single most
 * routine recoverable failure a swap has — a thin pair moving past the
 * tolerance it was quoted at. The EVM counterpart of this module
 * (`tools/evm-chains/pre-sign-revert-refusal.ts`) fixed the same shape on
 * KyberSwap and Uniswap hours earlier; this is deliberately its sibling in
 * reasoning, and deliberately NOT its importer — the chains share no error
 * surface at all.
 *
 * The rule this module encodes (phase-3 plan rule 8, DO NOT BREAK AUTONOMY):
 * a refusal is only safe if it refuses what would actually lose money, says
 * what to change and whether a retry can succeed, and leaves a path the agent
 * can walk with no user present. A refusal an agent cannot act on does not
 * make the system safe; it strands the mission.
 *
 * ── WHERE THE EVIDENCE ACTUALLY IS (measured, 2026-07-25) ───────────────────
 *
 * The obvious substrate is the wrong one. `shared/solana-transaction/
 * program-error-reason.ts` recovers a program's own sentence from an
 * `AnchorError occurred. … Error Message: <text>` log line, and that is how
 * Jupiter LEND rejections become legible. Jupiter's SWAP program does not emit
 * one: six independently sampled live mainnet failures of
 * `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` carrying
 * `InstructionError [n, {Custom: 6001}]` — across both `Route` and `RouteV2`,
 * five different downstream venues — contained NO `Error Message:` line at all.
 * In every one the only error-bearing line was the runtime's own trailer:
 *
 *     Program JUP6Lkb…aV4 failed: custom program error: 0x1771
 *
 * (no `Program log:` prefix — the runtime writes it, not the program). A
 * classifier built on the Anchor-sentence regex would therefore have matched
 * nothing, forever, while looking correct. This module reads the trailer.
 *
 * The structured `meta.err.InstructionError[1].Custom` field would be better
 * still, but it does not exist on this error path: the installed
 * `@solana/web3.js` `SendTransactionError` exposes only `transactionMessage`
 * and `logs` (verified against `node_modules/@solana/web3.js/lib/index.d.ts`),
 * and the structured `err` never reaches us. The logs the node returned WITH
 * the rejection are all there is, and they are enough.
 *
 * ── THE EVIDENCE BAR, AND WHY IT IS SET HERE ────────────────────────────────
 *
 * EVM hands us a decoded revert STRING, so the venue that met it can be
 * identified from the string itself. Solana hands us a NUMBER, and the same
 * number means different things in different programs: `0x1771` is Jupiter's
 * slippage refusal and is simultaneously error 6001 of every other Anchor
 * program on the cluster. Two independent conditions must therefore hold
 * before anything is claimed, and BOTH are load-bearing:
 *
 *   1. THE FAILING PROGRAM IS OUR SWAP PROGRAM. The trailer's program id must
 *      equal the one the `/build` response ITSELF declared for its swap
 *      instruction (`swapInstruction.programId`). This is why no Jupiter
 *      program id is hardcoded in this file: the response we signed names the
 *      program that enforces `otherAmountThreshold`, so the binding cannot go
 *      stale when Jupiter ships a new router, and a log line from some other
 *      program in the same transaction cannot impersonate it.
 *
 *   2. NOTHING ELSE FAILED. Solana propagates a CPI's `Custom(N)` up through
 *      the caller unchanged, so a downstream DEX failing with ITS OWN error
 *      6001 (a CLMM tick-range refusal, say — Jupiter documents this class)
 *      would surface `0x1771` on Jupiter's trailer too, meaning something
 *      entirely different. In all six sampled genuine slippage failures every
 *      nested CPI reported `success`; the guard is Jupiter's own post-route
 *      check, not an inner program's. So if ANY other program also failed with
 *      a custom error, the number is not attributable and we decline.
 *
 * NOTHING IS ADDED HERE FROM MEMORY — the same discipline
 * `evm-chains/router-revert-reason.ts` states for its revert strings, and for
 * the same reason: a wrong row sends an autonomous agent to fix the wrong
 * parameter.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * It does not classify the `/tx/v1/submit` lane. That endpoint DOES NOT
 * SIMULATE — it forwards straight to the TPU, answers `200 {signature}`, and a
 * transaction that will fail on slippage simply lands FAILED on-chain with the
 * fee spent. There is no pre-broadcast refusal to catch there at all; its only
 * `rejected_before_broadcast` outcome is a definitive 4xx (e.g. missing tip),
 * which arrives as an HTTP error carrying no Solana program logs. This
 * classifier answers `null` for it and the handler keeps its conservative
 * wording. That is the correct outcome, not a gap: a remedy invented for an
 * unidentified refusal is exactly the failure this module exists to remove.
 *
 * It does not scrub. `rejectionReason` MUST already have crossed the caller's
 * scrub boundary (C37: one scrub entry point per venue, never a fork) —
 * `staged-broadcast.ts` has already put it through `summarizeProtocolError`.
 *
 * It does not carry the EVM message's `priceImpact` exception clause. That
 * clause exists because `vex-agent/engine/prompts/protocols.ts` ships a
 * KyberSwap-specific caution — "a quote whose priceImpact is strongly NEGATIVE
 * (output supposedly worth more than input) … do NOT retry with higher
 * slippage" — and a refusal contradicting shipped guidance would be worse than
 * none. It does not transfer to Jupiter, because the two venues report price
 * impact with OPPOSITE SIGNS. KyberSwap derives it as
 * `(inUsd - outUsd) / inUsd` (`protocols/kyberswap/helpers.ts`), so negative
 * means the anomaly. Jupiter's is negative in the ORDINARY case: the repo's own
 * captured healthy quote is `priceImpactPct: "-0.00015864212550172836"`
 * (`solana-jupiter/swap-route-projector.ts`, pinned by its test). Copying the
 * clause would tell the agent that every normal Jupiter swap is priced off
 * stale reserves. No Jupiter-specific equivalent is invented in its place —
 * there is no shipped instruction and no captured evidence to support one.
 */

import { SendTransactionError } from "@solana/web3.js";

/**
 * The one condition this module can identify. A single-member `kind` on
 * purpose: everything else stays `null` and keeps the handler's conservative
 * wording, so widening the set is a deliberate edit with its own evidence
 * rather than a default.
 */
export interface JupiterPreBroadcastRejection {
  readonly kind: "slippage";
  /**
   * The Anchor error number OUR table matched. Our own value — never
   * chain-authored text.
   *
   * The upstream NAME for this number is deliberately NOT a field here. It
   * lives only in {@link JUPITER_SWAP_PROGRAM_ERROR_TABLE}, and
   * `jupiterPreBroadcastRefusalGuidance` looks it up. A caller-suppliable name
   * is a caller-OMITTABLE name: while it was one, a test literal that left it
   * out put the literal string "undefined" into agent-facing money-path text,
   * and root `tsc` could not catch it because `tsconfig.json` excludes
   * `src/__tests__`. Deriving it makes that unreachable by construction.
   */
  readonly anchorErrorNumber: number;
}

/** The tolerance this attempt actually applied, and the ceiling a retry may not exceed. Both are quoted to the agent — a remedy without numbers is not actionable. */
export interface JupiterSwapSlippageBounds {
  /** `null` when the request named none and the venue applied its own default — stated as such, never guessed at. */
  readonly appliedBps: number | null;
  readonly maxBps: number;
}

/**
 * Jupiter Swap Program error numbers whose meaning Vex is willing to act on.
 *
 * `SlippageToleranceExceeded` is error 6001 (`0x1771`) of the Jupiter Swap
 * Program's Anchor error enum — raised when the route's realised output is
 * below the `otherAmountThreshold` written into the transaction Vex signed.
 * Verified twice over: against the published Jupiter aggregator IDL error list
 * (`code: 6001, name: "SlippageToleranceExceeded", msg: "Slippage tolerance
 * exceeded"`), and against Jupiter's own live "common errors" table, which
 * lists 6001 as `SlippageToleranceExceeded`. Six live mainnet failures carrying
 * `Custom: 6001` were sampled while writing this.
 *
 * ONLY this one is listed. Its near-neighbours in the same enum are real and
 * are deliberately absent, because none of them is answered by widening
 * tolerance: 6000 `EmptyRoute`, 6002 `InvalidCalculation`, 6004
 * `InvalidSlippage`, 6005 `NotEnoughPercent`, 6016 `SwapNotSupported`, 6017
 * `ExactOutAmountNotMatched`. Mapping any of them to "raise your tolerance"
 * would be advice that cannot work.
 */
interface JupiterSwapProgramError {
  readonly kind: JupiterPreBroadcastRejection["kind"];
  /** The upstream Anchor error name, so the agent is told a fact instead of a hex code. */
  readonly name: string;
}

const JUPITER_SWAP_PROGRAM_ERROR_TABLE: ReadonlyMap<number, JupiterSwapProgramError> = new Map([
  [6001, { kind: "slippage", name: "SlippageToleranceExceeded" }],
]);

/**
 * The runtime's own verdict line, emitted once per failing program:
 *
 *   `Program JUP6Lkb…aV4 failed: custom program error: 0x1771`
 *
 * Deliberately anchored to the whole line and WITHOUT a `Program log:` prefix —
 * the runtime writes this, a program cannot, so a hostile `msg!()` cannot forge
 * one. Hex is matched case-insensitively because the casing is the runtime's
 * choice, not a contract.
 */
const PROGRAM_FAILED_WITH_CUSTOM_ERROR = /^Program (\S+) failed: custom program error: 0x([0-9a-f]+)$/i;

interface ProgramCustomFailure {
  readonly programId: string;
  readonly errorNumber: number;
}

/** Every `Program <id> failed: custom program error: 0x…` line, in log order. */
function programCustomFailures(logs: readonly string[]): ProgramCustomFailure[] {
  const failures: ProgramCustomFailure[] = [];
  for (const line of logs) {
    const match = PROGRAM_FAILED_WITH_CUSTOM_ERROR.exec(line.trim());
    if (!match) continue;
    failures.push({ programId: match[1]!, errorNumber: Number.parseInt(match[2]!, 16) });
  }
  return failures;
}

/**
 * Classify a PRE-BROADCAST rejection as a Jupiter swap-program refusal we can
 * name, or `null` when it is not one.
 *
 * `null` means "this is not a refusal we can place", and the caller MUST fall
 * back to its own conservative wording — never to a remedy, which is only
 * honest for a cause we identified. A non-`SendTransactionError` throw (the
 * HTTP landing lane's 4xx, a transport failure) is always `null`: only the node
 * returns program logs.
 *
 * @param swapProgramId the program the `/build` response declared for its swap
 * instruction. An empty value never matches — a blank binding would make the
 * program check vacuous, which is the whole safeguard.
 */
export function classifyJupiterPreBroadcastRejection(
  err: unknown,
  swapProgramId: string,
): JupiterPreBroadcastRejection | null {
  if (swapProgramId.length === 0) return null;
  if (!(err instanceof SendTransactionError)) return null;

  const logs = err.transactionError.logs;
  if (!logs) return null;

  const failures = programCustomFailures(logs);
  // Condition 2 (see the file header): a custom error from any OTHER program
  // may have been propagated up through the swap program unchanged, so the
  // number on our trailer would not be the swap program's own verdict.
  if (failures.some((failure) => failure.programId !== swapProgramId)) return null;

  for (const failure of failures) {
    const known = JUPITER_SWAP_PROGRAM_ERROR_TABLE.get(failure.errorNumber);
    if (known) return { kind: known.kind, anchorErrorNumber: failure.errorNumber };
  }
  return null;
}

/**
 * Which tolerance number the agent is shown.
 *
 * The `/build` response echoes back the `slippageBps` it actually applied,
 * which is better evidence than what we asked for — an omitted request takes
 * the venue's own default, and only the response knows what that was. It is
 * provider-controlled and therefore untrusted: it is display-only here, but a
 * fractional, negative or non-finite value would read to the agent as a Vex
 * bug, so it is dropped in favour of the requested value rather than quoted.
 *
 * `null` means neither is known — the guidance then says the request named
 * none, instead of printing a default this process never observed.
 */
export function appliedSlippageBps(input: {
  readonly providerEchoedBps: number | undefined;
  readonly requestedBps: number | undefined;
}): number | null {
  if (isQuotableBps(input.providerEchoedBps)) return input.providerEchoedBps;
  if (isQuotableBps(input.requestedBps)) return input.requestedBps;
  return null;
}

function isQuotableBps(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0;
}

/**
 * The full agent-facing refusal: what is provable, what refused it, and what to
 * do next.
 *
 * ORDER MIRRORS `evm-chains/pre-sign-refusal`'s `preSignRefusalGuidance` —
 * [provable state] → [what refused it, with the reason] → [remedy] — so an
 * agent that met this shape on KyberSwap or Uniswap reads it the same way here,
 * and the answer-bearing content sits ahead of the boilerplate as the phase-3
 * acceptance line requires.
 *
 * The decoded error NAME rides in the refusal clause because the node's own
 * text is not usable alone: web3.js renders this failure as "Simulation failed.
 * Message: … custom program error: 0x1771. Logs: […]. Catch the
 * `SendTransactionError` and call `getLogs()`…", of which the scrub boundary
 * and the 200-char cap leave an undecodable hex code beside an instruction this
 * process cannot follow. The name is looked up from
 * {@link JUPITER_SWAP_PROGRAM_ERROR_TABLE} rather than taken from the caller,
 * and the clause is OMITTED WHOLESALE when the lookup misses — printing the
 * word "undefined" into a money-path message is the failure mode this shape
 * exists to make unreachable.
 *
 * `rejectionReason` MUST already have crossed the caller's scrub boundary
 * (C37) — this module never redacts, because forking a second scrub is exactly
 * what that contract forbids.
 */
export function jupiterPreBroadcastRefusalGuidance(input: {
  readonly rejectionReason: string;
  readonly rejection: JupiterPreBroadcastRejection;
  readonly slippage: JupiterSwapSlippageBounds;
}): string {
  return `this swap was rejected before broadcast — nothing went on-chain, so no funds moved, no network fee was spent, and re-running cannot duplicate it. `
    + `The swap program${refusedWithPhrase(input.rejection.anchorErrorNumber)}: ${terminated(input.rejectionReason)} `
    + remedyFor(input.rejection.kind, input.slippage);
}

/**
 * " refused it with SlippageToleranceExceeded (custom program error 0x1771)",
 * or a bare " refused it" when the number has no row. Never interpolates a
 * lookup that missed.
 */
function refusedWithPhrase(anchorErrorNumber: number): string {
  const known = JUPITER_SWAP_PROGRAM_ERROR_TABLE.get(anchorErrorNumber);
  return known === undefined
    ? " refused it"
    : ` refused it with ${known.name} (custom program error 0x${anchorErrorNumber.toString(16)})`;
}

/**
 * The remedy, in the agent's own vocabulary: the parameter to change, the
 * value this attempt used, the ceiling, and the cost of raising it.
 */
function remedyFor(kind: JupiterPreBroadcastRejection["kind"], slippage: JupiterSwapSlippageBounds): string {
  switch (kind) {
    case "slippage":
      return `That is the price guard doing its job: the pool moved past otherAmountThreshold — the minimum output written into the transaction this quote produced — between the quote and the submit. `
        + `Re-quote and retry with a higher slippageBps — ${appliedTolerancePhrase(slippage.appliedBps)}, and Vex rejects anything above ${slippage.maxBps} rather than clamping it. `
        + `Raise it in steps; every increase widens the worst-case price you accept.`;
  }
}

function appliedTolerancePhrase(appliedBps: number | null): string {
  return appliedBps === null
    ? "this attempt set no slippageBps of its own, so the venue applied its default"
    : `this attempt used ${appliedBps}`;
}

/**
 * One sentence terminator, whatever punctuation the provider's own text
 * carried. A scrubbed HTTP reason usually ends bare, an Anchor sentence ends in
 * a full stop, and a reason the scrub boundary TRUNCATED ends in "…", which is
 * left to speak for itself.
 */
function terminated(text: string): string {
  const trimmed = text.trim().replace(/\.+$/, "");
  return trimmed.endsWith("…") ? trimmed : `${trimmed}.`;
}
