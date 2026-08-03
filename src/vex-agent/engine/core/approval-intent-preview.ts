/**
 * Approval intent preview + policy snapshot builders.
 *
 * Plan: agents_dm/plan-integration/05-approvals-wallet-policy.md §"Approval DB model".
 *
 * Puzzle 5 phase 2. Approval UI must show enough context for the user to
 * decide (which wallet? which chain? how much? to whom?) WITHOUT exposing
 * raw tool args (Codex 2/1B ruling: "Approval UI pobiera summary z tego
 * DTO, nie surowe tool args").
 *
 * `buildIntentPreview` extracts an allow-listed structured summary from the
 * tool call (`toolName`, optional `namespace`, and a flat `criticalArgs`
 * map of well-known keys like `to`, `amount`, `chain`). Defensive style
 * mirrors `approvals-db.ts:extractToolName` — never recurses, never returns
 * raw blobs, coerces unsafe types (bigint, nested objects, arrays) to
 * conservative substitutes.
 *
 * `buildPolicySnapshot` captures the enqueue-time policy context (permission,
 * sessionKind, missionRunActive, contextUsageBand, plus mission lineage and
 * source surface where available) so phase 3 approve dispatch can validate
 * the snapshot still matches the live context — a permission downgrade
 * between enqueue and approve must be observable.
 */

import type { InternalToolContext } from "../../tools/internal/types.js";
import { resolveInjectedProtocolTool } from "../../tools/registry/injected-protocol-tools.js";
import type { SafetyVerdict } from "../../db/repos/swap-prequotes.js";
import type { JupiterFeePreview } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";
import type { LendBorrowRiskPreview } from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/risk-preview-types.js";

/**
 * Allow-list of `tool_call.arguments` keys eligible for the preview
 * `criticalArgs` map. Each key is one the user typically needs to verify
 * before approving an action (wallet/chain/amount/recipient). Adding a
 * new key requires intentional review — preview is a security boundary.
 */
const PREVIEW_KEY_ALLOWLIST: ReadonlySet<string> = new Set([
  "to",
  "recipient",
  "recipientAddress",
  "destination",
  "amount",
  "amountUsd",
  "amountIn",
  "amountUsdc",
  // Stage 9: swap money/safety leg now BOUND into the prequote identity (it
  // cannot change post-quote). These are normal args, not secrets — surface
  // them so a restricted-mode approval shows where the output lands, the
  // slippage tolerance, and the allowance behavior. (`recipient` is already
  // allow-listed above.)
  "slippageBps",
  "approveExact",
  "chain",
  "chainId",
  "network",
  "token",
  "tokenIn",
  "tokenOut",
  "intentId",
  "marketId",
  "conditionId",
  "outcome",
  "side",
  "size",
  "price",
  "markPrice",
  "minutes",
  "randomize",
  "ntli",
  "toPerp",
  "orderId",
  "fromChain",
  "toChain",
  "fromToken",
  "toToken",
  "query",
  "slPrice",
  "tpPrice",
  "leverage",
  "marginMode",
  "notionalUsd",
  "estLiquidationPx",
  "coin",
  "assetType",
  "vaultAddress",
  "validator",
  "amountWei",
  "maxFeeRate",
  "builder",
]);

/** Max string length stored in `criticalArgs`. Longer values are truncated. */
const MAX_PREVIEW_STRING_LEN = 200;

/**
 * Coerce a value into a JSON-safe scalar for the preview. Returns:
 *   - string truncated to MAX_PREVIEW_STRING_LEN with `…` suffix
 *   - number/boolean/null as-is
 *   - bigint → decimal string (JSON.stringify(bigint) throws)
 *   - any object/array/function/symbol → null (preview never embeds nested)
 */
function coerceSummaryValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return value.length > MAX_PREVIEW_STRING_LEN
      ? `${value.slice(0, MAX_PREVIEW_STRING_LEN)}…`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  return null;
}

export interface IntentPreview {
  /** Tool the user is being asked to approve. Always present. */
  toolName: string;
  /** Optional protocol namespace (e.g. "kyberswap", "polymarket"). */
  namespace?: string;
  /**
   * Flat map of allow-listed argument keys → coerced scalars. Stage 7 also
   * injects a non-arg `safety` key here (sourced from the typed prequote
   * verdict, NOT from raw args) so the renderer's strict
   * `approvalPreviewSchema` — which permits arbitrary scalar `criticalArgs`
   * keys — surfaces the swap safety verdict with zero cross-process schema
   * change. See {@link IntentPreviewExtras}.
   */
  criticalArgs: Record<string, string | number | boolean | null>;
}

