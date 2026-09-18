/**
 * Presentational header + body for `ApprovalCard` (F3).
 *
 * Renders the approval title (`namespace:tool`), the risk + action stamps, the
 * reasoning preview, the critical-args well, and the inline error alert. Pure
 * presentation: it holds no state, owns no decision logic, and emits no events
 * — the two-step confirm gate and mutation wiring stay in `ApprovalCard`.
 * Testids, aria, and TEXT CONTENT are pinned by tests and stay verbatim; the
 * chrome speaks the landing's amber alert register (.ws-alert): mono-uppercase
 * title in --vex-pin over the card's pin fill.
 */

import type { JSX } from "react";
import type {
  ApprovalPreview,
  ApprovalSummaryDto,
} from "@shared/schemas/approvals.js";
import { riskChipClasses } from "./risk.js";
import { lighterOrderFacts } from "./lighter-order-facts.js";
import {
  APPROVAL_ACTOR_FIELD_LABEL,
  APPROVAL_EXPIRY_FIELD_LABEL,
  APPROVAL_PROJECT_FIELD_LABEL,
  APPROVAL_PROPOSAL_FIELD_LABEL,
  approvalActorLine,
  approvalProjectDetail,
  approvalProjectDisplay,
} from "../approvals/approvals-copy.js";

/**
 * Human labels for the engine-injected, non-argument preview keys. A tool
 * ARGUMENT is normally shown under its own name (the user is verifying the
 * exact field that will be signed), but `vexFee` is not an argument — it is
 * Vex's own cost disclosure, and "VEXFEE" is not what a person calls it.
 * Tolerant reader: a key with no entry keeps its raw name, and an absent key
 * renders no row at all — never a placeholder or a zero.
 */
const CRITICAL_ARG_LABELS: Readonly<Record<string, string>> = {
  vexFee: "Vex fee",
};

const FEE_AUTHORIZATION_LABELS: Readonly<Record<string,string>> = {
  summary: "Action", perpetualFee: "Perpetual fee", spotFee: "Spot fee", recipient: "Recipient",
  collectorWallet: "Collector wallet", tradingAccount: "Trading account", walletAddress: "Your wallet",
  authorizationValidUntil: "Authorization valid until", accountChange: "Account tier",
  exchangeFees: "Lighter exchange fees", scopeNote: "Permission scope",
};

/**
 * `buildLighterWithdrawalCriticalArgs` (withdrawal-approval-binding.ts) binds
 * 35 fields - gateway addresses, code hashes, chain-plumbing IDs, account
 * indices - because the binding must re-verify every one of them against the
 * durable intent before a withdrawal executes. None of that changes what gets
 * REVIEWED: a human deciding whether to sign a withdrawal needs what, how
 * much, to where, on what network, when it clears, and the one-time-submit
 * caveat - `summary` and `scopeNote` already say the first four in one
 * sentence each. Everything else here stays bound and verified; it just never
 * needed to be READ.
 */
const LIGHTER_WITHDRAWAL_LABELS: Readonly<Record<string,string>> = {
  summary: "Action", walletAddress: "Your wallet", destinationAddress: "Destination",
  settlementNetworkName: "Network", amountDisplay: "Amount",
  // Room to spare once the well was curated down to 7 rows - these two answer
  // the question the agent's own reasoning already volunteers in the
  // transcript ("this withdraws the full balance") but the card itself
  // didn't: is this a partial or a full drain, and are there open positions
  // that make draining collateral riskier right now.
  collateralUnits: "Account balance", openPositionCount: "Open positions",
  estimatedClaimableAt: "Claimable at", scopeNote: "Permission scope",
};

/**
 * `buildDepositApprovalFollowUp` (handlers/deposit.ts) binds 31 fields, the
 * same shape of bloat as withdrawal: gateway/token contract addresses, code
 * hashes, ERC-20 allowance/balance snapshots, block numbers. `approvalRequired`
 * is the one non-obvious fact worth a row of its own - it tells the user
 * whether this deposit ALSO spends a separate token-allowance approval, which
 * `summary` does not say.
 */
const LIGHTER_DEPOSIT_LABELS: Readonly<Record<string,string>> = {
  summary: "Action", walletAddress: "Your wallet", depositTo: "Deposit to",
  settlementNetworkName: "Network", amountDisplay: "Amount",
  approvalRequired: "Requires token approval", scopeNote: "Permission scope",
};

