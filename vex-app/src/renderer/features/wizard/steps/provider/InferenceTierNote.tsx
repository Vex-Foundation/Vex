/**
 * Free-vs-paid inference guidance for the wizard's Provider step.
 *
 * OpenRouter lists free and paid variants of many models side by side, and
 * from the picker they look interchangeable. For a long unattended agentic run
 * they are not, and the difference only shows up hours in — when the mission
 * parks. This note states the tradeoff before the user picks, rather than
 * leaving them to discover it from a stalled run.
 *
 * Deliberately collapsed and deliberately qualitative:
 *
 *  - Collapsed, because the default single-model path should stay light. The
 *    trigger names the tradeoff so it is skippable without being invisible.
 *  - NO prices and NO model names in the copy. Both change constantly, and a
 *    stale hardcoded number in onboarding is worse than no number — it reads
 *    as authoritative long after it stopped being true. Anything volatile is
 *    delegated to OpenRouter's live pages via the links below.
 *  - Balanced, not a paid upsell. Free models are genuinely fine for light
 *    experimentation and as a failover target; the frontier tier is NOT
 *    required for good agent behaviour. The honest recommendation is a
 *    capable mid-tier paid model, and the copy says exactly that.
 */

import { useState, type JSX } from "react";

const ACCENT_LINK =
  "text-[var(--vex-onboarding-accent)] underline-offset-2 hover:underline";

export function InferenceTierNote(): JSX.Element {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-vex-provider-tier-note="collapsed"
        className={`self-start text-xs ${ACCENT_LINK}`}
      >
        Free or paid model — what to expect
      </button>
    );
  }

  return (
    <div
      data-vex-provider-tier-note="open"
      className="flex flex-col gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3 text-xs text-[var(--color-text-muted)]"
    >
      <p>
        <strong className="font-semibold text-[var(--color-text-primary)]">
          Free models cost nothing but are rate limited.
        </strong>{" "}
        A single agent run makes many sequential requests as it calls tools and
        reads results, so it can hit the limit partway through and park the
        mission mid-run. Free tiers also cap how much you can use per day.
      </p>
      <p>
        <strong className="font-semibold text-[var(--color-text-primary)]">
          Free endpoints usually keep your prompts.
        </strong>{" "}
        Providers serving free traffic commonly retain it and may train on it.
        If that matters, you can restrict routing to providers that do not
        train on your inputs in{" "}
        <a
          href="https://openrouter.ai/settings/privacy"
          target="_blank"
          rel="noreferrer"
          className={ACCENT_LINK}
        >
          OpenRouter&rsquo;s privacy settings
        </a>
        .
      </p>
      <p>
        <strong className="font-semibold text-[var(--color-text-primary)]">
          Paid is typically cents per run
        </strong>{" "}
        and far steadier over a long session, which is what an unattended agent
        needs most.
      </p>
      <p>
        You do not need a frontier model — a capable mid-tier paid model is the
        sweet spot for agent work. A free model is a reasonable choice for
        light experimentation, or as a fallback. Current pricing and rate
        limits for every model are listed at{" "}
        <a
          href="https://openrouter.ai/models"
          target="_blank"
          rel="noreferrer"
          className={ACCENT_LINK}
        >
          openrouter.ai/models
        </a>
        .
      </p>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className={`self-start ${ACCENT_LINK}`}
      >
        Hide
      </button>
    </div>
  );
}
