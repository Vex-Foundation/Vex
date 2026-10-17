/**
 * THE ACCOUNT ROW: the identity element at the foot of the left sidebar and
 * of the Studio sidebar (docs/design/R3-MINIMAL.md section 4). One row,
 * padding 12 18 14: the vx in blue in a 30px box on a 1px rule (the local
 * "profile" picture), the user's display name or the personalize ask at
 * 14 / 500, a 12 muted status line, and the up and down chevron at the right.
 * Closed to a rail, the row is the box alone and the status line rides its
 * tooltip.
 *
 * Its portal Menu owns the app's destinations: Personalize, Memory, Sessions,
 * Agent Scan, How Vex works, Settings, Lock Vex, plus a read-only runtime row
 * pinned in the menu footer. Opened upward from a sidebar foot the menu is the
 * flat profile panel (section 12): 316 wide, 10 in from the sidebar's left
 * edge and 66 above its foot, a 1.5px ink frame, never a shadow.
 *
 * The name line is the user's own "Vex setup" `displayName` once set; before
 * that it is a gentle ask ("What should Vex call you?"). The healthy-runtime
 * subtitle speaks the hallmark; any other state speaks its own SENTENCE
 * (`RUNTIME_STATUS_SENTENCES`), never the bare status word. Screen rows route
 * through `setShellRoute` with the trigger row's rect as the expand origin.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import {
  LineBook,
  LineChat,
  LineChevronsUpDown,
  LineLock,
  LineMemory,
  LineNewChat,
  LineScan,
  LineSettings,
  type LineIconComponent,
} from "../../components/icons/line/index.js";
import type { Result } from "@shared/ipc/result.js";
import type { HealthReport } from "@shared/schemas/system.js";
import type { UserProfile } from "@shared/schemas/user-profile.js";
import { cn } from "../../lib/utils.js";
import { VexMark } from "../../components/common/VexMark.js";
import { useReducedMotion } from "../../lib/motion/index.js";
import { Menu, type MenuEntry } from "../../components/ui/menu.js";
import { Swatch, type SwatchState } from "../../components/ui/swatch.js";
import { useSystemHealth } from "../../lib/api/system.js";
import { useMemoryFeatureEnabled } from "../../lib/api/capabilities.js";
import { useUserProfile } from "../../lib/api/user-profile.js";
import { useUiStore } from "../../stores/uiStore.js";
import { LOCK_BUTTON } from "@shared/lock-button.js";
import { studioPlatform } from "./studio/keybindings-labels.js";
import { useLockVexControl } from "./LockVexControl.js";
import { VexSetupDialog } from "./VexSetupDialog.js";

/** The full-app screens the profile menu can open (each a `ShellRoute` kind). */
type ProfileMenuScreen = "memory" | "sessions" | "agentScan" | "howItWorks";

/** Chronos hallmark: the healthy-runtime subtitle. Test-pinned copy. */
export const NIGHT_SHIFT_MESSAGE = "The night shift is active.";

/** The runtime states the foot can be in, derived from the health read. */
export type RuntimeStatusState =
  | "connecting"
  | "unavailable"
  | "connected"
  | "degraded"
  | "not_ready";

/**
 * WHAT IS WRONG, IN A SENTENCE - one per state, the same shape the Studio host
 * status card uses (`studio/studio-copy.ts`, `STUDIO_HOST_CAUSE_SENTENCES`).
 *
 * The foot used to print the bare status word ("DEGRADED" in every walk shot of
 * the UX audit), which answers none of rule 08's questions: not what could not
 * be completed, not why, not whether it is the user's move. Each sentence here
 * says what is not working and the reason, in the terms the derivation actually
 * has (`main/ipc/system.ts`: `degraded` is an unfinished setup, `not_ready` is
 * an offline network), and none of them names a path, a port or a payload.
 *
 * The short word survives where a word is the right size: the menu's runtime
 * provenance row and the trigger's accessible name.
 */
export const RUNTIME_STATUS_SENTENCES: Readonly<
  Record<RuntimeStatusState, string>