/**
 * `buildLighterWithdrawalClaimCriticalArgs` (withdrawal-claim-approval-
 * binding.ts) binds 31 fields, the same profile again (gateway/token
 * addresses, code hashes, gas-quote plumbing). `networkFeeCeilingDisplay` is
 * kept because it is a real spending cap this approval authorizes, distinct
 * from the asset amount in `summary`.
 */
const LIGHTER_WITHDRAWAL_CLAIM_LABELS: Readonly<Record<string,string>> = {
  summary: "Action", ownerAddress: "Recipient", settlementNetworkName: "Network",
  amountDisplay: "Amount", networkFeeCeilingDisplay: "Max network fee",
  scopeNote: "Permission scope",
};

/**
 * One allowlist per tool whose critical-args well is dominated by fields
 * that stay bound and verified server-side but were never meant to be READ.
 * `lighter.order.create` is deliberately NOT here: its fields (market, side,
 * price, size, time-in-force, reduce-only, trigger price) are the trade
 * itself, not gateway plumbing - a trader reviewing an order approval wants
 * most of them, so there is no bloat to curate away.
 */
const CRITICAL_ARGS_ALLOWLIST_BY_TOOL: Readonly<Record<string, Readonly<Record<string,string>>>> = {
  "lighter.fees.approve": FEE_AUTHORIZATION_LABELS,
  "lighter.withdraw": LIGHTER_WITHDRAWAL_LABELS,
  "lighter.deposit": LIGHTER_DEPOSIT_LABELS,
  "lighter.withdraw.claim": LIGHTER_WITHDRAWAL_CLAIM_LABELS,
};

function visibleCriticalArgs(criticalArgs: ApprovalPreview["criticalArgs"]): [string,unknown][] {
  const entries=Object.entries(criticalArgs);
  const allowlist = CRITICAL_ARGS_ALLOWLIST_BY_TOOL[String(criticalArgs.toolId)];
  // The curated rows already disclose every permission term. Numeric
  // duplicates and the internal key/intent identities stay bound in the host's
  // approval record, without making users review signer implementation fields.
  return allowlist ? entries.filter(([key])=>key in allowlist) : entries;
}

function isLighterCreateOrderBehavior(
  key: string,
  value: unknown,
  criticalArgs: ApprovalPreview["criticalArgs"],
): boolean {
  return key === "timeInForce"
    && criticalArgs.toolId === "lighter.order.create"
    && (value === "good-till-time"
      || value === "immediate-or-cancel"
      || value === "post-only");
}

/**
 * `collateralUnits` (withdrawal-approval-binding.ts) is a raw base-unit
 * integer, exactly like `amountUnits` - the binding never formats it because
 * nothing signs the formatted string, only the raw one. `assetDecimals` and
 * `assetSymbol` are still on the full `criticalArgs` object even though
 * neither has its own visible row, so the shift can happen here without
 * asking the backend to add a pre-formatted display field for one label.
 */
