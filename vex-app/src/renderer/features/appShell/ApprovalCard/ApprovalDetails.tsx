/**
 * The body of `ApprovalCard` (docs/design/R3-MINIMAL.md section 8.1), in the
 * card's order: the top row (the target swatch, "Approval needed", the expiry,
 * the REAL FUNDS stamp and the readable risk tag), the plain sentence as the
 * title, who asked, the money lines or the card's own fact rows, the risk
 * sentences, the agent's reason, and "All signed fields" (the tool, the action
 * kind, the origin, the proposal, the project, the ISO expiry and the raw
 * arguments). Pure presentation: no state, no decision logic, no events; the
 * two-step confirm and the mutations stay in `ApprovalCard`.
 *
 * Every fact rule 90 binds stays on the card: who asked is in plain view, the
 * proposal, the project and the whole expiry sit in the signed fields. A fact
 * the approval does not carry renders no row at all, never a placeholder.
 */

import type { JSX, ReactNode } from "react";
import type {
  ApprovalPreview,
  ApprovalSummaryDto,
} from "@shared/schemas/approvals.js";
import { lighterOrderFacts } from "./lighter-order-facts.js";
import { approvalMoneyLines, MONEY_NOT_AVAILABLE, type MoneyLine } from "./approval-money-lines.js";
import {
  actionKindWords,
  approvalExpiryWords,
  approvalSentence,
  isUserMcpApproval,
  riskSentences,
  riskTagIsInk,
  riskTagWord,
} from "./approval-sentence.js";
import { LineChevronRight } from "../../../components/icons/line/index.js";
import { Stamp, Tag } from "../../../components/ui/stamp.js";
import { Swatch } from "../../../components/ui/swatch.js";
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
 * exact field that will be signed), but `vexFee` is not an argument: it is
 * Vex's own cost disclosure, and "VEXFEE" is not what a person calls it.
 * Tolerant reader: a key with no entry keeps its raw name, and an absent key
 * renders no row at all: never a placeholder or a zero.
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

/** The tool label the signed fields show: `namespace:tool`, exactly as bound. */
function toolLabel(namespace: string | null, toolName: string): string {
  return namespace !== null ? `${namespace}:${toolName}` : toolName;
}