> = {
  connecting: "Vex is still checking its local runtime.",
  unavailable: "Vex could not read its local runtime status.",
  connected: NIGHT_SHIFT_MESSAGE,
  degraded: "Vex setup is not finished, so some things will not work yet.",
  not_ready: "Vex is offline, so anything that needs the network will not work.",
};

/** The fill the runtime row draws beside its word (section 1.6). */
const RUNTIME_FILLS: Readonly<Record<RuntimeStatusState, SwatchState>> = {
  connecting: "listening",
  unavailable: "error",
  connected: "done",
  degraded: "concerned",
  not_ready: "concerned",
};

/** Lock Vex's chord as the platform spells it (the Studio label grammar). */
const LOCK_SHORTCUT = studioPlatform === "darwin" ? "\u21e7\u2318L" : "Ctrl+Shift+L";

/** Two-line menu row body: the title at 14 over its 12.5 muted line. */
function entryLabel(label: string, hint: string, attention = false): ReactNode {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="vex-profile-menu__t">{label}</span>
        <span className="vex-profile-menu__s">{hint}</span>
      </span>
      {attention ? (
        <span
          aria-hidden
          data-vex-attention-dot
          className="h-1.5 w-1.5 shrink-0 bg-accent-primary"
        />
      ) : null}
    </span>
  );
}

function entryIcon(Icon: LineIconComponent): ReactNode {
  return <Icon />;
}

/** Profile panel geometry (section 12): 10 in from the sidebar, 66 above its foot. */
const PANEL_INSET_X = 10;
const PANEL_FOOT_GAP = 66;
/** The Menu primitive's own gap between an upward list and its anchor. */
const MENU_GAP = 4;

