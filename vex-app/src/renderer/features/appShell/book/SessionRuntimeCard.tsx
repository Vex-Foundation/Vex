/**
 * RUNTIME & COST — the session rail's engine instrument, in the card grammar
 * (`PortfolioCard`). Replaces the retired `SessionRuntimeBar`: that component
 * carried an `inline` pill layout and a `stack` row layout, and after the book
 * became a card stack the ONLY surviving caller was this one — so the two
 * layouts collapsed into this single card rather than surviving as a dead
 * branch.
 *
 * Four independent facts, each self-gating on ITS OWN data (NOT on model
 * configuration — usage rows + token_count persist across config changes, so
 * a currently-unconfigured model must not hide historical usage):
 *
 *  - **model**: the global runtime model the engine resolves from
 *    `AGENT_PROVIDER`/`AGENT_MODEL` (`sessions.getModel`). Brand icon + model
 *    id + the routing line ("via OpenRouter" — `SessionModelDto.provider`,
 *    shown only when main actually reports one; never assumed).
 *  - **usage**: last-turn IN/OUT/CACHE/REASONING tokens + the session cost
 *    (`usage_log`). Renders nothing until the session has at least one turn.
 *  - **context**: tokens used vs the global limit, with the ENGINE's own
 *    pressure-band markers. The band edges arrive on `ContextWindowDto`
 *    (filled by `main/ipc/usage.ts` from `context-pressure-policy.ts`) — this
 *    file NEVER hardcodes a threshold, so a marker can never drift from the
 *    fraction that actually gates compaction. `contextLimit === null`
 *    degrades to the bare token count, never a fabricated denominator.
 *    The figure lags the live transcript by one turn, and the card says so.
 *  - **compaction**: Track-2 worker status — "compacting" / "queued" /
 *    "failed", hidden when nothing is in flight. The chip names the remote
 *    (OpenRouter, redacted) path in its accessible label.
 *
 * The model/usage/context reads are kept fresh by `useUsageLiveSync` (mounted
 * in `SessionPanel`) + the chat-submit success invalidation; compaction has
 * its own poll + `useCompactionLiveSync` (mounted here, since background
 * Track-2 completion fires no transcript event).
 */

import type { JSX } from "react";
import type { SessionModelDto } from "@shared/schemas/sessions.js";
import type {
  ContextWindowDto,
  SessionUsageTotalsDto,
  TurnUsageDto,
} from "@shared/schemas/usage.js";
import type { CompactionStatusDto } from "@shared/schemas/compaction.js";
import type { SessionPermission } from "@shared/schemas/sessions.js";
import {
  useContextWindow,
  useLastTurnUsage,
  useSessionUsageTotals,
} from "../../../lib/api/usage.js";
import {
  useCompactionLiveSync,
  useCompactionStatus,
} from "../../../lib/api/compaction.js";
import {
  usePreparation,
  usePreparationLiveSync,
} from "../../../lib/api/compaction-preparation.js";
import { useSessionModel } from "../../../lib/api/sessions.js";
import { CompactionApplyButton } from "../CompactionApplyButton.js";
import { ModelBrandIcon } from "../../wizard/steps/provider/ModelBrandIcon.js";
import { StateDot } from "../../../components/ui/state-dot.js";
import { CardStateNote, PortfolioCard } from "./portfolio/PortfolioCard.js";

