/**
 * Presentational pieces + pure formatters for the mission contract surface.
 *
 * Originally extracted from the inline `MissionContractCard`; that card was
 * retired when the contract moved into `MissionContractModal` (the MISSION RAIL
 * redesign). What survives here is exactly what the modal still reuses — the
 * read-only `CardBody` (goal / constraints / restrictions / criteria) and the
 * presentational `AutoRetrySection` toggle. The card's `CardHeader` / `CardFooter`
 * went with the card: the modal renders the title + status badge in its
 * `DialogHeader` and reproduces the Accept action in its pinned `DialogFooter`.
 *
 * Every component here stays purely presentational — no hooks, no fetches, no
 * event handlers other than the typed `onToggle` the modal threads through.
 */

import type { JSX } from "react";
import type { MissionDeployedCapital, MissionDraftDto } from "@shared/schemas/mission.js";
import { chainDisplay } from "@shared/chains/display.js";
import { cn } from "../../lib/utils.js";

/**
 * The deployed-capital ticker charset, mirrored BY VALUE from the engine's
 * `ASSET_SYMBOL_PATTERN` (`src/vex-agent/engine/mission/deployed-capital.ts`),
 * which is the charset the acceptance hash was computed under.
 *
 * Deliberately NOT the shared `sanitizeTokenSymbol`. That sanitizer guards
 * provider-sourced symbols on other surfaces and additionally requires an
 * ALPHANUMERIC FIRST CHARACTER, which is stricter than the engine here: it
 * would drop `$VEX` (the project's own token symbol), `_TOKEN` and `.TOKEN`.
 * Omitting valid hash-bound metadata is its own honesty failure, so this
 * surface matches the engine exactly rather than borrowing a stricter rule.
 * The shared sanitizer is left untouched for its own callers.
 *
 * The shared DTO schema already enforces this same charset at the IPC
 * boundary; this check is defense in depth against a schema drift, so a
 * symbol that somehow reaches the renderer outside the charset is still
 * dropped from the line rather than rendered.
 */
const DEPLOYED_CAPITAL_SYMBOL_PATTERN = /^[A-Za-z0-9_.$-]{1,32}$/;

function displayableAssetSymbol(symbol: string): string | null {
  return DEPLOYED_CAPITAL_SYMBOL_PATTERN.test(symbol) ? symbol : null;
}

/**
 * Contract state machine kinds shared by the modal. Kept here (rather than in
 * the modal) so the badge/derivation code can import a single canonical union.
 */
export type CardStateKind =
  | "setup-needed"
  | "awaiting-acceptance"
  | "accepted"
  | "dirty-acceptance";

export interface CardBodyProps {
  readonly draft: MissionDraftDto;
}

export function CardBody({ draft }: CardBodyProps): JSX.Element {
  const constraints = formatConstraints(draft);
  const restrictions = formatRestrictions(draft);
  return (
    <div className="space-y-3 rounded-xl border border-line-1 bg-surface-1 px-4 py-3 text-ink-secondary">
      <Field label="Goal">
        <p className="text-ink-primary">
          {draft.goal?.trim() || (
            <span className="italic text-ink-tertiary">
              (no goal yet - talk to Vex to outline one)
            </span>
          )}
        </p>
      </Field>
      {constraints.length > 0 ? (
        <Field label="Constraints">
          <ul className="space-y-0.5">
            {constraints.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Field>
      ) : null}
      <DeployedCapitalField capital={draft.deployedCapital} />
      {restrictions.length > 0 ? (
        <Field label="Restrictions">
          <ChipList items={restrictions} />
        </Field>
      ) : null}
      {draft.successCriteria.length > 0 ? (
        <Field label="Success criteria">
          <BulletList items={draft.successCriteria} />
        </Field>
      ) : null}
      {draft.stopConditions.length > 0 ? (
        <Field
          label="Stop conditions"
          hint="Host-only - Vex cannot change these"
        >
          <BulletList items={draft.stopConditions} />
        </Field>
      ) : null}
      {draft.renewedFromMissionId !== null ? (
        <p className="text-xs italic text-ink-tertiary">
          Renewed from mission{" "}
          <span className="font-mono">{draft.renewedFromMissionId}</span>
        </p>
      ) : null}
    </div>
  );
}

interface FieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly children: JSX.Element | string;
}