/**
 * Typed, non-arg preview enrichment. Stage 7 R5: the swap prequote gate's
 * matched safety verdict reaches the approval preview through THIS channel —
 * never through `args`. `safety` is deliberately NOT in
 * {@link PREVIEW_KEY_ALLOWLIST}, so the LLM cannot spoof it via tool args; the
 * value is injected after allow-list extraction from `prequoteVerdict` only.
 */
export interface IntentPreviewExtras {
  /** Matched prequote safety verdict for a gated swap execute (`pass`/`unknown`). */
  prequoteVerdict?: SafetyVerdict;
  /**
   * Fee-on-transfer tax (percent) of the matched prequote, when any EVM leg is
   * a fee-on-transfer token. Stage 9 doctrine: FoT is no longer a verdict
   * `fail` (only a confirmed honeypot blocks), so a high-tax token reaches the
   * preview as `pass`; this surfaces the tax alongside the verdict so a
   * restricted human still sees it. Sourced ONLY from the typed prequote
   * channel (NOT raw args), so it is unspoofable. Omitted when there is no FoT.
   */
  fotTax?: number;
  /**
   * Pendle term-lock (Wave 5) — the maturity of a PT being bought. Sourced ONLY
   * from the matched prequote's persisted `safetyDetail` (NOT raw args), so the
   * LLM cannot inject or override it (`termLock` is deliberately NOT in
   * PREVIEW_KEY_ALLOWLIST). `buildIntentPreview` renders the FIXED lock warning
   * from `maturityIso` into `criticalArgs.termLock`. Omitted when not a PT buy.
   */
  termLock?: { maturityIso: string };
  /**
   * Jupiter fee-bearing swap disclosure (W5 design §6 R4; Codex batch-4
   * closure blocker C2) — the 25bps fee AND its estimated token amount, fee
   * mint + treasury ATA, ATA rent (if missing), tip, and priority-fee
   * strategy AND lamport estimate. Sourced ONLY from the matched prequote's
   * persisted `safetyDetail` (NOT raw args), so the LLM cannot inject or
   * override it (`feeDisclosure` is deliberately NOT in
   * PREVIEW_KEY_ALLOWLIST). `buildIntentPreview` renders it into
   * `criticalArgs.feeDisclosure`.
   */
  feePreview?: JupiterFeePreview;
  /**
   * Jupiter Lend Borrow LTV/health disclosure (Agent Scan Phase 3 Batch 5,
   * card B1 owner decision: "Approval preview MUST show LTV/health risk
   * semantics before approval") for a `solana.lend.borrowOperate` call.
   * Sourced ONLY from a live vault/position/price read at gate-time (NOT raw
   * args), so it rides this channel (`riskPreview` is deliberately NOT in
   * PREVIEW_KEY_ALLOWLIST). `buildIntentPreview` renders it into
   * `criticalArgs.lendBorrowRisk`. Omitted for every other tool.
   */
  riskPreview?: LendBorrowRiskPreview;
}

/** Render a swap safety verdict for the approval preview's `criticalArgs.safety`. */
function renderSafetyVerdict(verdict: SafetyVerdict): string {
  switch (verdict) {
    case "pass":
      return "pass";
    case "unknown":
      return "UNVERIFIED — audit unavailable";
    case "fail":
      // A `fail` is blocked at the gate and never reaches the approval preview;
      // render defensively if it ever does (must never read as safe).
      return "FAILED — flagged unsafe";
  }
}

/**
 * Resolve the EFFECTIVE preview subject for `execute_tool` — the LLM call
 * is a wrapper (`execute_tool({toolId, params})`), so the user-visible
 * approval must surface the TARGET protocol tool (`toolId`) and the nested
 * `params` as critical args. Internal tools and unknown shapes pass
 * through unchanged.
 *
 * Codex final review puzzle 5/2 (2026-05-23): "Protocol approval preview
 * currently summarizes the wrapper, not the target tool. This is the most
 * important UI/policy summary for user_wallet_broadcast, so it cannot ship."
 */