export function SessionRuntimeCard({
  sessionId,
  permission = null,
}: {
  readonly sessionId: string;
  /**
   * Session permission, supplied by the shell that owns the session query
   * (BookPanel). Session-STATIC (locked at creation), so a prop cannot go
   * stale — and the card does not gain another query for one enum. `null`
   * while the parent's session read is in flight or absent.
   */
  readonly permission?: SessionPermission | null;
}): JSX.Element {
  useCompactionLiveSync(sessionId);
  usePreparationLiveSync(sessionId);

  const modelQuery = useSessionModel(sessionId);
  const lastTurnQuery = useLastTurnUsage(sessionId);
  const totalsQuery = useSessionUsageTotals(sessionId);
  const contextQuery = useContextWindow(sessionId);
  const compactionQuery = useCompactionStatus(sessionId);
  const preparationQuery = usePreparation(sessionId);

  const model = modelQuery.data?.ok ? modelQuery.data.data : null;
  const lastTurn = lastTurnQuery.data?.ok ? lastTurnQuery.data.data : null;
  const totals = totalsQuery.data?.ok ? totalsQuery.data.data : null;
  const context = contextQuery.data?.ok ? contextQuery.data.data : null;
  const compaction = compactionQuery.data?.ok ? compactionQuery.data.data : null;
  const preparation = preparationQuery.data?.ok
    ? preparationQuery.data.data
    : null;

  return (
    <PortfolioCard eyebrow="Runtime & Cost">
      <div
        data-vex-area="runtime-status"
        role="group"
        aria-label="Session runtime status"
        className="flex w-full flex-col gap-2.5 text-[11px] text-ink-tertiary"
      >
        <ModelLine model={model} />
        <UsageLine lastTurn={lastTurn} totals={totals} />
        <ContextMeter context={context} />
        <CompactionApplyButton
          sessionId={sessionId}
          preparation={preparation}
          permission={permission}
          stack
        />
        <CompactionNote status={compaction} />
      </div>
    </PortfolioCard>
  );
}

/** Muted key next to a stronger tabular value — the card's metric grammar. */
const METRIC_LABEL = "font-doto uppercase tracking-[0.16em] text-ink-tertiary";