function Field({ label, hint, children }: FieldProps): JSX.Element {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 vex-micro-label uppercase text-ink-secondary">
        <span>{label}</span>
        {hint ? <span className="text-[10px] italic">· {hint}</span> : null}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/**
 * C3 - the deployed-capital declaration, ALWAYS rendered.
 *
 * This field is bound into the acceptance hash (contract v6), so the host must
 * be able to see it before accepting; a hash-covered field the card hides is a
 * blind signature. It is a measurement base, not a spend ceiling, which is why
 * it sits on its own rather than in the constraints list.
 *
 * Two rules this component must keep:
 *
 *   - NO CONVERSION HERE. `amountHuman` arrives already derived in the main
 *     process. When it is null the primary line prints the raw pair instead;
 *     the renderer never performs a base-unit shift, because a decimals slip in
 *     the UI is a thousandfold misstatement of the mission's own denominator
 *     (rule 90). The raw + decimals detail line is shown either way, so the
 *     underlying figure is always auditable.
 *   - ABSENCE IS SHOWN, NOT OMITTED. An undeclared base is what suppresses the
 *     measurability warnings, so "Not declared" is real information about the
 *     contract, not an empty state to hide.
 *
 * `assetSymbol` is model-written, attacker-influenceable text, so it is checked
 * against the engine's ticker charset (see `DEPLOYED_CAPITAL_SYMBOL_PATTERN`);
 * a rejected symbol is dropped from the line rather than printed, and the asset
 * address below remains the unambiguous identity.
 */
function DeployedCapitalField({
  capital,
}: {
  readonly capital: MissionDeployedCapital | null;
}): JSX.Element {
  if (capital === null) {
    return (
      <Field label="Deployed capital">
        <div data-vex-field="deployed-capital">
          <span className="italic text-ink-tertiary">Not declared</span>
        </div>
      </Field>
    );
  }
  const symbol = displayableAssetSymbol(capital.assetSymbol);
  const amount = capital.amountHuman ?? `${capital.amountRaw} raw`;
  const chain = chainDisplay(capital.chainId).name;
  return (
    <Field label="Deployed capital">
      <div data-vex-field="deployed-capital" className="space-y-0.5">
        <p className="text-ink-primary">
          {symbol === null ? `${amount} on ${chain}` : `${amount} ${symbol} on ${chain}`}
        </p>
        <p className="break-all font-mono text-[11px] text-ink-tertiary">
          {capital.amountRaw} raw @ {capital.decimals} decimals ·{" "}
          {capital.assetAddress}
        </p>
      </div>
    </Field>
  );
}

function ChipList({ items }: { readonly items: readonly string[] }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item}
          className="max-w-full break-all rounded-[3px] border border-line-3 px-1.5 py-0.5 font-mono text-[11px] text-ink-primary"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

function BulletList({
  items,
}: {
  readonly items: readonly string[];
}): JSX.Element {
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-ink-primary">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function formatConstraints(draft: MissionDraftDto): string[] {
  const out: string[] = [];
  const c = draft.constraints;
  if (typeof c.maxSpendUsd === "number") out.push(`Max spend: $${c.maxSpendUsd}`);
  if (typeof c.maxLossUsd === "number") out.push(`Max loss: $${c.maxLossUsd}`);
  if (typeof c.maxIterations === "number") {
    out.push(`Max iterations: ${c.maxIterations}`);
  }
  if (typeof c.deadlineAt === "string") out.push(`Deadline: ${c.deadlineAt}`);
  if (typeof c.notes === "string" && c.notes.length > 0) {
    out.push(`Notes: ${c.notes}`);
  }
  if (typeof draft.riskProfile === "string" && draft.riskProfile.length > 0) {
    out.push(`Risk profile: ${draft.riskProfile}`);
  }
  // C6 — shown ONLY when both parts are present. The raw amount is rendered
  // with its decimals rather than converted: a display-side rescale of a money
  // limit is exactly the silent 10^n slip rule 90 forbids.
  if (
    typeof c.maxLaunchValueRaw === "string" &&
    typeof c.maxLaunchValueDecimals === "number"
  ) {
    out.push(
      `Max launch value: ${c.maxLaunchValueRaw} raw @ ${c.maxLaunchValueDecimals} decimals`,
    );
  }
  // C6b — the count cap stands alone: it is authored separately from the value
  // pair, and a mission may legitimately carry one without the other (an
  // autonomous launch then still refuses, which is the point).
  if (typeof c.maxLaunchCount === "number") {
    out.push(`Max launch count: ${c.maxLaunchCount}`);
  }
  return out;
}

function formatRestrictions(draft: MissionDraftDto): string[] {
  return [
    ...draft.allowedChains.map((c) => `chain:${c}`),
    ...draft.allowedProtocols.map((p) => `protocol:${p}`),
    ...draft.allowedWallets.map((w) => `wallet:${w}`),
  ];
}

export interface AutoRetrySectionProps {
  readonly enabled: boolean;
  readonly pending: boolean;
  readonly onToggle: (next: boolean) => void;
}

/**
 * Auto-retry opt-in toggle (phase 4d-5). Rendered by the modal only for
 * autonomous-full sessions. CSP-safe (Tailwind classes only, no inline
 * styles); accessible `role="switch"` + `aria-checked`. The modal owns
 * the mutation; this stays presentational.
 */
export function AutoRetrySection({
  enabled,
  pending,
  onToggle,
}: AutoRetrySectionProps): JSX.Element {
  return (
    <div className="rounded-xl border border-line-1 bg-surface-1 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="vex-micro-label uppercase text-ink-secondary">
            Auto-retry on error
          </div>
          <p className="text-xs text-ink-secondary">
            Re-attempt up to 5× after a provider or runtime error. Turns itself
            off once the run performs a wallet, signing, or other
            state-changing action.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Auto-retry on error"
          disabled={pending}
          onClick={() => onToggle(!enabled)}
          data-vex-action="toggle-auto-retry"
          // THE SWITCH LOOK (owner item 4, ratified 2026-08-21). One treatment
          // for every switch in the app; the Notifications toggle in
          // SettingsPreferences wears the identical strings. ON = the
          // accent-CTA track (deep brand blue on chronos, light accent on
          // celeris) with the matching ink knob; OFF = the solid interactive
          // track with the page's own primary ink, never an opacity wash. The
          // one opacity here is the PENDING control as a whole (a mutation is
          // in flight), not a stacked text tier.
          className={cn(
            "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:cursor-not-allowed disabled:opacity-50",
            enabled
              ? "border-button-accent bg-button-accent"
              : "border-line-4 bg-interactive-solid",
          )}
        >
          <span
            className={cn(
              "inline-block h-3.5 w-3.5 rounded-full transition-transform",
              enabled
                ? "translate-x-[18px] bg-ink-on-button-accent"
                : "translate-x-[3px] bg-ink-primary",
            )}
          />
        </button>
      </div>
    </div>
  );
}
