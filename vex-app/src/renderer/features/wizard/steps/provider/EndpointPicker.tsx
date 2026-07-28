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
 */

import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import type { ProviderEndpointOption } from "@shared/schemas/provider-endpoints.js";
import { Label } from "../../../../components/ui/label.js";
import { cn } from "../../../../lib/utils.js";
import { formatEndpointMeta } from "./formatEndpointMeta.js";

export interface EndpointPickerProps {
  readonly id: string;
  /** Selected endpoint tag, or `null` for Auto. */
  readonly value: string | null;
  readonly endpoints: ReadonlyArray<ProviderEndpointOption>;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly disabled?: boolean;
  readonly onChange: (endpointTag: string | null) => void;
  readonly onRetry: () => void;
}

const ROW_CLASS =
  "flex w-full cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-left";

export function EndpointPicker({
  id,
  value,
  endpoints,
  loading,
  failed,
  disabled = false,
  onChange,
  onRetry,
}: EndpointPickerProps): JSX.Element {
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
            <HugeiconsIcon icon={RefreshIcon} size={12} aria-hidden />
            Retry
          </button>
        </div>
      ) : (
        <div
          id={id}
          role="radiogroup"
          aria-label="OpenRouter provider"
          className="flex flex-col gap-1.5"
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
                  <span className="block truncate text-sm">
                    {endpoint.providerName}
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
        the others. Prices are base rates per 1M tokens; long-context and
        time-window tiers can differ. Pinning one provider turns off
        OpenRouter&apos;s automatic failover.
      </p>
    </div>
  );
}
