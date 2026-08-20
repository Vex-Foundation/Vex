/**
 * Context-occupancy ring (A29): a small SVG ring beside the send key fed by
 * the same `useContextWindow` channel the runtime card reads, with a tooltip
 * carrying the token breakdown. Renders nothing until the engine reports
 * both a token count and a valid limit - no fabricated denominators. Tint
 * follows the ENGINE's own pressure bands from the DTO, never a local
 * threshold.
 */

import type { JSX } from "react";
import type { ContextWindowDto } from "@shared/schemas/usage.js";
import { useContextWindow } from "../../../lib/api/usage.js";
import { Tooltip } from "../../../components/ui/tooltip.js";

/** Ring geometry: 14px viewBox, 2px stroke. */
const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function contextRingTone(
  fraction: number,
  context: ContextWindowDto,
): "ok" | "warn" | "critical" {
  const critical = context.pressureCriticalFraction;
  if (critical !== undefined && fraction >= critical) return "critical";
  const warning = context.pressureWarningFraction;
  if (warning !== undefined && fraction >= warning) return "warn";
  return "ok";
}

const TONE_CLASS: Readonly<Record<"ok" | "warn" | "critical", string>> = {
  ok: "text-accent-primary",
  warn: "text-warning",
  critical: "text-danger",
};

export function ComposerContextRing({
  sessionId,
}: {
  readonly sessionId: string;
}): JSX.Element | null {
  const contextQuery = useContextWindow(sessionId);
  const context = contextQuery.data?.ok ? contextQuery.data.data : null;
  if (context === null || context.contextLimit === null) return null;
  const { tokensUsed, contextLimit } = context;
  if (contextLimit <= 0) return null;

  const fraction = Math.min(1, Math.max(0, tokensUsed / contextLimit));
  const percent = Math.round(fraction * 100);
  const tone = contextRingTone(fraction, context);
  const barrier = context.pressureBarrierFraction;
  // Tooltip speaks pre-line strings, so the breakdown rides one label.
  const label = [
    `Context: ~${formatTokens(tokensUsed)} / ${formatTokens(contextLimit)} tokens (${percent}%)`,
    ...(barrier !== undefined
      ? [`Auto-compact at ~${Math.round(barrier * 100)}%`]
      : []),
    "Approximate - lags the live turn by one.",
  ].join("\n");

  return (
    <Tooltip label={label} side="top" delayMs={200}>
      <span
        data-vex-area="composer-context-ring"
        data-tone={tone}
        role="img"
        aria-label={`Context ${percent}% used`}
        className={`inline-flex h-7 w-7 items-center justify-center ${TONE_CLASS[tone]}`}
      >
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
          <circle
            cx="7"
            cy="7"
            r={RADIUS}
            fill="none"
            stroke="var(--vex-alias-border-l3)"
            strokeWidth="2"
          />
          <circle
            cx="7"
            cy="7"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${(CIRCUMFERENCE * percent) / 100} ${CIRCUMFERENCE}`}
            transform="rotate(-90 7 7)"
          />
        </svg>
      </span>
    </Tooltip>
  );
}
