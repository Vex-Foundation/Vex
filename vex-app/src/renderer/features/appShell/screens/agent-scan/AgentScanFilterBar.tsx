/**
 * Agent Scan filter bar — the controls that narrow the feed, plus the state
 * shape they drive.
 *
 * ONE grammar for every control: a hairline small-caps chip (the sans support
 * face — see CHIP_BASE) that lights cobalt when
 * active (`aria-pressed` carries the same state to assistive tech). Kinds and
 * protocols are MULTI-select, status and chain family are single-select
 * toggles — that mirrors what the query contract can express
 * (`agentScanFiltersSchema`: `kinds`/`protocols` are bounded arrays,
 * `chainFamily` is one value) rather than offering the user a control the read
 * cannot honour.
 *
 * ACTIVE FILTERS ARE VISIBLY PINNED: an active chip is cobalt, and the bar
 * shows a live count with a Clear key, so a feed narrowed to three rows can
 * never be mistaken for a feed that only HAS three rows — the exact misread a
 * silent filter causes on an audit surface.
 *
 * OPTIONS COME FROM WHAT WRITES THE FEED, never from what we can draw. Kinds
 * come from the shared engine vocabulary; protocols from
 * `agent-scan-protocols.ts` (the executors that write `agent_activity`) —
 * emphatically NOT from the protocol-mark map, which knows read-only tools and
 * retired products and once put two always-empty options in this bar.
 */

import type { JSX } from "react";
import {
  AGENT_ACTIVITY_KINDS,
  AGENT_ACTIVITY_STATUSES,
  type AgentActivityStatus,
} from "@shared/agent-activity-vocabulary.js";
import type {
  AgentScanChainFamilyFilter,
  AgentScanFilters,
  AgentScanStatusFilter,
} from "@shared/schemas/agent-scan-feed.js";
import { cn } from "../../../../lib/utils.js";
import { FEED_PROTOCOL_OPTIONS } from "./agent-scan-protocols.js";

/** The renderer-side filter selection. `null` means "no constraint". */
export interface AgentScanFilterState {
  readonly kinds: readonly string[];
  readonly status: AgentScanStatusFilter | null;
  readonly protocols: readonly string[];
  readonly chainFamily: AgentScanChainFamilyFilter | null;
  /**
   * SESSION PRESET — set by the caller (the session rail's Activity card
   * "View all"), never by a control in this bar. It is a NON-CLEARABLE scope,
   * not a user-toggled filter: Clear resets everything else and leaves it in
   * place, and it renders as its own visible chip so a session-narrowed feed
   * can never be mistaken for the whole history. `null` = the global feed.
   */
  readonly sessionId: string | null;
}

export const EMPTY_FILTER_STATE: AgentScanFilterState = {
  kinds: [],
  status: null,
  protocols: [],
  chainFamily: null,
  sessionId: null,
};

/**
 * How many USER-CLEARABLE constraints are active — drives the pinned count
 * and the Clear key. The session preset is deliberately excluded: it is a
 * scope the user cannot clear from here, and counting it would promise a
 * Clear that does nothing to it. Its own chip carries that narrowing
 * visibly instead.
 */
export function activeFilterCount(state: AgentScanFilterState): number {
  return (
    state.kinds.length +
    state.protocols.length +
    (state.status !== null ? 1 : 0) +
    (state.chainFamily !== null ? 1 : 0)
  );
}

/** True when the feed is narrowed at all — by a filter OR by the session preset. */
export function isFeedNarrowed(state: AgentScanFilterState): boolean {
  return activeFilterCount(state) > 0 || state.sessionId !== null;
}

/**
 * Project the selection onto the IPC filter contract, omitting empty keys
 * entirely (the schema is `.strict()` with optional fields — an empty array
 * would be a real, and wrong, "match nothing" constraint to send).
 */
export function toAgentScanFilters(state: AgentScanFilterState): AgentScanFilters {
  const filters: {
    kinds?: string[];
    statuses?: AgentScanStatusFilter[];
    protocols?: string[];
    chainFamily?: AgentScanChainFamilyFilter;
    sessionId?: string;
  } = {};
  if (state.kinds.length > 0) filters.kinds = [...state.kinds];
  if (state.status !== null) filters.statuses = [state.status];
  if (state.protocols.length > 0) filters.protocols = [...state.protocols];
  if (state.chainFamily !== null) filters.chainFamily = state.chainFamily;
  // The session scope NARROWS the read server-side (`agentScanFiltersSchema`
  // already carries it) — it was silently dropped here before, so a
  // "session" feed rendered the global history.
  if (state.sessionId !== null) filters.sessionId = state.sessionId;
  return filters;
}

/** Add/remove one value from a multi-select list. */
export function toggleValue(
  list: readonly string[],
  value: string,
): readonly string[] {
  return list.includes(value)
    ? list.filter((item) => item !== value)
    : [...list, value];
}

