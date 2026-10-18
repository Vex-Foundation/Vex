/**
 * Agent Scan filter bar - the controls that narrow the feed, plus the state
 * shape they drive (`docs/design/R3-MINIMAL.md` section 9.2).
 *
 * FOUR NAMED MENUS, one per dimension: Kind, Status, Protocol, Chain. Each is
 * a select-like key ("Kind  All  v") that opens a flat menu card of options;
 * the key shows "All" while the dimension is empty, the option's name for one
 * choice, and "Swap +1" for several. Kinds and protocols are MULTI-select
 * (checkbox rows, the menu stays open on a press); status and chain family are
 * single-select toggles (radio rows, the menu closes on a press, pressing the
 * checked row again clears it). That mirrors what the query contract can
 * express (`agentScanFiltersSchema`: `kinds`/`protocols` are bounded arrays,
 * `chainFamily` is one value) rather than offering the user a control the read
 * cannot honour. The first row of every menu is "All": it clears that one
 * dimension and nothing else.
 *
 * ACTIVE FILTERS ARE VISIBLY PINNED: a menu key that narrows the feed turns
 * blue (`data-active`), and the bar shows a live count with a Clear link, so a
 * feed narrowed to three rows can never be mistaken for a feed that only HAS
 * three rows - the exact misread a silent filter causes on an audit surface.
 * The scope the page was opened with is its own non-clearable chip.
 *
 * KEYBOARD: Escape on an open menu closes it, returns focus to its key and
 * takes the keystroke (the page sheet closes on a window Escape listener that
 * ignores handled events, so the menu must claim the key first); the arrows
 * move between rows (wrapping), Home and End jump, a press outside closes.
 *
 * OPTIONS COME FROM WHAT WRITES THE FEED, never from what we can draw. Kinds
 * come from the shared engine vocabulary; protocols from
 * `agent-scan-protocols.ts` (the executors that write `agent_activity`) -
 * emphatically NOT from the protocol-mark map, which knows read-only tools and
 * retired products and once put two always-empty options in this bar.
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
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
import {
  LineCheck,
  LineChevronDown,
} from "../../../../components/icons/line/index.js";
import {
  GLOBAL_AGENT_SCAN_SCOPE,
  type AgentScanRouteScope,
} from "../../../../stores/uiStore/shell-route.js";
import { FEED_PROTOCOL_OPTIONS } from "./agent-scan-protocols.js";

/**
 * The FEED kind that selects the Lighter fill ledger, exactly as
 * `agentScanFiltersSchema` documents it: a member of the `kinds` list that is
 * NOT an `agent_activity.kind`, so the engine's kind lockstep gate is
 * untouched and main routes the second arm on it.
 */
const LIGHTER_FILL_KIND = "lighter_fill";
const LIGHTER_FILL_KIND_LABEL = "Lighter fills";

/** The renderer-side filter selection. `null` means "no constraint". */
export interface AgentScanFilterState {
  readonly kinds: readonly string[];
  readonly status: AgentScanStatusFilter | null;
  readonly protocols: readonly string[];
  readonly chainFamily: AgentScanChainFamilyFilter | null;
  /**
   * SCOPE PRESET - set by the caller (a scoped link such as the Vex sidebar's "Agent Scan"),
   * never by a control in this bar. It is a NON-CLEARABLE scope, not a
   * user-toggled filter: Clear resets everything else and leaves it in place,
   * and it renders as its own visible chip so a narrowed feed can never be
   * mistaken for the whole history. `{ kind: "global" }` = the full feed.
   *
   * It is the ROUTE's closed union rather than two nullable ids, so "narrowed
   * to a session" and "narrowed to a project" cannot both be true and a new
   * member fails to compile in `toAgentScanFilters` instead of silently
   * widening the read.
   */
  readonly scope: AgentScanRouteScope;
}

export const EMPTY_FILTER_STATE: AgentScanFilterState = {
  kinds: [],
  status: null,
  protocols: [],
  chainFamily: null,
  scope: GLOBAL_AGENT_SCAN_SCOPE,
};