export function SidebarProfile({
  sidebarOpen,
  menuSide = "top",
}: {
  readonly sidebarOpen: boolean;
  readonly menuSide?: "top" | "bottom";
}): JSX.Element {
  const { pending: locking, requestLock } = useLockVexControl();
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const memoryEnabled = useMemoryFeatureEnabled();
  const healthQuery = useSystemHealth();
  const runtime = getRuntimeStatus({
    loading: healthQuery.isLoading,
    result: healthQuery.data,
  });
  const profileQuery = useUserProfile();
  const nameLine = getNameLine({
    loading: profileQuery.isLoading,
    error: profileQuery.isError,
    result: profileQuery.data,
  });

  // The row's accessible name is the name the row SHOWS (a screen reader
  // user hears the account, not the product), then the runtime word. With no
  // name set the row shows a question ("What should Vex call you?"), which is
  // not a name, so the name falls back to the stable "Vex" the loading and
  // error states already show.
  const accountName =
    nameLine.asksToPersonalize || nameLine.text.trim() === "" ? "Vex" : nameLine.text;

  const reducedMotion = useReducedMotion();
  const [menuPhase, setMenuPhase] = useState<"closed" | "open" | "closing">("closed");
  const open = menuPhase === "open";
  const closeMenu = useCallback((): void => {
    setMenuPhase((phase) => phase === "closed" || reducedMotion ? "closed" : "closing");
  }, [reducedMotion]);
  // A preference change during exit removes the retained node immediately.
  useEffect(() => {
    if (reducedMotion && menuPhase === "closing") setMenuPhase("closed");
  }, [reducedMotion, menuPhase]);
  const [setupOpen, setSetupOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const items: MenuEntry[] = [
    {
      id: "personalize",
      icon: entryIcon(LineNewChat),
      label: entryLabel(
        "Personalize",
        nameLine.asksToPersonalize
          ? "You didn't set up your name"
          : "Name, tone, instructions",
        nameLine.asksToPersonalize,
      ),
    },
    { type: "separator", id: "personalize-separator" },
    ...(memoryEnabled
      ? [
          {
            id: "memory",
            icon: entryIcon(LineMemory),
            label: entryLabel("Memory", "What Vex has learned"),
          },
        ]
      : []),
    {
      id: "sessions",
      icon: entryIcon(LineChat),
      label: entryLabel("Sessions", "Find any conversation"),
    },
    {
      id: "agentScan",
      icon: entryIcon(LineScan),
      label: entryLabel("Agent Scan", "Every move, verified on-chain"),
    },
    {
      id: "howItWorks",
      icon: entryIcon(LineBook),
      label: entryLabel("How Vex works", "Start here - the five-minute tour"),
    },
    {
      id: "settings",
      icon: entryIcon(LineSettings),
      label: entryLabel("Settings", "Wallets, keys, model"),
    },
    ...(LOCK_BUTTON ? [
      { type: "separator" as const, id: "lock-separator" },
      {
        id: "lock-vex",
        icon: entryIcon(LineLock),
        label: entryLabel(locking ? "Locking Vex..." : "Lock Vex", "Require your password to return"),
        shortcut: LOCK_SHORTCUT,
        disabled: locking,
      },
    ] : []),
  ];

  // The runtime row: read-only, pinned behind the footer hairline. The fill
  // and the short word say the state; the sentence lives on the account row.
  const footer: MenuEntry[] = [
    {
      id: "runtime-status",
      disabled: true,
      label: (
        <span className="vex-profile-menu__rt">
          <Swatch state={RUNTIME_FILLS[runtime.state]} size={10} />
          <span className="min-w-0 flex-1 truncate">Runtime</span>
          <span className="shrink-0">{runtime.label}</span>
        </span>
      ),
    },
  ];

  const openScreen = useCallback(
    (screen: ProfileMenuScreen): void => {
      // The trigger row's rect is the screen's expand origin: the menu row is
      // portaled and already dismissed by the time the screen mounts.
      const rect = triggerRef.current?.getBoundingClientRect();
      const origin =
        rect !== undefined
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : { x: 0, y: 0, width: 0, height: 0 };
      // Agent Scan carries a session scope (C4). Opened from the PROFILE menu
      // it is always the FULL global feed.
      setShellRoute(
        screen === "agentScan"
          ? { kind: "agentScan", origin, sessionId: null }
          : { kind: screen, origin },
      );
    },
    [setShellRoute],
  );

  const openSettings = useCallback((): void => {
    const rect = triggerRef.current?.getBoundingClientRect();
    setShellRoute({
      kind: "settings",
      origin:
        rect !== undefined
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : { x: 0, y: 0, width: 0, height: 0 },
      section: null,
    });
  }, [setShellRoute]);

  const onSelect = useCallback(
    (id: string): void => {
      closeMenu();
      if (id === "lock-vex") {
        requestLock();
        return;
      }
      if (id === "personalize") {
        setSetupOpen(true);
        return;
      }
      if (id === "settings") {
        openSettings();
        return;
      }
      if (
        id === "memory" ||
        id === "sessions" ||
        id === "agentScan" ||
        id === "howItWorks"
      ) {
        openScreen(id);
      }
    },
    [closeMenu, openScreen, openSettings, requestLock],
  );

  // Opened upward from a sidebar foot, the list is the profile panel: its
  // left edge 10 in from the trigger row's (the row spans the sidebar), its
  // foot 66 above the sidebar's. The Menu places an upward list MENU_GAP
  // above the rect it is handed, so the rect's top is set to land there.
  const panelAnchorRect = useCallback((): DOMRect | null => {
    const el = triggerRef.current;
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    const left = r.left + PANEL_INSET_X;
    const top = r.bottom - PANEL_FOOT_GAP + MENU_GAP;
    const width = Math.max(0, r.width - PANEL_INSET_X);
    const rect = { x: left, y: top, left, top, width, height: 0, right: left + width, bottom: top };
    return { ...rect, toJSON: () => rect };
  }, []);

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`${accountName}, ${runtime.label}. Open menu`}
      // The collapsed rail renders no subtitle, so the tooltip is the only
      // carrier of the reason there: it speaks the sentence, not the word.
      title={sidebarOpen ? undefined : runtime.sentence}
      onClick={() => open ? closeMenu() : setMenuPhase("open")}
      className="vex-prof"
      data-open={sidebarOpen || undefined}
    >
      {/* The vx in its box; a closed rail shows the box alone. */}
      <span aria-hidden className="vex-prof__av">
        <VexMark size={14} />
      </span>
      {sidebarOpen ? (
        <>
          <span className="vex-prof__name">
            {nameLine.asksToPersonalize ? (
              // The gentle ask: regular weight, so it never reads as the
              // confident name it is standing in for.
              <span className="vex-prof__n vex-prof__n--ask">{nameLine.text}</span>
            ) : (
              <span className="vex-prof__n">{nameLine.text}</span>
            )}
            {/* The hallmark shows ONLY while the runtime is verifiably
              * healthy, on one line. Any other state speaks its sentence and
              * may take two lines: a clipped cause is the defect again. */}
            <span className={cn("vex-prof__s", runtime.live && "vex-prof__s--live")}>
              {runtime.sentence}
            </span>
          </span>
          <LineChevronsUpDown className="vex-profile-chevron vex-prof__chev" />
        </>
      ) : null}
    </button>
  );

  return (
    <div data-vex-area="sidebar-profile" className="vex-prof-root relative">
      <Menu
        open={open}
        anchor={trigger}
        items={items}
        footer={footer}
        onSelect={onSelect}
        onClose={closeMenu}
        listPresentation={{
          state: menuPhase === "closing" && !reducedMotion ? "closing" : "open",
          className: cn("vex-profile-menu", menuSide === "top" && "vex-profile-menu--panel"),
          onAnimationEnd: (event) => {
            if (event.target !== event.currentTarget || event.animationName !== "vex-profile-menu-exit") return;
            // An interrupted exit must not close a menu the user reopened.
            setMenuPhase((phase) => phase === "closing" ? "closed" : phase);
          },
        }}
        portal
        side={menuSide}
        align="start"
        getAnchorRect={menuSide === "top" ? panelAnchorRect : undefined}
        className="block w-full"
      />
      <VexSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
    </div>
  );
}

