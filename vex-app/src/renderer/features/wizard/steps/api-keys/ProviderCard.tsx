/**
 * ProviderCard — per-provider section primitive used by ApiKeysStep
 * (Chronos Phase 2b redesign: one calm card per provider).
 *
 * Renders a hairline card with:
 *   - 36×36 icon slot (caller passes a brand SVG / `<img>`)
 *   - provider name + a STATUS WORD (mono micro-label in the status
 *     color — the design law says state is a colored word, never a
 *     dot, glyph, or pill)
 *   - one-line "what Vex uses it for" sentence (`description`)
 *   - optional longer how-to / caveat copy (`detail`)
 *   - optional "Get key" link (target="_blank", rel="noopener noreferrer")
 *   - body slot (children) — the actual input or auto-setup section
 *
 * Kept generic on purpose: the three providers (Jupiter / Tavily /
 * Rettiwt) differ in iconography and CTA wiring, but the outer chrome
 * is identical so this primitive avoids a 3× duplication inside
 * ApiKeysStep (rule 18 — "stop duplication early").
 *
 * Colors ride the gate/shell token re-projection (`--color-text-*`),
 * so the same card reads correctly on the cobalt plate and inside the
 * ink-glass Settings screen.
 */

import type { JSX, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { cn } from "../../../../lib/utils.js";

export type ProviderCardSlug = "jupiter" | "tavily" | "rettiwt";

export type ProviderCardStatusTone = "set" | "partial" | "unset";

export interface ProviderCardStatus {
  readonly tone: ProviderCardStatusTone;
  readonly label: string;
}

export interface ProviderCardGetKey {
  readonly url: string;
  readonly label: string;
}

export interface ProviderCardProps {
  readonly slug: ProviderCardSlug;
  readonly iconSlot: ReactNode;
  readonly name: string;
  readonly status: ProviderCardStatus;
  /** One quiet sentence: what Vex uses this key for. */
  readonly description: ReactNode;
  /** Optional longer how-to / caveat copy under the description. */
  readonly detail?: ReactNode;
  readonly getKey?: ProviderCardGetKey;
  readonly children: ReactNode;
}

const CARD_CHROME = cn(
  // A3 boxless: one hairline-separated section per provider, no tile.
  "flex flex-col gap-3 border-t border-[var(--color-border)] pt-5",
);

const ICON_TILE_CHROME = cn(
  "flex h-9 w-9 shrink-0 items-center justify-center",
  "text-[var(--color-text-primary)]",
);

const STATUS_WORD_COLOR: Record<ProviderCardStatusTone, string> = {
  set: "text-[var(--color-success)]",
  partial: "text-[var(--color-warning)]",
  unset: "text-[var(--color-text-muted)]",
};

function StatusWord({ status }: { status: ProviderCardStatus }): JSX.Element {
  return (
    <span
      className={cn(
        "shrink-0 vex-micro",
        STATUS_WORD_COLOR[status.tone],
      )}
    >
      {status.label}
    </span>
  );
}

function GetKeyLink({ getKey }: { getKey: ProviderCardGetKey }): JSX.Element {
  return (
    <a
      href={getKey.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex w-fit items-center gap-1.5 text-xs font-medium",
        "text-[var(--color-text-primary)] underline underline-offset-2 transition-colors",
        "hover:text-[var(--color-text-secondary)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
      )}
    >
      {getKey.label}
      <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} aria-hidden />
    </a>
  );
}

export function ProviderCard({
  slug,
  iconSlot,
  name,
  status,
  description,
  detail,
  getKey,
  children,
}: ProviderCardProps): JSX.Element {
  return (
    <section
      data-vex-apikeys-card={slug}
      aria-labelledby={`vex-apikeys-card-${slug}-name`}
      className={CARD_CHROME}
    >
      <header className="flex items-start gap-3">
        <span aria-hidden className={ICON_TILE_CHROME}>
          {iconSlot}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3
              id={`vex-apikeys-card-${slug}-name`}
              className="text-sm font-semibold text-[var(--color-text-primary)]"
            >
              {name}
            </h3>
            <StatusWord status={status} />
          </div>
          <p className="text-sm leading-relaxed text-[var(--color-text-secondary)]">
            {description}
          </p>
          {detail ? (
            <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
              {detail}
            </p>
          ) : null}
          {getKey ? <GetKeyLink getKey={getKey} /> : null}
        </div>
      </header>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}