/**
 * How many USER-CLEARABLE constraints are active - drives the pinned count
 * and the Clear key. The scope preset is deliberately excluded: it is a
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

/** True when the feed is narrowed at all - by a filter OR by the scope preset. */
export function isFeedNarrowed(state: AgentScanFilterState): boolean {
  return activeFilterCount(state) > 0 || state.scope.kind !== "global";
}

/**
 * Project the selection onto the IPC filter contract, omitting empty keys
 * entirely (the schema is `.strict()` with optional fields - an empty array
 * would be a real, and wrong, "match nothing" constraint to send).
 */
export function toAgentScanFilters(state: AgentScanFilterState): AgentScanFilters {
  const filters: {
    kinds?: string[];
    statuses?: AgentScanStatusFilter[];
    protocols?: string[];
    chainFamily?: AgentScanChainFamilyFilter;
    sessionId?: string;
    projectId?: string;
  } = {};
  if (state.kinds.length > 0) filters.kinds = [...state.kinds];
  if (state.status !== null) filters.statuses = [state.status];
  if (state.protocols.length > 0) filters.protocols = [...state.protocols];
  if (state.chainFamily !== null) filters.chainFamily = state.chainFamily;
  // The scope NARROWS the read server-side (`agentScanFiltersSchema` carries
  // both ids and refuses the pair by name) - it was silently dropped here
  // once, and a "session" feed then rendered the global history. Exhaustive
  // switch, no default: a new scope member is a compile error rather than a
  // request that quietly asks for everything.
  switch (state.scope.kind) {
    case "global":
      break;
    case "session":
      filters.sessionId = state.scope.sessionId;
      break;
    case "project":
      filters.projectId = state.scope.projectId;
      break;
  }
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

/** One row of a filter menu: the wire value and the sentence-case label. */
interface FilterOption<V extends string> {
  readonly value: V;
  readonly label: string;
}

/** "swap" -> "Swap": the vocabulary values are lower-case wire words. */
function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const KIND_OPTIONS: readonly FilterOption<string>[] = [
  ...AGENT_ACTIVITY_KINDS.map((kind) => ({
    value: kind,
    label: sentenceCase(kind),
  })),
  // The FEED kind that selects the second ledger. It sits beside the
  // vocabulary-derived rows and routes identically (`kinds` is an OPEN bounded
  // list on the contract), but it is deliberately NOT in
  // `AGENT_ACTIVITY_KINDS`: a venue fill is not an `agent_activity` kind and
  // adding it there would put a value in the database vocabulary that no row
  // can ever carry.
  { value: LIGHTER_FILL_KIND, label: LIGHTER_FILL_KIND_LABEL },
];

/**
 * Display names for the lifecycle statuses. A lookup, not an exhaustive
 * switch: a member this table predates shows its raw value rather than
 * blanking the option.
 */
const STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: "Pending",
  confirmed: "Confirmed",
  failed: "Failed",
  superseded_unproven: "Superseded",
};

const STATUS_OPTIONS: readonly FilterOption<AgentScanStatusFilter>[] =
  AGENT_ACTIVITY_STATUSES.map((status: AgentActivityStatus) => ({
    value: status,
    label: STATUS_LABELS[status] ?? status,
  }));

const PROTOCOL_OPTIONS: readonly FilterOption<string>[] = FEED_PROTOCOL_OPTIONS;

const CHAIN_OPTIONS: readonly FilterOption<AgentScanChainFamilyFilter>[] = [
  { value: "eip155", label: "EVM" },
  { value: "solana", label: "Solana" },
];

/** What the key says: "All", the one chosen label, or "Swap +1". */
function valueLabel<V extends string>(
  options: readonly FilterOption<V>[],
  selected: readonly V[],
): string {
  const [first] = selected;
  if (first === undefined) return "All";
  const firstLabel =
    options.find((option) => option.value === first)?.label ?? first;
  return selected.length === 1
    ? firstLabel
    : `${firstLabel} +${selected.length - 1}`;
}