/** A line of words with its figures set in mono ("Expires at 15:30 UTC"). */
function withFigures(text: string): ReactNode[] {
  return text.split(/(\d(?:[\d:.,]*\d)?)/).map((part, index) =>
    index % 2 === 1 ? (
      <span key={index} className="vex-num">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/** One money line's value: figures in mono, words in sans, notes muted. */
function MoneyValue({ line }: { readonly line: MoneyLine }): JSX.Element {
  const parts: ReactNode[] = [];
  line.parts.forEach((part, index) => {
    if (index > 0) parts.push(" ");
    switch (part.kind) {
      case "figure":
        parts.push(<span key={index} className="vex-appr__num vex-num">{part.text}</span>);
        break;
      case "text":
        parts.push(<span key={index}>{part.text}</span>);
        break;
      case "note":
        parts.push(<span key={index} className="vex-appr__sub">{part.text}</span>);
        break;
      case "missing":
        parts.push(
          <span key={index} className="vex-appr__missing" data-vex-money-missing="">
            {MONEY_NOT_AVAILABLE}
          </span>,
        );
        break;
    }
  });
  return <>{parts}</>;
}

export interface ApprovalDetailsProps {
  readonly summary: ApprovalSummaryDto;
  readonly titleId: string;
  readonly namespace: string | null;
  readonly toolName: string;
  /** `preview.criticalArgs` (JSON-safe scalars) or null, the shape the parent reads. */
  readonly criticalArgs: ApprovalPreview["criticalArgs"] | null;
  readonly inlineError: string | null;
  /**
   * The joined Vex Studio project NAME, when the caller's read carried one
   * (`ApprovalPendingGlobalDto`). The inline session card reads
   * `ApprovalSummaryDto`, which has no join, and passes nothing; the field
   * then shows `summary.projectId`, which is the identity anyway. Display
   * only: user-authored text, never anything this card binds on.
   */
  readonly projectName?: string | null;
  /**
   * One-shot signed mark in the top row after a successful approve. The ONLY
   * light in the approvals flow; reject never sets it.
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
  const riskTag = riskTagWord(summary.riskLevel);
  const risks = riskSentences(summary);
  const expiry = summary.expiresAt === null ? null : approvalExpiryWords(summary.expiresAt, Date.now());
  const moneyLines = approvalMoneyLines(summary);
  const orderFacts = criticalArgs === null ? null : lighterOrderFacts(criticalArgs);
  const curated =
    criticalArgs !== null && CRITICAL_ARGS_ALLOWLIST_BY_TOOL[String(criticalArgs.toolId)] !== undefined;
  const hasArgs = criticalArgs !== null && Object.keys(criticalArgs).length > 0;

  // THE ARGUMENTS as bound: one ruled row per signed field, the key as named
  // and the value in mono. A curated tool's list is its readable facts, so it
  // stands in plain view; every other list is the raw record behind "All
  // signed fields".
  const argsList = hasArgs ? (
    <dl
      data-testid="critical-args"
      className={curated ? "vex-appr__dl" : "vex-appr__well vex-appr__well--args"}
    >
      {visibleCriticalArgs(criticalArgs).map(([k, v]) => (
        // `display: contents` keeps the grid while giving each pair a key.
        <div key={k} className="contents">
          <dt>{criticalArgLabel(k, criticalArgs)}</dt>
          <dd
            className={
              curated
                ? "vex-appr__wrap"
                : "vex-appr__num vex-num vex-appr__break"
            }
          >
            {criticalArgValue(k, v, criticalArgs)}
          </dd>
        </div>
      ))}
    </dl>
  ) : null;

  const facts =
    moneyLines !== null ? (
      <dl data-vex-area="approval-money" className="vex-appr__dl">
        {moneyLines.map((line) => (
          <div key={line.label} className="contents">
            <dt>{line.label}</dt>
            <dd>
              <MoneyValue line={line} />
            </dd>
          </div>
        ))}
      </dl>
    ) : orderFacts !== null && orderFacts.length > 0 ? (
      <dl data-testid="order-facts" className="vex-appr__dl">
        {orderFacts.map((fact) => (
          <div key={fact.label} className="contents">
            <dt>{fact.label}</dt>
            <dd className="vex-appr__wrap">{fact.value}</dd>
          </div>
        ))}
      </dl>
    ) : curated ? (
      argsList
    ) : null;

  const signedSummary = [
    toolLabel(namespace, toolName),
    actionKindWords(summary.actionKind),
    summary.expiresAt !== null ? "expiry" : null,
    hasArgs && !curated ? "raw arguments" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

  return (
    <>
      <header className="vex-appr__top">
        {/* The target swatch: the run is waiting on this card. */}
        <span aria-hidden className="vex-appr__pin">
          <Swatch state="awaiting" size={10} />
        </span>
        <span className="vex-appr__eyebrow">Approval needed</span>
        <span className="vex-appr__sp" />
        {expiry !== null ? <span className="vex-appr__expiry">{withFigures(expiry)}</span> : null}
        {/* REAL FUNDS: the reversed ink stamp, on every card that can move
            funds; every desktop wallet is a real wallet. A call to the user's
            own MCP tool signs nothing and carries no stamp. */}
        {isUserMcpApproval(summary) ? null : <Stamp data-testid="real-funds-stamp" className="shrink-0" />}
        {riskTag !== null ? (
          <Tag data-testid="risk-chip" quiet={!riskTagIsInk(summary.riskLevel)} className="shrink-0">
            {riskTag}
          </Tag>
        ) : null}
        {/* The signed mark: the done swatch once an approve lands (status by
            fill); unmounting early is fine (grace note, not contract). */}
        {signedGlint ? (
          <span aria-hidden data-vex-signed-glint="" className="vex-appr__pin">
            <Swatch state="done" size={10} />
          </span>
        ) : null}
      </header>

      <h3 id={titleId} className="vex-appr__title">
        {approvalSentence(summary)}
      </h3>

      {/* WHO ASKED (rule 90: the actor and whether an agent proposed it), in
          plain view. Each fact renders only when the approval CARRIES it. */}
      {actorLine !== null ? (
        <p data-testid="approval-actor" className="vex-appr__meta">
          {APPROVAL_ACTOR_FIELD_LABEL} <span>{actorLine}</span>
        </p>
      ) : null}

      {facts}

      {risks.length > 0 ? (
        <div className="vex-appr__why">
          {risks.map((risk) => (
            <p key={risk.lead}>
              <b>{risk.lead}</b> {risk.text}
            </p>
          ))}
        </div>
      ) : null}

      {summary.reasoningPreview.trim().length > 0 ? (
        <p className="vex-appr__reason">{summary.reasoningPreview}</p>
      ) : null}

      {/* ALL SIGNED FIELDS, closed (section 8.1, item 6). The row-level facts
          of the durable intent (proposal, project, expiry) are NOT
          `criticalArgs`: the card's `preview_json` is what the Studio authority
          digest covers, so they are shown here without touching what it
          binds. A card with no readable facts above opens it, so the only
          facts it has are never folded away. */}
      <details className="vex-appr__more" open={facts === null}>
        <summary className="vex-appr__more-key">
          <span aria-hidden className="vex-appr__chev">
            <LineChevronRight size={14} />
          </span>
          All signed fields
          <span className="vex-appr__more-sum">{signedSummary}</span>
        </summary>
        <dl className="vex-appr__well">
          <div className="contents">
            <dt>Tool</dt>
            <dd className="vex-appr__num vex-num vex-appr__break">{toolLabel(namespace, toolName)}</dd>
          </div>
          {summary.actionKind !== null ? (
            <div className="contents">
              <dt>Action kind</dt>
              <dd data-testid="action-chip" className="vex-appr__num vex-num">
                {summary.actionKind}
              </dd>
            </div>
          ) : null}
          {summary.origin !== null ? (
            <div className="contents">
              <dt>Origin</dt>
              <dd className="vex-appr__num vex-num">{summary.origin}</dd>
            </div>
          ) : null}
          <div data-testid="approval-proposal" className="contents">
            <dt>{APPROVAL_PROPOSAL_FIELD_LABEL}</dt>
            <dd className="vex-appr__num vex-num vex-appr__break">{summary.id}</dd>
          </div>
          {/* PROVENANCE: the NAME is what the user reads; the id rides in the
              title and the accessible name, because a name can be edited or
              belong to a tombstoned project and the id cannot. */}
          {summary.projectId !== null ? (
            <div data-testid="approval-project" className="contents">
              <dt>{APPROVAL_PROJECT_FIELD_LABEL}</dt>
              <dd
                className="vex-appr__break"
                title={approvalProjectDetail(summary.projectId, projectName)}
                aria-label={approvalProjectDetail(summary.projectId, projectName)}
              >
                {approvalProjectDisplay(summary.projectId, projectName)}
              </dd>
            </div>
          ) : null}
          {/* The instant this approval stops being decidable, WHOLE and in
              UTC exactly as the durable row states it: never a renderer
              countdown, which would be a second source of truth for the one
              deadline the engine's sweep and the broker's timer own. */}
          {summary.expiresAt !== null ? (
            <div data-testid="approval-expiry" className="contents">
              <dt>
                {criticalArgs?.toolId === "lighter.fees.approve" ? "Decision deadline" : APPROVAL_EXPIRY_FIELD_LABEL}
              </dt>
              <dd className="vex-appr__num vex-num">{summary.expiresAt}</dd>
            </div>
          ) : null}
        </dl>
        {curated ? null : argsList}
      </details>

      {inlineError !== null ? (
        <p role="alert" className="vex-appr__error">
          <Swatch state="error" size={10} className="mt-[4px] shrink-0" />
          <span>{inlineError}</span>
        </p>
      ) : null}
    </>
  );
}