function Metric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={METRIC_LABEL}>{label}</span>
      <span className="font-semibold tabular-nums text-ink-primary">{value}</span>
    </span>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(cost: number): string {
  return cost >= 1 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

/**
 * Sign-aware cost formatter for cache savings. `fmtCost(-0.0012)` would render
 * the misleading "$-0.0012"; negative NET savings (cache overhead / cache net)
 * format the magnitude and carry an explicit minus sign. No pricing math here
 * — the value arrives computed from the main process.
 */
function fmtSignedCost(cost: number): string {
  return cost < 0 ? `−${fmtCost(Math.abs(cost))}` : fmtCost(cost);
}

/**
 * Model identity + routing. The "via {provider}" line renders ONLY when main
 * reports a provider — the app must not claim a routing path it did not read.
 */
function ModelLine({
  model,
}: {
  readonly model: SessionModelDto | null;
}): JSX.Element {
  if (model === null || model.source === "unconfigured" || model.modelId === null) {
    return (
      <span
        data-vex-area="session-model-indicator"
        data-state="unconfigured"
        aria-label="Model not configured"
        className="text-[11px] text-ink-tertiary"
      >
        Model not configured
      </span>
    );
  }
  return (
    <span
      data-vex-area="session-model-indicator"
      data-state="configured"
      aria-label={`Model: ${model.modelId}`}
      className="flex min-w-0 items-center gap-2"
      title={`Global model${model.provider !== null ? ` · ${model.provider}` : ""} · ${model.modelId}`}
    >
      <ModelBrandIcon modelId={model.modelId} size={14} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="min-w-0 truncate text-[12px] text-ink-primary">
          {model.modelId}
        </span>
        {model.provider !== null ? (
          <span className="truncate text-[10.5px] text-ink-tertiary">
            via {model.provider}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function UsageLine({
  lastTurn,
  totals,
}: {
  readonly lastTurn: TurnUsageDto | null;
  readonly totals: SessionUsageTotalsDto | null;
}): JSX.Element | null {
  const hasTurns =
    lastTurn !== null || (totals !== null && totals.requestCount > 0);
  if (!hasTurns) return null;

  const cost = totals?.totalCost ?? null;
  // Cached (read-from-cache) and reasoning tokens for the last turn — both
  // already captured in the DB; surfaced here so the on-screen accounting is
  // complete rather than hidden in the tooltip.
  const cached =
    lastTurn !== null && lastTurn.cachedTokens > 0 ? lastTurn.cachedTokens : null;
  const reasoning =
    lastTurn !== null && lastTurn.reasoningTokens > 0
      ? lastTurn.reasoningTokens
      : null;

  return (
    <span
      data-vex-area="usage-meter"
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 tabular-nums text-[10.5px] text-ink-tertiary"
      title={buildUsageTitle(lastTurn, totals)}
    >
      {lastTurn !== null ? (
        <span aria-label="last turn tokens" className="inline-flex items-baseline gap-3">
          <Metric label="in" value={fmtTokens(lastTurn.promptTokens)} />
          <Metric label="out" value={fmtTokens(lastTurn.completionTokens)} />
        </span>
      ) : null}
      {cached !== null ? (
        <span aria-label="cached tokens">
          <Metric label="cache" value={fmtTokens(cached)} />
        </span>
      ) : null}
      {reasoning !== null ? (
        <span aria-label="reasoning tokens">
          <Metric label="reasoning" value={fmtTokens(reasoning)} />
        </span>
      ) : null}
      {cost !== null ? (
        <span
          aria-label="session cost"
          className="ml-auto tabular-nums text-ink-primary"
        >
          {fmtCost(cost)}
        </span>
      ) : null}
    </span>
  );
}

function buildUsageTitle(
  lastTurn: TurnUsageDto | null,
  totals: SessionUsageTotalsDto | null,
): string {
  const lines: string[] = [];
  if (lastTurn !== null) {
    lines.push(
      `Last turn: ${lastTurn.promptTokens} in / ${lastTurn.completionTokens} out` +
        ` (${lastTurn.totalTokens} total)`,
    );
    // Per-turn cache line: when a NET savings figure exists and is non-zero it
    // annotates the cached-token count (positive = saved, negative = overhead
    // from cache writes); otherwise fall back to the plain cached-token line.
    // Values arrive computed — no pricing math here.
    const turnSavings = lastTurn.cachedSavings;
    if (turnSavings !== null && turnSavings !== 0) {
      lines.push(
        turnSavings > 0
          ? `Cached: ${lastTurn.cachedTokens} tokens (saved ~${fmtSignedCost(turnSavings)})`
          : `Cached: ${lastTurn.cachedTokens} tokens (cache overhead ${fmtCost(Math.abs(turnSavings))})`,
      );
    } else if (lastTurn.cachedTokens > 0) {
      lines.push(`Cached: ${lastTurn.cachedTokens} tokens read from cache`);
    }
    if (lastTurn.reasoningTokens > 0) {
      lines.push(`Reasoning: ${lastTurn.reasoningTokens} tokens`);
    }
  }
  if (totals !== null) {
    lines.push(
      `Session: ${totals.totalTokens} tokens over ${totals.requestCount} request(s)`,
    );
    if (totals.totalCost !== null) {
      lines.push(`Cost: ${fmtCost(totals.totalCost)} ${totals.currency}`);
    }
    const sessionSavings = totals.totalCachedSavings;
    if (sessionSavings !== null && sessionSavings !== 0) {
      lines.push(
        sessionSavings > 0
          ? `Cache savings: ${fmtSignedCost(sessionSavings)} total`
          : `Cache net: ${fmtSignedCost(sessionSavings)} total`,
      );
    }
  }
  return lines.join("\n");
}

/** A pressure-band tick on the meter, positioned at the ENGINE's own fraction. */
function BandMarker({
  fraction,
  title,
}: {
  readonly fraction: number;
  readonly title: string;
}): JSX.Element {
  return (
    <span
      aria-hidden
      title={title}
      className="absolute inset-y-0 w-px bg-line-3"
      style={{ left: `${fraction * 100}%` }}
    />
  );
}

function ContextMeter({
  context,
}: {
  readonly context: ContextWindowDto | null;
}): JSX.Element | null {
  // `null` = session missing/deleted/out-of-scope → no meter at all.
  if (context === null) return null;

  const { tokensUsed, contextLimit } = context;

  // Invalid configured limit → show the (approximate) token count without a
  // bar rather than a fabricated denominator.
  if (contextLimit === null) {
    return (
      <span
        data-vex-area="session-context-meter"
        data-state="no-limit"
        className="flex items-baseline gap-2 text-[10.5px] tabular-nums"
        title="Context limit unavailable (invalid AGENT_CONTEXT_LIMIT)"
      >
        <Metric label="ctx" value={fmtTokens(tokensUsed)} />
      </span>
    );
  }

  const pct =
    contextLimit > 0
      ? Math.min(100, Math.max(0, Math.round((tokensUsed / contextLimit) * 100)))
      : 0;

  // The band edges come from main (engine policy). Absent = an older main:
  // draw no markers rather than invent positions.
  const barrier = context.pressureBarrierFraction;
  const autoCompactPct =
    barrier !== undefined ? Math.round(barrier * 100) : null;

  return (
    <div
      data-vex-area="session-context-meter"
      data-state="ok"
      className="flex flex-col gap-1"
    >
      <div
        className="flex items-center gap-2 text-[10.5px] tabular-nums"
        title={`Context (approx, lags one turn): ${tokensUsed} / ${contextLimit} tokens`}
        aria-label={`Context ${pct}% used`}
      >
        <span className={METRIC_LABEL}>ctx</span>
        <span
          className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-skeleton"
          aria-hidden
        >
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-accent-primary"
            style={{ width: `${pct}%` }}
          />
          {context.pressureWarningFraction !== undefined ? (
            <BandMarker
              fraction={context.pressureWarningFraction}
              title="Context pressure warning"
            />
          ) : null}
          {barrier !== undefined ? (
            <BandMarker fraction={barrier} title="Auto-compact barrier" />
          ) : null}
          {context.pressureCriticalFraction !== undefined ? (
            <BandMarker
              fraction={context.pressureCriticalFraction}
              title="Forced compaction"
            />
          ) : null}
        </span>
        <span className="shrink-0 text-ink-primary">{pct}%</span>
      </div>
      <p className="text-[10px] leading-snug text-ink-tertiary">
        {autoCompactPct !== null ? `Auto-compact ~${autoCompactPct}% · ` : ""}
        approx, lags one turn
      </p>
    </div>
  );
}

const COMPACTION_REMOTE_NOTE =
  "Builds session memory from older messages via your OpenRouter model; " +
  "the transcript is redacted before it is sent.";

function CompactionNote({
  status,
}: {
  readonly status: CompactionStatusDto | null;
}): JSX.Element | null {
  // `null` = session missing/deleted/out-of-scope → no chip.
  if (status === null) return null;

  const running = status.latest?.status === "running";
  const active = status.activeCount > 0;

  let label: string;
  let state: "running" | "queued" | "failed";
  if (active) {
    label = running ? "Compacting…" : "Compaction queued";
    state = running ? "running" : "queued";
  } else if (status.latest?.status === "permanently_failed") {
    label = "Compaction failed";
    state = "failed";
  } else {
    // Nothing in flight and no terminal failure → keep the card uncluttered.
    return null;
  }

  // The remote-path note lives in `aria-label` (NOT title-only) so it is
  // accessible without hover; `title` mirrors it for sighted pointer users.
  return (
    <span
      data-vex-area="session-compaction-chip"
      data-state={state}
      title={`${label} · ${COMPACTION_REMOTE_NOTE}`}
      aria-label={`Compaction status: ${label}. ${COMPACTION_REMOTE_NOTE}`}
      className="inline-flex items-center gap-1.5"
    >
      {/* Status grammar: the word carries the meaning, the StateDot the
        * motion (running = pixel chase). */}
      <StateDot
        state={
          state === "failed" ? "error" : state === "running" ? "ongoing" : "warning"
        }
        size={8}
      />
      <CardStateNote tone={state === "failed" ? "warn" : "muted"}>
        {label}
      </CardStateNote>
    </span>
  );
}
