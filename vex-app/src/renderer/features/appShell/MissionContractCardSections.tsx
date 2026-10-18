/**
 * Presentational pieces + pure formatters for the mission contract surface.
 *
 * Originally extracted from the inline `MissionContractCard`; that card was
 * retired when the contract moved into `MissionContractModal` (the MISSION RAIL
 * redesign), and the contract now sits in a sheet over the centre column. What
 * survives here is exactly what the sheet still reuses - the read-only
 * `CardBody` (goal / constraints / restrictions / criteria, drawn as a
 * definition grid) and the presentational `AutoRetrySection` toggle. The card's
 * `CardHeader` / `CardFooter` went with the card: the sheet renders the title +
 * status badge in its own head and reproduces the Accept action in its pinned
 * foot. The sheet supplies the centred column; nothing here is a framed card.
 *
 * Every component here stays purely presentational - no hooks, no fetches, no
 * event handlers other than the typed `onToggle` the modal threads through.
 */

import type { JSX, ReactNode } from "react";
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
  const goal = draft.goal?.trim();
  return (
    <div>
      <div className="grid grid-cols-[190px_minmax(0,1fr)] border-t border-rule-quiet text-[14px] leading-[1.45]">
        <KvRow label="Goal">
          <p>
            {goal || (
              <span className="text-ink-tertiary">
                (no goal yet - talk to Vex to outline one)
              </span>
            )}
          </p>
        </KvRow>
        {constraints.length > 0 ? (
          <KvRow label="Constraints">
            <ul className="space-y-0.5">
              {constraints.map((line) => (
                <li key={line.label}>
                  {line.label}:{" "}
                  {line.figure ? (
                    <span className="font-mono vex-num">{line.value}</span>
                  ) : (
                    line.value
                  )}
                </li>
              ))}
            </ul>
          </KvRow>
        ) : null}
        <DeployedCapitalRow capital={draft.deployedCapital} />
        {restrictions.length > 0 ? (
          <KvRow label="Restrictions">
            <ChipList items={restrictions} />
          </KvRow>
        ) : null}
        {draft.successCriteria.length > 0 ? (
          <KvRow label="Success criteria">
            <LineList items={draft.successCriteria} />
          </KvRow>
        ) : null}
        {draft.stopConditions.length > 0 ? (
          <KvRow label="Stop conditions">
            <LineList
              items={draft.stopConditions}
              lastHint="Host-only - Vex cannot change these"
            />
          </KvRow>
        ) : null}
      </div>
      {draft.renewedFromMissionId !== null ? (
        <p className="mt-2 text-[12.5px] text-ink-tertiary">
          Renewed from mission{" "}
          <span className="font-mono vex-num">{draft.renewedFromMissionId}</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * One row of the definition grid: a muted key cell and an ink value cell. Both
 * cells carry the 1px quiet rule under them, so the rows read as a ruled list.
 * Renders as two grid children, so it must sit directly inside the grid.
 */
function KvRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <>
      <div className="border-b border-rule-quiet py-[9px] text-ink-tertiary">
        {label}
      </div>
      <div className="min-w-0 border-b border-rule-quiet py-[9px] text-ink-primary">
        {children}
      </div>
    </>
  );
}

/**
 * C3 - the deployed-capital declaration, ALWAYS rendered.
 *
 * This field is bound into the acceptance hash (contract v7), so the host must
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
function DeployedCapitalRow({
  capital,
}: {
  readonly capital: MissionDeployedCapital | null;
}): JSX.Element {
  if (capital === null) {
    return (
      <KvRow label="Deployed capital">
        <div data-vex-field="deployed-capital">
          <span className="text-ink-tertiary">Not declared</span>
        </div>
      </KvRow>
    );
  }
  const symbol = displayableAssetSymbol(capital.assetSymbol);
  const amount = capital.amountHuman ?? `${capital.amountRaw} raw`;
  const chain = chainDisplay(capital.chainId).name;
  const assetKind = capital.assetKind === "native"
    ? "native account coin"
    : capital.assetKind === "token"
      ? "token / mint"
      : "legacy identity: native or token unknown";
  return (
    <KvRow label="Deployed capital">
      <div data-vex-field="deployed-capital" className="space-y-0.5">
        <p className="text-ink-primary">
          {symbol === null ? `${amount} on ${chain}` : `${amount} ${symbol} on ${chain}`}
        </p>
        <p className="break-all font-mono vex-num text-[12px] text-ink-tertiary">
          {capital.amountRaw} raw @ {capital.decimals} decimals · {assetKind} ·{" "}
          {capital.assetAddress}
        </p>
      </div>
    </KvRow>
  );
}

function ChipList({ items }: { readonly items: readonly string[] }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item}
          className="inline-flex max-w-full items-center break-all border border-rule-quiet bg-surface-field px-1.5 py-0.5 font-mono vex-num text-[12px] text-ink-primary"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

/**
 * Plain lines, one per item (no bullets). `lastHint` is a muted aside set
 * inline after the LAST item, so it reads as a note on the whole list.
 */
function LineList({
  items,
  lastHint,
}: {
  readonly items: readonly string[];
  readonly lastHint?: string;
}): JSX.Element {
  return (
    <ul className="space-y-0.5">
      {items.map((item, index) => (
        <li key={item}>
          {item}
          {lastHint !== undefined && index === items.length - 1 ? (
            <span className="text-[12.5px] text-ink-tertiary">
              {` · ${lastHint}`}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * One constraint line. `figure` marks a value that is a number, an amount or a
 * time, which renders in mono; words (notes, risk profile) stay in the sans.
 * The visible text of a line is always `{label}: {value}`.
 */
interface ConstraintLine {
  readonly label: string;
  readonly value: string;
  readonly figure: boolean;
}

function formatConstraints(draft: MissionDraftDto): ConstraintLine[] {
  const out: ConstraintLine[] = [];
  const c = draft.constraints;
  if (typeof c.maxSpendUsd === "number") {
    out.push({ label: "Max spend", value: `$${c.maxSpendUsd}`, figure: true });
  }
  if (typeof c.maxLossUsd === "number") {
    out.push({ label: "Max loss", value: `$${c.maxLossUsd}`, figure: true });
  }
  if (typeof c.maxIterations === "number") {
    out.push({ label: "Max iterations", value: `${c.maxIterations}`, figure: true });
  }
  if (typeof c.deadlineAt === "string") {
    out.push({ label: "Deadline", value: c.deadlineAt, figure: true });
  }
  if (typeof c.notes === "string" && c.notes.length > 0) {
    out.push({ label: "Notes", value: c.notes, figure: false });
  }
  if (typeof draft.riskProfile === "string" && draft.riskProfile.length > 0) {
    out.push({ label: "Risk profile", value: draft.riskProfile, figure: false });
  }
  // C6 - shown ONLY when both parts are present. The raw amount is rendered
  // with its decimals rather than converted: a display-side rescale of a money
  // limit is exactly the silent 10^n slip rule 90 forbids.
  if (
    typeof c.maxLaunchValueRaw === "string" &&
    typeof c.maxLaunchValueDecimals === "number"
  ) {
    out.push({
      label: "Max launch value",
      value: `${c.maxLaunchValueRaw} raw @ ${c.maxLaunchValueDecimals} decimals`,
      figure: true,
    });
  }
  // C6b - the count cap stands alone: it is authored separately from the value
  // pair, and a mission may legitimately carry one without the other (an
  // autonomous launch then still refuses, which is the point).
  if (typeof c.maxLaunchCount === "number") {
    out.push({
      label: "Max launch count",
      value: `${c.maxLaunchCount}`,
      figure: true,
    });
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
    <div className="mt-[22px]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <b className="text-[14px] font-semibold text-ink-primary">
            Auto-retry on error
          </b>
          <p className="mt-1 text-[14px] leading-[1.5] text-ink-secondary">
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
          // The switch: 32 x 18 key, 10 x 10 thumb at a 3px inset (see
          // docs/design/R3-MINIMAL.md section 1.5). Off = field fill, ink
          // rule, muted thumb; on = the accent fill with its edge and the
          // on-fill thumb slid 14px. A pending mutation keeps the native
          // `disabled` and the not-allowed cursor, never an opacity fade.
          className={cn(
            "relative mt-px inline-flex h-[18px] w-8 shrink-0 border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed",
            enabled
              ? "border-button-accent-edge bg-button-accent"
              : "border-rule-ink bg-surface-field",
          )}
        >
          <span
            className={cn(
              "absolute left-[3px] top-[3px] h-2.5 w-2.5 transition-transform duration-150 motion-reduce:transition-none",
              enabled
                ? "translate-x-[14px] bg-ink-on-button-accent"
                : "bg-ink-tertiary",
            )}
          />
        </button>
      </div>
    </div>
  );
}
