/**
 * Branch: running — Docker Compose up is in flight. The hero VexLoader
 * ring (paper tone) anchors the body; the two services (Postgres +
 * Embeddings) render as quiet hairline rows reading aggregated substate
 * from the parsed log stream — an inline VexLoader while a service is
 * starting/probing, then a colored status word once it settles. A
 * subordinate ghost Cancel closes the body (the paper-pill Continue
 * appears only once the phase flips to `ready`).
 *
 * The `data-vex-compose-cancel` / `data-vex-compose-cancelling`
 * attribute pair on the Cancel button is a public test contract (PR3
 * cancellation) — do not rename.
 */

import { VexLoader } from "../../../../components/ui/vex-loader.js";
import { Button } from "../../../../components/ui/button.js";
import { cn } from "../../../../lib/utils.js";
import type { AggregatedServiceState, ServiceStatus } from "../types.js";

interface RunningBodyProps {
  readonly services: AggregatedServiceState[];
  readonly onCancel: () => void;
  readonly cancelling: boolean;
}

/** Status word ink — paper-alpha while working, tokens once settled. */
const statusInk: Record<ServiceStatus, string> = {
  starting: "text-ink-tertiary",
  probing: "text-ink-secondary",
  ready: "text-[var(--color-success)]",
  failed: "text-[var(--color-danger)]",
};

export function RunningBody({
  services,
  onCancel,
  cancelling,
}: RunningBodyProps): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      {/* HERO — the ring at work, centered above the service rows. */}
      <div className="flex justify-center pt-2">
        <VexLoader
          size={72}
          stroke={2}
          tone="paper"
          label="Starting services"
        />
      </div>

      {/* SERVICE ROWS — one hairline row per service. */}
      <ul className="flex w-full flex-col">
        {services.map((s) => (
          <li
            key={s.service}
            className="flex items-center gap-3 border-t border-[var(--color-border)] py-4 first:border-t-0"
            data-service={s.service}
            data-status={s.status}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium text-ink-primary">
                {s.service}
              </span>
              <span className="truncate font-mono text-xs text-ink-tertiary">
                {s.detail}
              </span>
            </div>
            <span className="flex shrink-0 items-center gap-2">
              {s.status === "starting" || s.status === "probing" ? (
                <VexLoader
                  size={16}
                  stroke={2}
                  tone="paper"
                  label={`${s.service} ${s.status}`}
                />
              ) : null}
              <span
                className={cn(
                  "vex-micro",
                  statusInk[s.status],
                )}
              >
                {s.status}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <Button
        variant="ghost"
        disabled={cancelling}
        onClick={onCancel}
        {...(cancelling
          ? { "data-vex-compose-cancelling": "" }
          : { "data-vex-compose-cancel": "" })}
        className="self-center text-ink-secondary"
      >
        {cancelling ? "Cancelling…" : "Cancel"}
      </Button>
    </div>
  );
}
