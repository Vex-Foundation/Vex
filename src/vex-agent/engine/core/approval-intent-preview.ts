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
import { resolveToolName } from "../../tools/registry/name-resolution.js";
import type { SafetyVerdict } from "../../db/repos/swap-prequotes.js";
import {
  renderQuoteBinding,
  type QuoteBindingPreview,
} from "../../tools/protocols/quote-authority/restore.js";
import { renderSpendability } from "../../tools/protocols/quote-authority/spendability.js";
import type { JupiterFeePreview } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";
import type { LendBorrowRiskPreview } from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/risk-preview-types.js";
import { formatLamportsAsSol } from "@vex-agent/tools/protocols/amount-display.js";
import { describeApprovalVexFee, describeBoundVexFee } from "./approval-vex-fee.js";
import type { ToolResult } from "../../tools/types.js";

type ApprovalBridgeTokenPreview = NonNullable<
  NonNullable<ToolResult["prequote"]>["bridgeTokenPreview"]
>;

type ApprovalSpendabilityPreview = NonNullable<
  NonNullable<ToolResult["prequote"]>["spendability"]
>;

type ApprovalVexFeePreview = NonNullable<
  NonNullable<ToolResult["prequote"]>["vexFee"]
>;

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
  // The bridges' OWN amount key. Its absence meant a bridge approval card
  // showed the chains, the tokens and the safety verdict but NOT the amount
  // being moved — the one number a human most needs before signing. Same class
  // as `amountIn` above (a model-supplied argument that the executor signs
  // verbatim), so it is surfaced, not trusted.
  "amountRaw",
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
  /**
   * The APPROVED QUOTE a gated swap execute is bound to. Sourced ONLY from the
   * matched prequote's stored snapshot (NOT raw args - `quoteBinding` is
   * deliberately NOT in PREVIEW_KEY_ALLOWLIST), so the card's floor is the
   * store's floor and the model cannot state a different one.
   *
   * Rendered into `criticalArgs.quoteBinding`. The rendered line carries its own
   * version tag, so a card written by an older build is textually different from
   * one written by this build and the whole-card comparison at confirm time
   * refuses it rather than confirming a line whose meaning has changed.
   */
  quoteBinding?: QuoteBindingPreview;
  /**
   * What the wallet could pay when the matched quote was taken (WP2). Sourced
   * ONLY from the matched prequote's persisted `safetyDetail` (NOT raw args -
   * `spendability` is deliberately NOT in PREVIEW_KEY_ALLOWLIST), so the
   * Required / Current figures on the card are the store's figures.
   *
   * Rendered into `criticalArgs.spendability`. The line states that the numbers
   * are quote-time and are re-read before signing, because a person reading a
   * balance on a card has no other way to know how old it is.
   */
  spendability?: ApprovalSpendabilityPreview;
  /**
   * The Vex fee statement the matched quote made. Sourced ONLY from the matched
   * prequote's persisted `safetyDetail` through the prequote gate (NOT raw args
   * - `vexFee` is deliberately NOT in PREVIEW_KEY_ALLOWLIST), so the rate, the
   * amount and the receiver on the card are the store's and the model cannot
   * state different ones.
   *
   * When it is present it WINS: the args-derived line is never emitted for a
   * tool this channel covers, so one card can never carry two derivations of one
   * money figure.
   */
  vexFee?: ApprovalVexFeePreview;
  /** Direct EVM bridge token identity, sourced by the gate rather than args. */
  bridgeTokenPreview?: ApprovalBridgeTokenPreview;
}

