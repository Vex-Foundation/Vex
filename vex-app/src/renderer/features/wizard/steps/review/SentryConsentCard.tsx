/**
 * Sentry consent control (M11 Step 9).
 *
 * Two surfaces:
 *   - telemetryAvailable=false (DSN missing in this build) → static
 *     notice, no checkbox. Phase 1 dev release without baked DSN
 *     intentionally has no telemetry path (codex v3 D5).
 *   - telemetryAvailable=true → checkbox + collapse with the 5-7
 *     bullets explaining what we collect AND what we never collect.
 *     Default unchecked — the operator must affirmatively opt in.
 */

import { useState, type JSX } from "react";
import { SummaryCard } from "./cards/SummaryCard.js";

export interface SentryConsentCardProps {
  readonly telemetryAvailable: boolean;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly disabled: boolean;
}

const COLLECTED_BULLETS: ReadonlyArray<string> = [
  "Crash + uncaught error stack traces (file paths and secret-like strings redacted).",
  "App version, OS family, Electron + Node versions.",
  "Wizard step id and IPC channel name (without payloads) as breadcrumbs.",
  "A random anonymous install ID — not tied to your wallet or any account.",
];

const NEVER_BULLETS: ReadonlyArray<string> = [
  "Private keys, mnemonics, master password, API keys, or any wallet address.",
  "Chat messages, mission prompts, or tool tool-call arguments / outputs.",
  "Transaction proposals, signatures, or any on-chain payload.",
  "File paths inside your home directory or any local data.",
];

export function SentryConsentCard({
  telemetryAvailable,
  checked,
  onChange,
  disabled,
}: SentryConsentCardProps): JSX.Element {
  const [showDetails, setShowDetails] = useState(false);

  if (!telemetryAvailable) {
    return (
      <SummaryCard
        title="Anonymous error reporting"
        status="info"
        statusLabel="Unavailable in this build"
        testId="sentry-consent"
      >
        This Vex build does not have a telemetry endpoint configured.
        Errors stay on your machine in the local log files.
      </SummaryCard>
    );
  }

  return (
    <div
      className="flex flex-col gap-3 border-b border-[var(--color-border)] pb-3 last:border-0"
      data-vex-review-card="sentry-consent"
    >
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1 accent-accent-primary"
        />
        <span className="flex flex-col">
          <span className="text-sm font-medium text-ink-primary">
            Send anonymous error reports to help improve Vex
          </span>
          <span className="text-xs text-ink-secondary">
            Default: off. Nothing is sent unless you tick this box.
          </span>
        </span>
      </label>

      <details
        open={showDetails}
        onToggle={(e) => setShowDetails((e.target as HTMLDetailsElement).open)}
        className="border-y border-[var(--color-border)] py-3"
      >
        <summary className="cursor-pointer text-xs font-medium text-ink-primary">
          What we collect / never collect
        </summary>
        <div className="mt-3 flex flex-col gap-3 text-xs text-ink-secondary">
          <div>
            <p className="font-semibold text-ink-primary">
              Collected (only with this opt-in):
            </p>
            <ul className="mt-1 list-disc pl-5">
              {COLLECTED_BULLETS.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-semibold text-success">
              Never sent (regardless of consent):
            </p>
            <ul className="mt-1 list-disc pl-5">
              {NEVER_BULLETS.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
          <p className="text-ink-tertiary">
            Stack traces and breadcrumbs are scrubbed in the main process
            before they leave your machine — see <code>main/logger/redact.ts</code>{" "}
            and <code>main/telemetry/before-send.ts</code> in the source.
          </p>
        </div>
      </details>
    </div>
  );
}