/**
 * REGISTER (C2): the chip stamp is Instrument Sans small caps, NOT mono —
 * mono is reserved for technical artifacts (code, raw JSON, addresses, tx
 * hashes), and no new mono uppercase label may be added anywhere. `.vex-micro`
 * is the class for this stamp, but it is UNLAYERED and therefore beats a
 * Tailwind `text-[…]` utility, so a call site that needs a size other than its
 * 10px default (these chips are 9px) spells the register out instead — the
 * `font-sans text-[9px] uppercase` pattern the composer pins use.
 */
const CHIP_BASE =
  "inline-flex h-6 shrink-0 items-center rounded-full border px-2.5 font-sans text-[9px] uppercase tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]";

const CHIP_IDLE =
  "border-[var(--vex-line)] text-[var(--vex-text-3)] hover:border-[var(--vex-line-strong)] hover:text-[var(--vex-text-2)]";

const CHIP_ACTIVE =
  "border-[var(--vex-accent-border-strong)] bg-[var(--vex-accent-fill-12)] text-[var(--vex-accent-text)]";

function FilterChip({
  label,
  active,
  onToggle,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      className={cn(CHIP_BASE, active ? CHIP_ACTIVE : CHIP_IDLE)}
    >
      {label}
    </button>
  );
}

/** One labelled row of chips. */
function FilterGroup({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-[58px] shrink-0 font-sans text-[9px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
        {label}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

const CHAIN_FAMILIES: readonly {
  readonly value: AgentScanChainFamilyFilter;
  readonly label: string;
}[] = [
  { value: "eip155", label: "EVM" },
  { value: "solana", label: "Solana" },
];

export function AgentScanFilterBar({
  state,
  onChange,
}: {
  readonly state: AgentScanFilterState;
  readonly onChange: (next: AgentScanFilterState) => void;
}): JSX.Element {
  const active = activeFilterCount(state);

  return (
    <section
      aria-label="Filters"
      className="flex flex-col gap-2 border-b border-[var(--vex-line)] pb-3"
    >
      <FilterGroup label="Kind">
        {AGENT_ACTIVITY_KINDS.map((kind) => (
          <FilterChip
            key={kind}
            label={kind}
            active={state.kinds.includes(kind)}
            onToggle={() =>
              onChange({ ...state, kinds: toggleValue(state.kinds, kind) })
            }
          />
        ))}
      </FilterGroup>

      <FilterGroup label="Status">
        {AGENT_ACTIVITY_STATUSES.map((status: AgentActivityStatus) => (
          <FilterChip
            key={status}
            label={status}
            active={state.status === status}
            onToggle={() =>
              onChange({
                ...state,
                status: state.status === status ? null : status,
              })
            }
          />
        ))}
      </FilterGroup>

      <FilterGroup label="Protocol">
        {FEED_PROTOCOL_OPTIONS.map((protocol) => (
          <FilterChip
            key={protocol.value}
            label={protocol.label}
            active={state.protocols.includes(protocol.value)}
            onToggle={() =>
              onChange({
                ...state,
                protocols: toggleValue(state.protocols, protocol.value),
              })
            }
          />
        ))}
      </FilterGroup>

      <FilterGroup label="Chain">
        {CHAIN_FAMILIES.map((family) => (
          <FilterChip
            key={family.value}
            label={family.label}
            active={state.chainFamily === family.value}
            onToggle={() =>
              onChange({
                ...state,
                chainFamily:
                  state.chainFamily === family.value ? null : family.value,
              })
            }
          />
        ))}
      </FilterGroup>

      {state.sessionId !== null || active > 0 ? (
        // The narrowing must never be invisible on an audit surface.
        <div className="flex flex-wrap items-center gap-2 pl-[66px]">
          {state.sessionId !== null ? (
            // NOT a FilterChip: it carries no `aria-pressed` and no toggle,
            // because it is a scope the user cannot clear from this bar.
            <span
              data-vex-area="agent-scan-session-scope"
              className={cn(CHIP_BASE, CHIP_ACTIVE, "cursor-default")}
              title="This feed is narrowed to one session"
            >
              this session
            </span>
          ) : null}
          {active > 0 ? (
            <span className="font-sans text-[9px] uppercase tracking-[0.14em] text-[var(--vex-accent-text)]">
              {active} filter{active === 1 ? "" : "s"} active
            </span>
          ) : null}
          {active > 0 ? (
          <button
            type="button"
            // Clear resets the user-chosen filters and PRESERVES the session
            // scope — clearing must not silently widen an audit feed.
            onClick={() => onChange({ ...EMPTY_FILTER_STATE, sessionId: state.sessionId })}
            className="font-sans text-[9px] uppercase tracking-[0.14em] text-[var(--vex-text-3)] underline-offset-2 transition-colors hover:text-[var(--vex-text)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
          >
            Clear
          </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
