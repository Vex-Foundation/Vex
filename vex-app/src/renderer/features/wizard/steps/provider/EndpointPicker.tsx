/**
 * Provider (endpoint) select for the wizard's provider step.
 *
 * OpenRouter serves one model from several endpoints that differ in price,
 * context window and quantization. This list is the operator's chance to pin
 * one. It renders ONLY after an exact catalogue model selection - a
 * typed-but-unlisted model id has no endpoint list, so the step stays
 * Auto-only and nothing is fetched per keystroke.
 *
 * Copy honesty: the list is filtered to endpoints that support TOOL CALLING.
 * That is not a claim of general parameter compatibility - Vex also sends
 * `toolChoice` and `maxTokens`, and strict compatibility is enforced at
 * request time. The wording here says exactly what the filter does.
 *
 * `null` value ⇒ "Auto (recommended)": no pin, OpenRouter routes (and its own
 * sticky-session routing stays in play, which a manual pin disables).
 *
 * ORDER + SUGGESTION: rows arrive ranked by availability (main owns the rule,
 * `main/onboarding/provider-endpoint-availability.ts`). The top row may carry a
 * "Suggested" badge. It is a HINT - this component never calls `onChange` on
 * its own, so the badge cannot move the operator's pin.
 *
 * HEIGHT: the live catalogue runs past 20 endpoints, which pushed the whole
 * wizard page into a scroll just to reach the list. The rows live in their own
 * bounded, scrollable region sized to ~5 rows (repo-native `vex-scroll` +
 * `overflow-y-auto`, as in `GlobalApprovals` / `ModelPicker`). A pin outside
 * that window is scrolled into view on mount so the current choice is never
 * hidden.
 *
 * R3 grammar: a `.vex-wz-group` (label, the list, the hint). The list is one
 * ruled box of picker rows (`.vex-wz-picker__o`): the name, the mono tag under
 * it, the meta line below; the chosen row takes the selection wash with a blue
 * name (`data-active` is the wash's hook here, `aria-checked` stays the radio
 * state). No roles, ids or data seams change.
 */

import { useEffect, useRef, type JSX } from "react";
import { IconRefresh } from "../../../../components/icons/index.js";
import type { ProviderEndpointOption } from "@shared/schemas/provider-endpoints.js";
import { Label } from "../../../../components/ui/label.js";
import { cn } from "../../../../lib/utils.js";
import { formatEndpointMeta } from "./formatEndpointMeta.js";

export interface EndpointPickerProps {
  readonly id: string;
  /** Selected endpoint tag, or `null` for Auto. */
  readonly value: string | null;
  readonly endpoints: ReadonlyArray<ProviderEndpointOption>;
  /** Tag main suggests, or `null`. Display-only - never applied automatically. */
  readonly suggestedEndpointTag?: string | null;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly disabled?: boolean;
  readonly onChange: (endpointTag: string | null) => void;
  readonly onRetry: () => void;
}

const ROW_CLASS =
  "vex-wz-picker__o cursor-pointer disabled:cursor-not-allowed";

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
    <div className="vex-wz-group" data-vex-provider-endpoints>
      <Label htmlFor={id}>Provider</Label>

      {loading ? (
        <p
          className="vex-wz-hint"
          data-vex-provider-endpoints-state="loading"
        >
          Loading providers for this model…
        </p>
      ) : failed ? (
        <div
          className="flex items-center justify-between gap-3"
          data-vex-provider-endpoints-state="failed"
        >
          <p className="vex-wz-hint text-ink-secondary">
            Provider list unavailable. Auto routing still works.
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="vex-wz-link shrink-0"
          >
            <IconRefresh size={12} />
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
            "vex-scroll flex flex-col overflow-y-auto border border-rule bg-surface-field",
            LIST_MAX_HEIGHT_CLASS,
          )}
        >
          <button
            type="button"
            role="radio"
            aria-checked={value === null}
            disabled={disabled}
            data-vex-provider-endpoint="auto"
            data-active={value === null ? "" : undefined}
            onClick={() => onChange(null)}
            className={ROW_CLASS}
          >
            <span className="vex-wz-picker__t block">Auto (recommended)</span>
            <span className="col-span-2 text-[12.5px] text-ink-tertiary">
              OpenRouter picks and fails over between providers.
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
                data-active={value === endpoint.tag ? "" : undefined}
                onClick={() => onChange(endpoint.tag)}
                className={ROW_CLASS}
              >
                <span className="vex-wz-picker__t flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate">
                    {endpoint.providerName}
                  </span>
                  {suggestedEndpointTag === endpoint.tag ? (
                    <span
                      data-vex-provider-endpoint-suggested
                      className="shrink-0 border border-accent-primary px-1.5 text-[11.5px] font-normal leading-[1.5] text-accent-primary"
                    >
                      Suggested
                    </span>
                  ) : null}
                </span>
                <span className="vex-wz-picker__m min-w-0 truncate">
                  {endpoint.tag}
                </span>
                {meta ? (
                  <span className="col-span-2 text-[12.5px] text-ink-tertiary">
                    {meta}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      <p className="vex-wz-hint">
        <span>
          Only providers that support tool calling are listed - Vex cannot run
          on the others. Ordered by recent uptime, most available first;
          providers OpenRouter reports no uptime for are listed last. Prices
          are base rates per 1M tokens; long-context and time-window tiers can
          differ. Pinning one provider turns off OpenRouter&apos;s automatic
          failover.
        </span>
      </p>
    </div>
  );
}