function resolveEffectiveCall(
  toolName: string,
  args: Record<string, unknown>,
): { toolName: string; args: Record<string, unknown> } {
  // Injected discovered-tool lane (owner decision 2026-08-03): the model calls
  // the manifest directly under its mapped name (`khalani__bridge`), and the
  // arguments ARE the params — there is no envelope to unwrap. The human must
  // still see the dotted toolId, never the wire-safe mapped name.
  const injected = resolveInjectedProtocolTool(toolName);
  if (injected) return { toolName: injected.toolId, args };

  if (toolName !== "execute_tool") return { toolName, args };

  const toolId = typeof args.toolId === "string" ? args.toolId : null;
  const params = isPlainObject(args.params) ? (args.params as Record<string, unknown>) : null;
  if (toolId === null) return { toolName, args };

  return { toolName: toolId, args: params ?? {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Human-facing token label for the Borrow risk disclosure. Jupiter's vault rows
 * carry `symbol`/`decimals`, but a `/borrow/positions` row genuinely does not,
 * so both are optional at this boundary. An absent field must read as an
 * explicit unknown — interpolating it directly once put the literal string
 * "undefined decimals" in front of a human approving a loan.
 */
function describeRiskToken(
  symbol: string | null | undefined,
  decimals: number | null | undefined,
  mint: string,
): string {
  if (symbol && decimals !== null && decimals !== undefined) {
    return `${symbol} (${decimals} decimals, mint ${mint})`;
  }
  if (symbol) return `${symbol} (decimals unknown, mint ${mint})`;
  if (decimals !== null && decimals !== undefined) return `mint ${mint} (${decimals} decimals)`;
  return `mint ${mint} (symbol and decimals unavailable — amount shown in raw units only)`;
}

/**
 * Build the renderer-safe preview from a parsed tool call. Allow-listed
 * keys only; coerced to JSON-safe scalars.
 *
 * `toolName` carries the user-visible identifier. For protocol tools the
 * caller passes the resolved `namespace.command` shape (e.g.
 * `kyberswap.swap.sell`) so the renderer can render namespace + command
 * separately if needed. For `execute_tool` calls the wrapper is unwrapped
 * via `resolveEffectiveCall` so the preview reflects the TARGET, not the
 * meta-tool — see Codex final review puzzle 5/2.
 */
export function buildIntentPreview(
  toolName: string,
  args: Record<string, unknown>,
  extras?: IntentPreviewExtras,
): IntentPreview {
  const effective = resolveEffectiveCall(toolName, args);

  const criticalArgs: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(effective.args)) {
    if (!PREVIEW_KEY_ALLOWLIST.has(key)) continue;
    criticalArgs[key] = coerceSummaryValue(effective.args[key]);
  }

  // Stage 7 R5: inject the swap safety verdict AFTER allow-list extraction,
  // sourced ONLY from the typed `extras.prequoteVerdict` — never from raw args
  // (`safety` is not in PREVIEW_KEY_ALLOWLIST, so the LLM cannot spoof it).
  if (extras?.prequoteVerdict !== undefined) {
    criticalArgs.safety = renderSafetyVerdict(extras.prequoteVerdict);
    // Stage 9 doctrine: FoT is no longer a verdict `fail`, so append the
    // fee-on-transfer tax to the safety label when present so a restricted
    // human still sees a high tax instead of a bare "pass". Sourced ONLY from
    // the typed `extras.fotTax` (NOT raw args) → unspoofable. The verdict must
    // be present for an FoT to exist (it rides the same matched prequote).
    if (extras.fotTax !== undefined && Number.isFinite(extras.fotTax)) {
      criticalArgs.safety = `${criticalArgs.safety} — fee-on-transfer ${extras.fotTax}%`;
    }
  }

  // Wave 5 (Pendle): render the FIXED term-lock warning from the typed
  // `extras.termLock.maturityIso` (never from raw args — `termLock` is NOT in
  // PREVIEW_KEY_ALLOWLIST). The date is taken from OUR parse of the maturity, so
  // the message is unspoofable by construction.
  if (extras?.termLock !== undefined) {
    const ms = Date.parse(extras.termLock.maturityIso);
    if (Number.isFinite(ms)) {
      const date = new Date(ms).toISOString().slice(0, 10);
      criticalArgs.termLock = `Funds locked until ${date}; early exit trades at market price and may realize a loss.`;
    }
  }

  // W5 (design §6 R4; Codex batch-4 closure blocker C2): render the Jupiter
  // fee-bearing disclosure from the typed `extras.feePreview` (never from raw
  // args — `feeDisclosure` is NOT in PREVIEW_KEY_ALLOWLIST). Owner-ordered:
  // fee bps + its estimated AMOUNT + mint/ATA, ATA rent if the account does
  // not yet exist, tip, priority-fee strategy + its lamport ESTIMATE — not
  // just a bare bps/strategy label.
  if (extras?.feePreview !== undefined) {
    const fp = extras.feePreview;
    const rentNote = fp.feeAccountExists
      ? ""
      : ` (new account, ~${fp.ataRentLamports ?? "?"} lamports rent)`;
    criticalArgs.feeDisclosure =
      `Vex fee: ${fp.feeBps / 100}% of the input (~${fp.feeAmountDecimal} of the input token, raw ${fp.feeAmountRaw}), `
      + `paid to treasury ATA ${fp.feeAccount}${rentNote}. `
      + `Tip: ${fp.tipLamports} lamports. Priority-fee strategy: ${fp.priorityFeeStrategy} `
      // When the /build response carried a CU price WITHOUT a CU limit, the
      // denominator is the budget SIMD-0170 grants the transaction. Do NOT
      // relabel this an UPPER BOUND (it was, until 2026-07-25, when the
      // denominator was Solana's 1.4M-CU maximum): Solana charges the priority
      // fee on the granted budget, so the number is what the swap costs — the
      // only thing worth disclosing is where the limit came from.
      + (fp.priorityFeeIsUpperBound
        ? `(~${fp.priorityFeeLamportsEstimate} lamports at the default compute budget — response set no compute-unit limit). `
        : `(estimated ~${fp.priorityFeeLamportsEstimate} lamports). `)
      + `Landing: ${fp.landingMode}.`;
  }

  // B1 (Batch 5 owner decision): render the Jupiter Lend Borrow LTV/health
  // disclosure from the typed `extras.riskPreview` (never from raw args —
  // `lendBorrowRisk` is NOT in PREVIEW_KEY_ALLOWLIST). Names the vault's max
  // LTV (protocol-CONFIRMED scale) and liquidation threshold (scale NOT
  // independently confirmed — labeled as such below, B3/B4); the current-LTV
  // number is an explicitly-labeled ESTIMATE (or an explicit "unavailable"
  // note) — never presented as authoritative (see `borrow-risk-preview.ts`).
  // B4 (Codex blocker): the appended `riskNote` must never claim the
  // liquidation threshold is protocol-confirmed — that would contradict the
  // "(scale unconfirmed...)" label two lines below.
  if (extras?.riskPreview !== undefined) {
    const rp = extras.riskPreview;
    const positionNote = rp.positionId === 0
      ? "a NEW position"
      : `position #${rp.positionId}`;
    // B3 (Codex batch-5 blocker): the liquidation-threshold SCALE is not
    // independently confirmed by Jupiter's own prose (only collateralFactor's
    // is) — say so in the human-facing text itself, not only in code
    // comments, until a live-gate smoke test confirms it.
    const liquidationThresholdDisplay = rp.liquidationThresholdPercent !== null
      ? `${rp.liquidationThresholdPercent} (scale unconfirmed by Jupiter's docs — pending live-gate verification)`
      : "unknown";
    criticalArgs.lendBorrowRisk =
      `This changes ${positionNote} on vault #${rp.vaultId} (${rp.market} market). `
      + `Vault max LTV: ${rp.maxLtvPercent ?? "unknown"}; liquidation threshold: ${liquidationThresholdDisplay}. `
      // 2026-07-25: the raw amounts always travel with the symbol AND the
      // decimals needed to read them — "1047061 of EPjFW…" is 1.05 at 6
      // decimals and 0.00105 at 9, and a human approver cannot tell which
      // from a bare mint address. When the provider row carries no token
      // descriptor (a `/borrow/positions` row genuinely does not), the mint
      // alone is stated: an honest omission, never the literal "undefined".
      + `Projected collateral: ${rp.projectedSupplyRaw} raw units of ${describeRiskToken(rp.supplyTokenSymbol, rp.supplyTokenDecimals, rp.supplyTokenAddress)}; `
      + `projected debt: ${rp.projectedBorrowRaw} raw units of ${describeRiskToken(rp.borrowTokenSymbol, rp.borrowTokenDecimals, rp.borrowTokenAddress)}. `
      + `Estimated LTV after this call: ${rp.estimatedLtvPercent ?? "estimate unavailable"}. ${rp.riskNote} `
      + "Jupiter's Borrow /operate never wraps or unwraps native SOL — if either token above is native SOL you "
      + "must already hold WRAPPED SOL (WSOL) in your wallet; a borrowed/withdrawn WSOL amount stays wrapped and "
      + "you must unwrap it yourself.";
  }
  // Derive namespace from dotted tool name (e.g. "kyberswap.swap.sell" → "kyberswap").
  // Internal tools without a dot get no namespace.
  const dotIdx = effective.toolName.indexOf(".");
  const namespace = dotIdx > 0 ? effective.toolName.slice(0, dotIdx) : undefined;

  const preview: IntentPreview = { toolName: effective.toolName, criticalArgs };
  if (namespace !== undefined) {
    preview.namespace = namespace;
  }
  return preview;
}

export interface PolicySnapshot {
  permission: InternalToolContext["sessionPermission"];
  sessionKind: InternalToolContext["sessionKind"];
  missionRunActive: boolean;
  contextUsageBand: InternalToolContext["contextUsageBand"];
  missionId: string | null;
  missionRunId: string | null;
}

/**
 * Build the policy-context snapshot. Phase 3 approve compares this against
 * the live context — a permission downgrade or band change between enqueue
 * and approve is observable from the diff.
 */
export function buildPolicySnapshot(context: InternalToolContext): PolicySnapshot {
  return {
    permission: context.sessionPermission,
    sessionKind: context.sessionKind,
    missionRunActive: context.missionRunId !== null,
    contextUsageBand: context.contextUsageBand,
    missionId: context.missionId,
    missionRunId: context.missionRunId,
  };
}