function formatLighterAssetUnits(
  value: unknown,
  criticalArgs: ApprovalPreview["criticalArgs"],
): string {
  const decimals = criticalArgs.assetDecimals;
  const symbol = criticalArgs.assetSymbol;
  if (typeof decimals !== "number" || typeof symbol !== "string") return String(value);
  if (typeof value !== "string" && typeof value !== "number") return String(value);
  try {
    const raw = BigInt(value);
    const divisor = 10n ** BigInt(decimals);
    const whole = raw / divisor;
    const fraction = (raw % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`} ${symbol}`;
  } catch {
    return String(value);
  }
}

function criticalArgValue(
  key: string,
  value: unknown,
  criticalArgs: ApprovalPreview["criticalArgs"],
): string {
  if (key === "collateralUnits" && criticalArgs.toolId === "lighter.withdraw") {
    return formatLighterAssetUnits(value, criticalArgs);
  }
  if (!isLighterCreateOrderBehavior(key, value, criticalArgs)) return String(value);
  if (value === "good-till-time") return "GTC";
  if (value === "immediate-or-cancel") return "IOC";
  return "Post-Only";
}

function criticalArgLabel(
  key: string,
  criticalArgs: ApprovalPreview["criticalArgs"],
): string {
  const allowlist = CRITICAL_ARGS_ALLOWLIST_BY_TOOL[String(criticalArgs.toolId)];
  if (allowlist) return allowlist[key] ?? key;
  if (isLighterCreateOrderBehavior(key, criticalArgs[key], criticalArgs)) {
    return "Order behavior";
  }
  if (key !== "orderExpiryIso") return CRITICAL_ARG_LABELS[key] ?? key;
  const orderType = criticalArgs.orderType;
  const timeInForce = criticalArgs.timeInForce;
  if (
    criticalArgs.toolId === "lighter.order.create"
    && timeInForce === "immediate-or-cancel"
    && (orderType === "market" || orderType === "limit")
  ) {
    return "Unsent expiry reference (signed expiry 0)";
  }
  if (
    orderType === "stop-loss"
    || orderType === "stop-loss-limit"
    || orderType === "take-profit"
    || orderType === "take-profit-limit"
  ) {
    return "Signed trigger-order expiry";
  }
  return "Signed order expiry";
}

export interface ApprovalDetailsProps {
  readonly summary: ApprovalSummaryDto;
  readonly titleId: string;
  readonly namespace: string | null;
  readonly toolName: string;
  /** `preview.criticalArgs` (JSON-safe scalars) or null — same shape the parent reads. */
  readonly criticalArgs: ApprovalPreview["criticalArgs"] | null;
  readonly inlineError: string | null;
  /**
   * The joined Vex Studio project NAME, when the caller's read carried one
   * (`ApprovalPendingGlobalDto`). The inline session card reads
   * `ApprovalSummaryDto`, which has no join, and passes nothing - the field
   * then shows `summary.projectId`, which is the identity anyway. Display
   * only: user-authored text, never anything this card binds on.
   */
  readonly projectName?: string | null;
  /**
   * S5 — one-shot signed glint in the stamp area after a successful approve.
   * The ONLY light in the approvals flow; reject never sets it.
   */
  readonly signedGlint?: boolean;
}

export function ApprovalDetails({
  summary,
  titleId,
  namespace,
  toolName,
  criticalArgs,
  inlineError,
  projectName = null,
  signedGlint = false,
}: ApprovalDetailsProps): JSX.Element {
  const actorLine = approvalActorLine({
    origin: summary.origin,
    requestedByClient: summary.requestedByClient,
    projectId: summary.projectId,
    projectName,
  });
  const orderFacts = criticalArgs === null ? null : lighterOrderFacts(criticalArgs);
  const criticalArgsWell = criticalArgs !== null && Object.keys(criticalArgs).length > 0 ? (
    <dl
      data-testid="critical-args"
      className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-[6px] border border-[var(--vex-line)] bg-[var(--vex-surface-down)] px-3 py-2 font-mono text-[11px]"
    >
      {visibleCriticalArgs(criticalArgs).map(([k, v]) => (
        // `display: contents` keeps the grid layout while giving each
        // pair a stable React key.
        <div key={k} className="contents">
          <dt className="uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
            {criticalArgLabel(k, criticalArgs)}
          </dt>
          <dd className={criticalArgs.toolId === "lighter.fees.approve"
            ? "min-w-0 break-words [overflow-wrap:anywhere] text-[var(--vex-text-2)]"
            : "break-all text-[var(--vex-text-2)]"}>{criticalArgValue(k, v, criticalArgs)}</dd>
        </div>
      ))}
    </dl>
  ) : null;
  return (
    <>
      <header
        // Pinned to the top of the card's own scroll ancestor
        // (`ApprovalsRegion`'s bounded `overflow-y-auto` region): a long
        // critical-args well — the combined key+fee card can run to dozens of
        // rows — used to scroll the title (what is being signed) out of view
        // before the user ever reached Approve/Reject. Same
        // `sticky top-0 z-10` + solid-background pattern `GlobalApprovals`
        // already uses for its `DialogHeader`.
        className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-t-lg border-b border-[var(--vex-line)] bg-[var(--vex-pin-fill-solid)] px-4 py-3"
      >
        <div className="min-w-0 flex-1">
          <h3
            id={titleId}
            className="truncate font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--vex-pin)]"
          >
            Approval needed:{" "}
            <span className="font-mono">
              {namespace !== null ? `${namespace}:${toolName}` : toolName}
            </span>
          </h3>
        </div>
        {/* Stamp grammar — text content stays verbatim (tests pin it). */}
        {summary.riskLevel !== null ? (
          <span
            data-testid="risk-chip"
            className={`shrink-0 rounded-[3px] border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] ${riskChipClasses(
              summary.riskLevel,
            )}`}
          >
            {summary.riskLevel}
          </span>
        ) : null}
        {summary.actionKind !== null ? (
          <span
            data-testid="action-chip"
            className="shrink-0 rounded-[3px] border border-[var(--vex-line-strong)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-2)]"
          >
            {summary.actionKind}
          </span>
        ) : null}
        {/* The signed glint — plays once via stylesheet keyframes and ends
            transparent; unmounting early is fine (grace note, not contract). */}
        {signedGlint ? (
          <span
            aria-hidden
            data-vex-signed-glint=""
            className="vex-intro-glint h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--vex-accent-text)]"
          />
        ) : null}
      </header>
      <div className="space-y-3 px-4 py-3">
        {/* THE BOUND FACTS (rule 90: an approval binds at least the actor and
            whether an agent proposed it, the resource, the expiry and the
            proposal identity). They are ROW-LEVEL facts of the durable intent,
            not `criticalArgs`: the card's `preview_json` is what the Studio
            authority digest covers and what the pre-dispatch revalidation
            rebuilds from the tool call alone, so a field the rebuild cannot
            reproduce would make every Studio dispatch refuse on card mismatch.
            Rendering them here puts them in front of the human without
            touching what the digest binds.

            Each row renders only when the approval CARRIES that fact - an
            agent-mode approval has no project, a legacy row has no expiry, and
            an empty "Project: -" would invent one. */}
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
          {actorLine !== null ? (
            <div data-testid="approval-actor" className="contents">
              <dt className="uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
                {APPROVAL_ACTOR_FIELD_LABEL}
              </dt>
              <dd className="break-all text-[var(--vex-text-2)]">{actorLine}</dd>
            </div>
          ) : null}
          {/* PROVENANCE (B0/B4c). The NAME is what the user reads; the ID rides
              in the title and the accessible name, because a name can be
              edited or belong to a tombstoned project and the id cannot. */}
          {summary.projectId !== null ? (
            <div data-testid="approval-project" className="contents">
              <dt className="uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
                {APPROVAL_PROJECT_FIELD_LABEL}
              </dt>
              <dd
                className="break-all text-[var(--vex-text-2)]"
                title={approvalProjectDetail(summary.projectId, projectName)}
                aria-label={approvalProjectDetail(summary.projectId, projectName)}
              >
                {approvalProjectDisplay(summary.projectId, projectName)}
              </dd>
            </div>
          ) : null}
          <div data-testid="approval-proposal" className="contents">
            <dt className="uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
              {APPROVAL_PROPOSAL_FIELD_LABEL}
            </dt>
            <dd className="break-all text-[var(--vex-text-2)]">{summary.id}</dd>
          </div>
          {/* The instant this approval stops being decidable, carried WHOLE and
              in UTC exactly as the durable row states it. Not localized and not
              rendered as "in 9 minutes": a countdown computed in the renderer
              is a second source of truth for the one deadline the engine's
              sweep and the broker's timer already own. */}
          {summary.expiresAt !== null ? (
            <div data-testid="approval-expiry" className="contents">
              <dt className="uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
                {criticalArgs?.toolId === "lighter.fees.approve" ? "Decision deadline" : APPROVAL_EXPIRY_FIELD_LABEL}
              </dt>
              <dd className="break-all text-[var(--vex-text-2)]">
                {summary.expiresAt}
              </dd>
            </div>
          ) : null}
        </dl>
        {summary.reasoningPreview.trim().length > 0 ? (
          <p className="italic text-[var(--vex-text-2)]">
            {summary.reasoningPreview}
          </p>
        ) : null}
        {/* A Lighter order card reads as an order first: the human rows, then
            the full signed field list folded beneath them. Every other card
            shows the field list alone. */}
        {orderFacts !== null && orderFacts.length > 0 ? (
          <dl
            data-testid="order-facts"
            className="grid grid-cols-[max-content_1fr] items-baseline gap-x-3 gap-y-1.5 rounded-[6px] border border-[var(--vex-line)] bg-[var(--vex-surface-down)] px-3 py-2 text-[12px]"
          >
            {orderFacts.map((fact) => (
              <div key={fact.label} className="contents">
                <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
                  {fact.label}
                </dt>
                <dd className="min-w-0 break-words [overflow-wrap:anywhere] text-[var(--vex-text)]">{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {/* Critical args — recessed well: the facts being signed for. */}
        {orderFacts !== null && criticalArgsWell !== null ? (
          <details className="group">
            <summary className="cursor-pointer select-none font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)] hover:text-[var(--vex-text-2)]">
              All signed fields
            </summary>
            <div className="mt-2">{criticalArgsWell}</div>
          </details>
        ) : criticalArgsWell}
        {inlineError !== null ? (
          <p
            role="alert"
            className="rounded-[6px] border border-[color-mix(in_oklab,var(--color-destructive)_40%,transparent)] bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {inlineError}
          </p>
        ) : null}
      </div>
    </>
  );
}
