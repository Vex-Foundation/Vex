/**
 * THE ACCOUNT CELL (docs/design/H3-DESKTOP.md sections 1.4 and 1.8): the
 * bottom row's first cell, under the chats column, 248 x 72 at 1440; also the
 * foot of the Lighter desk's rail and of a standalone Studio sidebar. As H3
 * draws it (`h3-merged__welcome-closed-1440`): the person's avatar disc, 36
 * across, 24 in; the name at 15 in ink ("You" until the person names
 * themselves); "Account and settings" at 13, muted, under it; the up chevron
 * at the right. Closed to the rail, the cell is the disc alone and its line
 * rides the tooltip.
 *
 * The disc is the one the transcript gives the person's own messages
 * (`TranscriptMessage.tsx`, `YouAvatar`): a circle on the chosen rule with
 * the person glyph in ink, drawn as SVG, since every box is square (radius
 * 0). Its measured fill, #151718, has no token; it takes raised 2 (#101214)
 * as the transcript's does.
 *
 * Its portal Menu keeps every destination it had: Personalize, Memory,
 * Sessions, Agent Scan, How Vex works, Settings, Lock Vex, plus a read-only
 * runtime row pinned in the menu footer. Opened upward from the cell, the
 * menu is the profile panel: 316 wide, 12 in from the window's edge (the
 * Menu's margin), its foot on the cell's top rule, raised 2 behind the
 * chosen rule, never a shadow.
 *
 * The name is the person's own "Vex setup" `displayName` once set, and "You"
 * before that (and while the profile loads or cannot be read): H3's word,
 * which is true of whoever sits at the computer. The ask to set a name lives
 * on the menu's Personalize row, with its attention mark. The line under the
 * name is "Account and settings" while the local runtime is connected or
 * still being checked; any trouble speaks its own SENTENCE there instead
 * (`RUNTIME_STATUS_SENTENCES`), never the bare status word, so a failure is
 * never hidden behind the cell's label. Screen rows route through
 * `setShellRoute` with the trigger's rect as the expand origin.
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
  LineChevronUp,
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
import { useReducedMotion } from "../../lib/motion/index.js";
import { Menu, type MenuEntry } from "../../components/ui/menu.js";
import { Swatch, type SwatchState } from "../../components/ui/swatch.js";
import { useSystemHealth } from "../../lib/api/system.js";
import { useMemoryFeatureEnabled } from "../../lib/api/capabilities.js";
import { useUserProfile } from "../../lib/api/user-profile.js";
import { useUiStore } from "../../stores/uiStore.js";
import { LOCK_BUTTON } from "@shared/lock-button.js";
import { LOCK_VEX_SHORTCUT, useLockVexControl } from "./LockVexControl.js";
import { VexSetupDialog } from "./VexSetupDialog.js";

/** The full-app screens the profile menu can open (each a `ShellRoute` kind). */
type ProfileMenuScreen = "memory" | "sessions" | "agentScan" | "howItWorks";

/**
 * Chronos hallmark: the healthy runtime's sentence. Test-pinned copy. The
 * account cell shows H3's line instead while all is well; the sentence stays
 * the healthy entry of the table below.
 */
export const NIGHT_SHIFT_MESSAGE = "The night shift is active.";

/** H3's words in the account cell (Appendix A.2). */
export const ACCOUNT_CELL_NAME = "You";
export const ACCOUNT_CELL_LINE = "Account and settings";

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

/**
 * The person's avatar disc (section 1.4), the transcript's own drawing
 * (`TranscriptMessage.tsx`, `YouAvatar`): 36 across on the chosen rule, the
 * person glyph in ink. Decorative: the trigger's name says whose cell it is.
 */
function AccountDisc(): JSX.Element {
  return (
    <span aria-hidden data-vex-account-disc="" className="vex-prof__av">
      <svg width={36} height={36} viewBox="0 0 36 36" focusable="false">
        <circle className="vex-prof__disc" cx="18" cy="18" r="17.5" strokeWidth="1" />
        <g className="vex-prof__glyph">
          <circle cx="18" cy="14.5" r="3.5" />
          <path d="M11 25c0-3.9 3.1-6.2 7-6.2s7 2.3 7 6.2z" />
        </g>
      </svg>
    </span>
  );
}

/**
 * Profile panel geometry: opened upward from the account cell, the panel's
 * foot sits on the cell's top rule, a cell stacked on the cell that opened
 * it, from the column's left edge (the Menu keeps any list 12 in from the
 * window's edge, so on screen it stands 12 in).
 */
const PANEL_INSET_X = 0;
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

  // The cell's accessible name is the name the cell SHOWS (a screen reader
  // user hears the account, not the product), then the runtime word: the
  // person's name, or "You" until they set one.
  const accountName = nameLine.text;
  // The line under the name: H3's "Account and settings" while the runtime
  // is connected or still being checked; any trouble speaks its sentence.
  const cellLine =
    runtime.state === "connected" || runtime.state === "connecting"
      ? ACCOUNT_CELL_LINE
      : runtime.sentence;

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
        shortcut: LOCK_VEX_SHORTCUT,
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

  // Opened upward from the cell, the list is the profile panel: its left edge
  // the trigger's (the trigger spans the cell, so the column's), its foot on
  // the cell's top edge. The Menu places an upward list MENU_GAP above the
  // rect it is handed, so the rect's top is set to land there.
  const panelAnchorRect = useCallback((): DOMRect | null => {
    const el = triggerRef.current;
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    const left = r.left + PANEL_INSET_X;
    const top = r.top + MENU_GAP;
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
      // The collapsed rail renders no line under a name, so the tooltip is
      // its only carrier there: the cell's line, or the trouble's sentence.
      title={sidebarOpen ? undefined : cellLine}
      onClick={() => open ? closeMenu() : setMenuPhase("open")}
      className="vex-prof"
      data-open={sidebarOpen || undefined}
    >
      {/* The person's disc; the closed rail shows the disc alone. */}
      <AccountDisc />
      {sidebarOpen ? (
        <>
          <span className="vex-prof__name">
            <span className="vex-prof__n">{nameLine.text}</span>
            {/* "Account and settings" on one line; a trouble's sentence may
              * take two: a clipped cause is the defect again. */}
            <span
              className={cn("vex-prof__s", cellLine === ACCOUNT_CELL_LINE && "vex-prof__s--line")}
            >
              {cellLine}
            </span>
          </span>
          <LineChevronUp className="vex-profile-chevron vex-prof__chev" />
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
 * Name-line derivation: the person's own name, or H3's "You" (Appendix A.2)
 * before they set one. Every non-success state (loading, IPC error, or a
 * resolved `Result.ok === false`) also reads "You" and never asks, so the
 * menu's personalize mark never flashes before the profile has loaded. A name
 * that is only spaces is no name.
 */
function getNameLine({ loading, error, result }: NameLineInput): {
  readonly asksToPersonalize: boolean;
  readonly text: string;
} {
  if (loading || error || result === undefined || !result.ok) {
    return { asksToPersonalize: false, text: ACCOUNT_CELL_NAME };
  }
  const name = result.data.displayName?.trim() ?? "";
  if (name === "") return { asksToPersonalize: true, text: ACCOUNT_CELL_NAME };
  return { asksToPersonalize: false, text: name };
}