/** The focusable rows of an open menu card, in document order. */
function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (menu === null) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
}

/**
 * One named filter menu: a select-like key and, while open, the kit's menu
 * card. The kit `Menu` cannot be used here: it has no checkbox or radio rows,
 * and a filter's rows must say "checked" to assistive tech, not only to the
 * eye.
 *
 * `multi` rows are `menuitemcheckbox` and stay open on a press (the user is
 * building a set); `single` rows are `menuitemradio` and close on a press, and
 * pressing the checked one again clears it - the toggle the bar always had.
 */
function FilterMenu<V extends string>({
  name,
  selection,
  options,
  selected,
  onToggle,
  onClear,
}: {
  readonly name: string;
  readonly selection: "multi" | "single";
  readonly options: readonly FilterOption<V>[];
  readonly selected: readonly V[];
  readonly onToggle: (value: V) => void;
  readonly onClear: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const multi = selection === "multi";
  const itemRole = multi ? "menuitemcheckbox" : "menuitemradio";

  // Opening lands focus on the first checked row, else the first row, so the
  // arrows work from the first key press.
  useEffect(() => {
    if (!open) return;
    const items = menuItems(menuRef.current);
    const target =
      items.find((item) => item.getAttribute("aria-checked") === "true") ??
      items[0];
    target?.focus();
  }, [open]);

  // A press outside the key and its card closes the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (wrapRef.current?.contains(event.target) === true) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const closeToTrigger = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const moveFocus = (to: "first" | "last" | "next" | "previous"): void => {
    const items = menuItems(menuRef.current);
    const count = items.length;
    if (count === 0) return;
    const current = items.findIndex((item) => item === document.activeElement);
    let index: number;
    switch (to) {
      case "first":
        index = 0;
        break;
      case "last":
        index = count - 1;
        break;
      case "next":
        index = current < 0 ? 0 : (current + 1) % count;
        break;
      case "previous":
        index = current < 0 ? count - 1 : (current - 1 + count) % count;
        break;
    }
    items[index]?.focus();
  };

  // On the wrapper (React's synthetic handler runs before the window listener
  // the page sheet closes on): Escape here is the menu's, not the page's.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open) {
      if (event.key === "ArrowDown" && event.target === triggerRef.current) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeToTrigger();
        break;
      case "ArrowDown":
        event.preventDefault();
        moveFocus("next");
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus("previous");
        break;
      case "Home":
        event.preventDefault();
        moveFocus("first");
        break;
      case "End":
        event.preventDefault();
        moveFocus("last");
        break;
      case "Tab":
        // Park focus on the key first so the browser's own Tab step leaves
        // from a node that is still mounted once the card is gone.
        setOpen(false);
        triggerRef.current?.focus();
        break;
      default:
        break;
    }
  };

  const press = (action: () => void): void => {
    action();
    if (!multi) closeToTrigger();
  };

  const renderItem = (
    key: string,
    label: string,
    checked: boolean,
    action: () => void,
  ): JSX.Element => (
    <button
      key={key}
      type="button"
      role={itemRole}
      aria-checked={checked}
      tabIndex={-1}
      data-selected={checked ? "" : undefined}
      className="vex-menu-item"
      onClick={() => press(action)}
    >
      <span className="vex-menu-item-label">{label}</span>
      {checked ? <LineCheck size={16} className="vex-menu-check" /> : null}
    </button>
  );

  return (
    <div ref={wrapRef} className="vex-scan-filter" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="vex-scan-filter__key"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        data-active={selected.length > 0 ? "" : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="vex-scan-filter__name">{name}</span>{" "}
        <span className="vex-scan-filter__value">
          {valueLabel(options, selected)}
        </span>{" "}
        <LineChevronDown size={14} className="vex-scan-filter__chev" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={name}
          className="vex-menu vex-scan-filter__menu"
        >
          <div className="vex-menu-viewport" role="presentation">
            {renderItem("all", "All", selected.length === 0, onClear)}
            {options.map((option) =>
              renderItem(
                option.value,
                option.label,
                selected.includes(option.value),
                () => onToggle(option.value),
              ),
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the non-clearable scope chip SAYS, and what it says while the project's
 * name is still being read.
 *
 * A project scope falls back to "this project" rather than to a placeholder
 * name or to nothing at all: the narrowing must be visible from the first
 * frame, and naming a project Vex has not confirmed would be a claim about
 * whose money is on screen. `null` = no chip (the global feed).
 */
export function scopeChipLabel(
  scope: AgentScanRouteScope,
  projectName: string | null,
): string | null {
  switch (scope.kind) {
    case "global":
      return null;
    case "session":
      return "this session";
    case "project":
      return projectName ?? "this project";
  }
}

export function AgentScanFilterBar({
  state,
  onChange,
  projectName = null,
}: {
  readonly state: AgentScanFilterState;
  readonly onChange: (next: AgentScanFilterState) => void;
  /**
   * The open project's name, when the scope is a project and the projects read
   * has resolved. A LABEL only - it grants nothing and is never a query input.
   */
  readonly projectName?: string | null;
}): JSX.Element {
  const active = activeFilterCount(state);
  const scopeLabel = scopeChipLabel(state.scope, projectName);

  return (
    <section aria-label="Filters" className="vex-scan-filters">
      <FilterMenu
        name="Kind"
        selection="multi"
        options={KIND_OPTIONS}
        selected={state.kinds}
        onToggle={(kind) =>
          onChange({ ...state, kinds: toggleValue(state.kinds, kind) })
        }
        onClear={() => onChange({ ...state, kinds: [] })}
      />
      <FilterMenu
        name="Status"
        selection="single"
        options={STATUS_OPTIONS}
        selected={state.status === null ? [] : [state.status]}
        onToggle={(status) =>
          onChange({
            ...state,
            status: state.status === status ? null : status,
          })
        }
        onClear={() => onChange({ ...state, status: null })}
      />
      <FilterMenu
        name="Protocol"
        selection="multi"
        options={PROTOCOL_OPTIONS}
        selected={state.protocols}
        onToggle={(protocol) =>
          onChange({
            ...state,
            protocols: toggleValue(state.protocols, protocol),
          })
        }
        onClear={() => onChange({ ...state, protocols: [] })}
      />
      <FilterMenu
        name="Chain"
        selection="single"
        options={CHAIN_OPTIONS}
        selected={state.chainFamily === null ? [] : [state.chainFamily]}
        onToggle={(family) =>
          onChange({
            ...state,
            chainFamily: state.chainFamily === family ? null : family,
          })
        }
        onClear={() => onChange({ ...state, chainFamily: null })}
      />
      {scopeLabel !== null ? (
        // NOT a menu and NOT a toggle: it carries no `aria-pressed` or
        // `aria-checked`, because it is a scope the user cannot clear from
        // this bar. The narrowing must never be invisible on an audit surface.
        <span
          data-vex-area="agent-scan-scope-chip"
          data-vex-scope={state.scope.kind}
          className="vex-scan-scope"
          title={
            state.scope.kind === "project"
              ? "This feed is narrowed to one project's wallets"
              : "This feed is narrowed to one session"
          }
        >
          {scopeLabel}
        </span>
      ) : null}
      {active > 0 ? (
        <span className="vex-scan-active">
          {active} filter{active === 1 ? "" : "s"} active
          <button
            type="button"
            // Clear resets the user-chosen filters and PRESERVES the session
            // scope - clearing must not silently widen an audit feed.
            onClick={() =>
              onChange({ ...EMPTY_FILTER_STATE, scope: state.scope })
            }
            className="vex-scan-link"
          >
            Clear
          </button>
        </span>
      ) : null}
    </section>
  );
}