/** Render a swap safety verdict for the approval preview's `criticalArgs.safety`. */
function renderSafetyVerdict(verdict: SafetyVerdict): string {
  switch (verdict) {
    case "pass":
      return "pass";
    case "unknown":
      return "UNVERIFIED - audit unavailable";
    case "fail":
      // A `fail` is blocked at the gate and never reaches the approval preview;
      // render defensively if it ever does (must never read as safe).
      return "FAILED - flagged unsafe";
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
  rawToolName: string,
  args: Record<string, unknown>,
): { toolName: string; args: Record<string, unknown> } {
  // Deprecation-alias resolution FIRST (approved plan section 5.5). The turn
  // loop passes the ORIGINAL model tool call to the preview builder, so without
  // this the human approving a fund-moving action would be shown a name the
  // runtime has retired. The Vex-fee itemisation also keys off the resolved
  // `toolName`, so a stale spelling would silently drop the fee line from the
  // approval card. The human sees the canonical identity, the same one the
  // envelope stores. A retired PROTOCOL name resolves through the injected lane
  // just below, which consults the same alias table.
  const toolName = resolveToolName(rawToolName);

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
 * Human-facing token label for the Borrow risk disclosure.
 *
 * `LendBorrowRiskPreview` declares both fields NON-NULL and the evaluator
 * sources them from the VAULT (`borrow-risk-preview.ts` → `vault.supplyToken`),
 * which always carries them — the nullable descriptors belong to the separate
 * `/borrow/positions` PROJECTION type, which never reaches this renderer. The
 * fallbacks below are therefore a defence-in-depth guard against an unvalidated
 * provider row arriving nullish at runtime in spite of the type, not a modelled
 * product state: interpolating an absent field directly once put the literal
 * string "undefined decimals" in front of a human approving a loan, and that
 * must not come back. They are deliberately not exercised by a fixture that
 * would have to contradict the type to construct the input.
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

  // Itemise the Vex platform fee AFTER allow-list extraction. When the prequote
  // gate carried the matched quote's OWN fee statement, that block is the line:
  // it is what a person consents to and what the executor is re-checked against
  // before signing, so no second derivation of the figure exists to disagree
  // with it. Only a tool whose fee cannot be stated at quote time
  // (`trench.trade_execute`) falls back to the rate-times-amount line.
  //
  // `vexFee` is deliberately NOT in PREVIEW_KEY_ALLOWLIST, so a
  // `fee`/`feeBps`/`feeReceiver` argument can never reach this line - the rate
  // is ours, never the model's. Undefined for every tool that carries no Vex fee
  // or discloses it elsewhere (Jupiter's richer `feeDisclosure` below; the
  // Trench launch form), so the card grows no line rather than an empty or zero
  // one.
  const vexFee = extras?.vexFee !== undefined
    ? describeBoundVexFee(effective.toolName, extras.vexFee)
    : describeApprovalVexFee(effective.toolName, effective.args);
  if (vexFee !== undefined) {
    criticalArgs.vexFee = vexFee;
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
      criticalArgs.safety = `${criticalArgs.safety} - fee-on-transfer ${extras.fotTax}%`;
    }
  }

  // Wave 5 (Pendle): render the FIXED term-lock warning from the typed
  // `extras.termLock.maturityIso` (never from raw args — `termLock` is NOT in
  // PREVIEW_KEY_ALLOWLIST). The date is taken from OUR parse of the maturity, so
  // the message is unspoofable by construction.
  // The quote binding: what was quoted, the floor the fill may not go below,
  // and when this authority lapses. Rendered before the term-lock block so the
  // money line sits next to the safety line on the card.
  if (extras?.quoteBinding !== undefined) {
    criticalArgs.quoteBinding = renderQuoteBinding(extras.quoteBinding);
  }

  // WP2: what the wallet could pay when the quote was taken. Rendered next to
  // the quote binding, because the two answer the two halves of "is this trade
  // real": what it promises, and whether it can be funded.
  if (extras?.spendability !== undefined) {
    criticalArgs.spendability = renderSpendability(extras.spendability);
  }

  if (extras?.bridgeTokenPreview !== undefined) {
    const preview = extras.bridgeTokenPreview;
    criticalArgs.bridgeSourceAsset = renderBridgeAsset(preview.source);
    criticalArgs.bridgeDestinationAsset = renderBridgeAsset(preview.destination);
    // WHERE THE FUNDS LAND. Derived by Vex from the session's selected wallet
    // for the destination family and bound into the prequote identity hash; it
    // is not a parameter, and saying so on the card is what keeps a reader from
    // assuming the model chose it.
    if (preview.recipient !== undefined) {
      const walletFamily = preview.recipient.family === "solana" ? "Solana" : "EVM";
      criticalArgs.bridgeDestinationWallet =
        `Destination wallet ${preview.recipient.address} | your selected ${walletFamily} wallet`
        + " | derived by Vex, never a parameter";
    }
    criticalArgs.bridgeAmount = preview.amountHuman !== null
      ? `${preview.amountHuman} ${preview.source.symbol} | ${preview.amountRaw} raw units | ${preview.source.decimals} decimals`
      : preview.source.kind === "metadata_unavailable"
        ? `${preview.amountRaw} raw units | human amount unavailable because source contract decimals could not be read | signing blocked`
        : `${preview.amountRaw} raw units; human amount unavailable on this non-EVM source lane`;
  }

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
      : ` (new account, ~${fp.ataRentLamports ?? "?"} lamports / ${formatLamportsAsSol(fp.ataRentLamports) ?? "?"} SOL rent)`;
    criticalArgs.feeDisclosure =
      `Vex fee: ${fp.feeBps / 100}% of the input (~${fp.feeAmountDecimal} of the input token, raw ${fp.feeAmountRaw}), `
      + `paid to treasury ATA ${fp.feeAccount}${rentNote}. `
      // Rule 90: a raw amount travels with what is needed to read it. A bare
      // lamport figure in the disclosure the HUMAN approves from is exactly the
      // thousandfold misread that rule names, so SOL travels alongside it —
      // never instead of it, since the lamport figure is the exact one.
      + `Tip: ${fp.tipLamports} lamports (${formatLamportsAsSol(fp.tipLamports) ?? "?"} SOL). `
      + `Priority-fee strategy: ${fp.priorityFeeStrategy} `
      // When the /build response carried a CU price WITHOUT a CU limit, the
      // denominator is the budget SIMD-0170 grants the transaction. Do NOT
      // relabel this an UPPER BOUND (it was, until 2026-07-25, when the
      // denominator was Solana's 1.4M-CU maximum): Solana charges the priority
      // fee on the granted budget, so the number is what the swap costs — the
      // only thing worth disclosing is where the limit came from.
      + (fp.priorityFeeIsUpperBound
        ? `(~${fp.priorityFeeLamportsEstimate} lamports / ${formatLamportsAsSol(fp.priorityFeeLamportsEstimate) ?? "?"} SOL at the default compute budget — response set no compute-unit limit). `
        : `(estimated ~${fp.priorityFeeLamportsEstimate} lamports / ${formatLamportsAsSol(fp.priorityFeeLamportsEstimate) ?? "?"} SOL). `)
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
      // from a bare mint address. Both descriptors are non-null on this type
      // (vault-sourced); `describeRiskToken` still degrades to the bare mint
      // rather than the literal "undefined" if one ever arrives nullish.
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

function renderBridgeAsset(
  asset: ApprovalBridgeTokenPreview["source"],
): string {
  if (asset.family === "solana") {
    return `Solana chain ${asset.chainId} | mint ${asset.tokenAddress} | EVM contract metadata not applicable`;
  }
  if (asset.kind === "metadata_unavailable") {
    return `EVM chain ${asset.chainId} | token ${asset.tokenAddress} | metadata unavailable (${asset.metadataErrorCode ?? "contract_metadata_unavailable"}) | ${asset.metadataSource} | signing blocked until authoritative symbol and decimals are available`;
  }
  const sanitized = asset.symbolSanitized ? " | invisible control characters removed" : "";
  return `EVM chain ${asset.chainId} | ${asset.kind} ${asset.tokenAddress} | ${asset.symbol} | ${asset.decimals} decimals | ${asset.metadataSource}${sanitized}`;
}

export interface PolicySnapshot {
  permission: InternalToolContext["sessionPermission"];
  sessionKind: InternalToolContext["sessionKind"];
  missionRunActive: boolean;
  contextUsageBand: InternalToolContext["contextUsageBand"];
  missionId: string | null;
  missionRunId: string | null;
  /**
   * WHO asked, when an external MCP client did: the `clientInfo.name` its
   * `initialize` handshake declared, sanitized by
   * {@link sanitizeRequestingClientName}. `null` for Vex's own agent loop and
   * for an MCP client whose declared name is unusable.
   *
   * PROVENANCE, NOT AUTHORITY. It is display text an external process chose
   * for itself, so nothing may branch on it: it rides `policy_json`, which no
   * gate reads, and it is deliberately NOT in `preview_json` - the card that
   * the Studio authority digest binds and the pre-dispatch revalidation
   * rebuilds from `(toolName, toolArgs, result)` alone. A field the rebuild
   * cannot reproduce would make every Studio dispatch refuse on card
   * mismatch.
   */
  requestedByClient: string | null;
}

/**
 * The longest `clientInfo.name` this build will show a human.
 *
 * An over-long name is DROPPED, never shortened: the actor line is one of the
 * facts rule 90 binds an approval to, and a name cut mid-word is a name the
 * reader cannot verify - "Claude Cod..." and "Claude Code" read the same and are
 * not. Falling back to the unknown label claims less rather than more.
 */
export const REQUESTING_CLIENT_NAME_MAX = 60;

/**
 * Make an MCP client's self-declared name safe to store and to render, or
 * refuse it.
 *
 * The value arrives from an external process's `initialize` params, so it is
 * untrusted input at a trust boundary (rule 04): control characters could forge
 * lines in a card a human reads, and an unbounded string is a display-surface
 * denial of service. Returns `null` for anything it will not vouch for, and the
 * caller renders the honest unknown label instead of a blank.
 */
export function sanitizeRequestingClientName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > REQUESTING_CLIENT_NAME_MAX) return null;
  return trimmed;
}

/**
 * Build the policy-context snapshot. Phase 3 approve compares this against
 * the live context — a permission downgrade or band change between enqueue
 * and approve is observable from the diff.
 */
export function buildPolicySnapshot(
  context: InternalToolContext,
  requestedByClient?: unknown,
): PolicySnapshot {
  return {
    permission: context.sessionPermission,
    sessionKind: context.sessionKind,
    missionRunActive: context.missionRunId !== null,
    contextUsageBand: context.contextUsageBand,
    missionId: context.missionId,
    missionRunId: context.missionRunId,
    requestedByClient: sanitizeRequestingClientName(requestedByClient),
  };
}
