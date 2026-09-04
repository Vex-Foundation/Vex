/**
 * AGENT RAIL HEADER - the crown of the sessions sidebar, and the one place in
 * agent mode that always carries the way into Studio.
 *
 * WHY IT IS ITS OWN COMPONENT. The after-audit measured the defect this file
 * answers: inside an agent SESSION there was no mode control anywhere on
 * screen, because the `Agent | Studio` capsule rendered only on the agent
 * welcome hero and in the Studio rail header. A door that exists on one screen
 * of a mode is not a door out of that mode. The header is the surface whose
 * contract is "these controls are constant across every agent state", so it
 * owns that invariant and can be tested for it without mounting the whole
 * sessions rail, its queries and its dialogs.
 *
 * The references say the same thing twice. VS Code keeps its activity switches
 * in the activity bar, a Part of its own with its own tests
 * (`browser/parts/activitybar/activitybarPart.ts`), never inside a view that
 * some states unmount. deepseek-harness's `SidebarRoot` renders its four upper
 * controls itself, in the same top-down order, in both column widths, and
 * hands only the BROWSING region to a slot.
 *
 * THE CAPSULE IS WIDE-ONLY, the same as the Studio rail's: it is words, not an
 * icon, and the 56px spine has no room for them. From a collapsed rail the way
 * into Studio is to expand the rail (or the keyboard chord). That is exactly
 * the Studio rail's contract in the other direction, so neither mode is a
 * one-way door and neither rail lies about what fits.
 *
 * The capsule keeps ONE home per page: this header in agent mode, the Studio
 * rail header in Studio mode. The `Runtime mode` radiogroup is therefore
 * unique on the page in both modes - the agent welcome hero and the Studio
 * welcome screen both gave up their copy of it (e2e/studio.spec.ts pins the
 * count).
 */

import type { JSX } from "react";
import { IconPanelLeft, IconSearch } from "../../components/icons/index.js";
import { cn } from "../../lib/utils.js";
import { useUiStore } from "../../stores/uiStore.js";
import { RuntimeModeToggle } from "./RuntimeModeToggle.js";
import { SidebarHomeSigil } from "./SidebarHomeSigil.js";
import { SidebarIconButton } from "./SessionRows.js";

export function AgentSidebarHeader({
  wide,
  collapsed,
  searchOpen,
  onToggleSearch,
  onToggleSidebar,
}: {
  /** The rail is rendering its expanded content (collapse choreography). */
  readonly wide: boolean;
  /** The rail's committed state; drives the expand/collapse control's name. */
  readonly collapsed: boolean;
  readonly searchOpen: boolean;
  readonly onToggleSearch: () => void;
  readonly onToggleSidebar: () => void;
}): JSX.Element {
  // The header holds its own store subscription rather than taking the mode
  // through the rail: the rail is not the owner of where the mode is kept, and
  // `RuntimeModeToggle` deliberately takes the value and the setter as props.
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const setRuntimeMode = useUiStore((s) => s.setRuntimeMode);

  return (
    <header
      className={cn(
        // The mark sits LEFT as the sole brand (doubling as "Back to
        // welcome"), the capsule + magnifier + collapse arrow sit RIGHT.
        // Collapsed, the spine stacks mark -> magnifier -> expand arrow.
        "relative flex shrink-0",
        wide
          ? "h-12 items-center justify-between px-3"
          : "flex-col items-center justify-center gap-0.5 px-2 py-2",
      )}
    >
      <SidebarHomeSigil sidebarOpen={wide} />
      <div
        className={cn("flex items-center", wide ? "gap-1" : "flex-col gap-0.5")}
        data-rail-control
      >
        {wide ? (
          <RuntimeModeToggle runtimeMode={runtimeMode} onChange={setRuntimeMode} />
        ) : null}
        <SidebarIconButton
          label={searchOpen ? "Close session search" : "Search sessions"}
          onClick={onToggleSearch}
        >
          <IconSearch size={16} />
        </SidebarIconButton>
        <SidebarIconButton
          label={
            collapsed ? "Expand sessions sidebar" : "Collapse sessions sidebar"
          }
          onClick={onToggleSidebar}
        >
          <IconPanelLeft size={17} />
        </SidebarIconButton>
      </div>
    </header>
  );
}
