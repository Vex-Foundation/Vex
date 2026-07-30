/**
 * Provider (endpoint) select for the wizard's provider step.
 *
 * OpenRouter serves one model from several endpoints that differ in price,
 * context window and quantization. This list is the operator's chance to pin
 * one. It renders ONLY after an exact catalogue model selection — a
 * typed-but-unlisted model id has no endpoint list, so the step stays
 * Auto-only and nothing is fetched per keystroke.
 *
 * Copy honesty: the list is filtered to endpoints that support TOOL CALLING.
 * That is not a claim of general parameter compatibility — Vex also sends
 * `toolChoice` and `maxTokens`, and strict compatibility is enforced at
 * request time. The wording here says exactly what the filter does.
 *
 * `null` value ⇒ "Auto (recommended)": no pin, OpenRouter routes (and its own
 * sticky-session routing stays in play, which a manual pin disables).
 *
 * ORDER + SUGGESTION: rows arrive ranked by availability (main owns the rule,
 * `main/onboarding/provider-endpoint-availability.ts`). The top row may carry a
 * "Suggested" badge. It is a HINT — this component never calls `onChange` on
 * its own, so the badge cannot move the operator's pin.
 *
 * HEIGHT: the live catalogue runs past 20 endpoints, which pushed the whole
 * wizard page into a scroll just to reach the list. The rows live in their own
 * bounded, scrollable region sized to ~5 rows (repo-native `vex-scroll` +
 * `overflow-y-auto`, as in `GlobalApprovals` / `ModelPicker`). A pin outside
 * that window is scrolled into view on mount so the current choice is never
 * hidden.
 */

import { useEffect, useRef, type JSX } from "react";
import { RefreshIcon, VexIcon } from "../../../../components/icons/index.js";
import type { ProviderEndpointOption } from "@shared/schemas/provider-endpoints.js";
import { Label } from "../../../../components/ui/label.js";
import { cn } from "../../../../lib/utils.js";
import { formatEndpointMeta } from "./formatEndpointMeta.js";

export interface EndpointPickerProps {
  readonly id: string;
  /** Selected endpoint tag, or `null` for Auto. */
  readonly value: string | null;
  readonly endpoints: ReadonlyArray<ProviderEndpointOption>;
  /** Tag main suggests, or `null`. Display-only — never applied automatically. */
  readonly suggestedEndpointTag?: string | null;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly disabled?: boolean;
  readonly onChange: (endpointTag: string | null) => void;
  readonly onRetry: () => void;
}

const ROW_CLASS =
  "flex w-full cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-left";

/**
 * Bounded to roughly five rows. Expressed in `rem` rather than a row count
 * because rows are two or three lines tall depending on the metadata present;
 * this is the height at which a fifth row is clearly half-visible, which is the
 * affordance that tells the operator the region scrolls.
 */
const LIST_MAX_HEIGHT_CLASS = "max-h-[19rem]";

export function EndpointPicker({
  id,
  value,
  endpoints,
  suggestedEndpointTag = null,
  loading,
  failed,
  disabled = false,
  onChange,
  onRetry,
}: EndpointPickerProps): JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null);

  // Reveal a pin that sits below the visible window. Runs on the selected tag
  // (not on every render) so it cannot fight the operator's own scrolling, and
  // `block: "nearest"` leaves an already-visible row untouched. jsdom does not
  // implement `scrollIntoView`; feature-checked exactly as `ApprovalLinkStamp`
  // does, so tests and older runtimes degrade to no-op instead of throwing.
  useEffect(() => {
    if (value === null) return;
    const list = listRef.current;
    if (list === null) return;
    // Matched by dataset rather than an interpolated attribute selector: a tag
    // is provider-controlled text and must not be spliced into a selector.
    const row = [
      ...list.querySelectorAll<HTMLElement>("[data-vex-provider-endpoint]"),
    ].find((candidate) => candidate.dataset.vexProviderEndpoint === value);
    if (row === undefined || typeof row.scrollIntoView !== "function") return;
    row.scrollIntoView({ block: "nearest" });
  }, [value]);

  return (
    <div className="flex flex-col gap-2" data-vex-provider-endpoints>
      <Label htmlFor={id}>Provider</Label>

      {loading ? (
        <p
          className="text-xs text-[var(--color-text-muted)]"
          data-vex-provider-endpoints-state="loading"
        >
          Loading providers for this model…
        </p>
      ) : failed ? (
        <div
          className="flex items-center justify-between gap-3"
          data-vex-provider-endpoints-state="failed"
        >
          <p className="text-xs text-[var(--color-text-secondary)]">
            Provider list unavailable. Auto routing still works.
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex shrink-0 items-center gap-1 text-xs text-[var(--color-text-primary)] underline underline-offset-2 hover:text-[var(--color-text-secondary)]"
          >
            <VexIcon icon={RefreshIcon} size={12} aria-hidden />
            Retry
          </button>
        </div>
      ) : (
        <div
          id={id}
          ref={listRef}
          role="radiogroup"
          aria-label="OpenRouter provider"
          data-vex-provider-endpoint-list
          className={cn(
            "vex-scroll flex flex-col gap-1.5 overflow-y-auto pr-1",
            LIST_MAX_HEIGHT_CLASS,
          )}
        >
          <button
            type="button"
            role="radio"
            aria-checked={value === null}
            disabled={disabled}
            data-vex-provider-endpoint="auto"
            onClick={() => onChange(null)}
            className={cn(
              ROW_CLASS,
              value === null
                ? "border-[var(--vex-accent,var(--color-accent-primary))] text-foreground"
                : "border-[var(--color-border)] text-[var(--color-text-secondary)]",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm">Auto (recommended)</span>
              <span className="block text-[11px] text-[var(--color-text-muted)]">
                OpenRouter picks and fails over between providers.
              </span>
            </span>
          </button>

          {endpoints.map((endpoint) => {
            const meta = formatEndpointMeta(endpoint);
            return (
              <button
                key={endpoint.tag}
                type="button"
                role="radio"
                aria-checked={value === endpoint.tag}
                disabled={disabled}
                data-vex-provider-endpoint={endpoint.tag}
                onClick={() => onChange(endpoint.tag)}
                className={cn(
                  ROW_CLASS,
                  value === endpoint.tag
                    ? "border-[var(--vex-accent,var(--color-accent-primary))] text-foreground"
                    : "border-[var(--color-border)] text-[var(--color-text-secondary)]",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate text-sm">
                      {endpoint.providerName}
                    </span>
                    {suggestedEndpointTag === endpoint.tag ? (
                      <span
                        data-vex-provider-endpoint-suggested
                        className="shrink-0 rounded-full border border-[var(--vex-accent,var(--color-accent-primary))] px-1.5 py-px text-[9px] uppercase tracking-wide text-[var(--vex-accent,var(--color-accent-primary))]"
                      >
                        Suggested
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-[var(--color-text-muted)]">
                    {endpoint.tag}
                  </span>
                  {meta ? (
                    <span className="block truncate text-[10px] text-[var(--color-text-muted)]">
                      {meta}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <p className="text-xs text-[var(--color-text-muted)]">
        Only providers that support tool calling are listed — Vex cannot run on
        the others. Ordered by recent uptime, most available first; providers
        OpenRouter reports no uptime for are listed last. Prices are base rates
        per 1M tokens; long-context and time-window tiers can differ. Pinning
        one provider turns off OpenRouter&apos;s automatic failover.
      </p>
    </div>
  );
}