interface RuntimeStatusInput {
  readonly loading: boolean;
  readonly result: Result<HealthReport> | undefined;
}

/**
 * Status derivation - the short word (test-pinned; casing is CSS-only) plus
 * the sentence that says what it MEANS. Both come from one read so the two
 * surfaces can never disagree about the state they are describing.
 */
export function getRuntimeStatus({ loading, result }: RuntimeStatusInput): {
  readonly state: RuntimeStatusState;
  readonly label: string;
  readonly sentence: string;
  /** True only when the runtime is verifiably connected and healthy. */
  readonly live: boolean;
} {
  const of = (
    state: RuntimeStatusState,
    label: string,
    live: boolean,
  ): {
    readonly state: RuntimeStatusState;
    readonly label: string;
    readonly sentence: string;
    readonly live: boolean;
  } => ({ state, label, sentence: RUNTIME_STATUS_SENTENCES[state], live });

  if (loading || result === undefined) return of("connecting", "Connecting", false);
  if (!result.ok) return of("unavailable", "Unavailable", false);
  if (result.data.overall === "ok") return of("connected", "Connected", true);
  return result.data.overall === "degraded"
    ? of("degraded", "Degraded", false)
    : of("not_ready", "Not ready", false);
}

interface NameLineInput {
  readonly loading: boolean;
  readonly error: boolean;
  readonly result: Result<UserProfile> | undefined;
}

/**
 * Name-line derivation. Deliberately fails closed to the stable "Vex"
 * fallback for every non-success state (loading, IPC error, or a resolved
 * `Result.ok === false`) so the personalize ask never flashes before the
 * profile has actually loaded.
 */
function getNameLine({ loading, error, result }: NameLineInput): {
  readonly asksToPersonalize: boolean;
  readonly text: string;
} {
  if (loading || error || result === undefined || !result.ok) {
    return { asksToPersonalize: false, text: "Vex" };
  }
  if (result.data.displayName === null) {
    // Test-pinned copy: VexSetupDialog's matching field label reuses the
    // same literal for its "What should Vex call you?" input.
    return { asksToPersonalize: true, text: "What should Vex call you?" };
  }
  return { asksToPersonalize: false, text: result.data.displayName };
}
