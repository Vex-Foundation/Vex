/**
 * SIDEBAR PROFILE — the rail's footer identity element. One avatar row (the
 * Vex mark, the user's display name or the personalize ask, a state-voiced
 * subtitle) whose portal Menu owns the app's destinations: Personalize,
 * Memory, Sessions, Agent Scan, How Vex works, Settings, plus a read-only
 * runtime provenance row pinned in the menu footer. The trigger row keeps
 * the rail's glass; the menu card is the shared `Menu` primitive chrome.
 *
 * The name line is the user's own "Vex setup" `displayName` once set; before
 * that it is a gentle ask ("What should Vex call you?"). The healthy-runtime
 * subtitle speaks the serif hallmark; any other state speaks plain
 * telemetry. Screen rows route through `setShellRoute` with the trigger
 * row's rect as the expand origin.
 */

import {
  useCallback,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import {
  IconChevronUp,
  IconInspect,
  IconNewChat,
  IconQuestion,
  IconSettings,
  IconThink,
  IconUser,
  type GlyphProps,
} from "../../components/icons/index.js";
import { Docker, Postgresql } from "@thesvg/react";
import type { Result } from "@shared/ipc/result.js";
import type { HealthReport } from "@shared/schemas/system.js";
import type { UserProfile } from "@shared/schemas/user-profile.js";
import { cn } from "../../lib/utils.js";
import { Menu, type MenuEntry } from "../../components/ui/menu.js";
import { useSystemHealth } from "../../lib/api/system.js";
import { useMemoryFeatureEnabled } from "../../lib/api/capabilities.js";
import { useUserProfile } from "../../lib/api/user-profile.js";
import { useUiStore } from "../../stores/uiStore.js";
import { VexSetupDialog } from "./VexSetupDialog.js";

/** The Vex mark doubling as the local "profile" picture. */
const AVATAR_SRC = "/icon.png";

/** The full-app screens the profile menu can open (each a `ShellRoute` kind). */
type ProfileMenuScreen = "memory" | "sessions" | "agentScan" | "howItWorks";

/** Chronos hallmark — the healthy-runtime subtitle. Test-pinned copy. */
export const NIGHT_SHIFT_MESSAGE = "The night shift is active.";

/** Two-line menu row body: label over its hint subline. */
function entryLabel(label: string, hint: string, attention = false): ReactNode {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] leading-tight">{label}</span>
        <span className="truncate text-[11px] leading-tight text-ink-tertiary">
          {hint}
        </span>
      </span>
      {attention ? (
        <span
          aria-hidden
          data-vex-attention-dot
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-primary"
        />
      ) : null}
    </span>
  );
}

function entryIcon(Icon: (props: GlyphProps) => ReactNode): ReactNode {
  return <Icon size={15} />;
}

export function SidebarProfile({
  sidebarOpen,
}: {
  readonly sidebarOpen: boolean;
}): JSX.Element {
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

  const [open, setOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const items: MenuEntry[] = [
    {
      id: "personalize",
      icon: entryIcon(IconUser),
      label: entryLabel(
        "Personalize",
        nameLine.asksToPersonalize
          ? "You didn't set up your name"
          : "Name, tone, instructions",
        nameLine.asksToPersonalize,
      ),
    },
    ...(memoryEnabled
      ? [
          {
            id: "memory",
            icon: entryIcon(IconThink),
            label: entryLabel("Memory", "What Vex has learned"),
          },
        ]
      : []),
    {
      id: "sessions",
      icon: entryIcon(IconNewChat),
      label: entryLabel("Sessions", "Find any conversation"),
    },
    {
      id: "agentScan",
      icon: entryIcon(IconInspect),
      label: entryLabel("Agent Scan", "Every move, verified on-chain"),
    },
    {
      id: "howItWorks",
      icon: entryIcon(IconQuestion),
      label: entryLabel("How Vex works", "Start here - the five-minute tour"),
    },
    {
      id: "settings",
      icon: entryIcon(IconSettings),
      label: entryLabel("Settings", "Wallets, keys, model"),
    },
  ];

  // Runtime provenance row — read-only, pinned behind the footer hairline.
  const footer: MenuEntry[] = [
    {
      id: "runtime-status",
      disabled: true,
      label: (
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[12.5px]">
            {runtime.label}
          </span>
          <span className="flex shrink-0 items-center gap-2 text-ink-tertiary">
            <Docker width={14} height={14} aria-hidden focusable={false} />
            <Postgresql width={14} height={14} aria-hidden focusable={false} />
          </span>
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
      setOpen(false);
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
    [openScreen, openSettings],
  );

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Vex - ${runtime.label}. Open menu`}
      title={sidebarOpen ? undefined : runtime.label}
      onClick={() => setOpen((prev) => !prev)}
      className={cn(
        "flex w-full items-center transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary",
        sidebarOpen ? "h-14 gap-2.5 px-4 text-left" : "h-12 justify-center px-0",
      )}
    >
      {/* Collapsed rail stays clean: the mark alone, no dot, no chevron. */}
      <img
        src={AVATAR_SRC}
        alt=""
        aria-hidden
        draggable={false}
        className="h-7 w-7 shrink-0 select-none rounded-full"
      />
      {sidebarOpen ? (
        <>
          <span className="flex min-w-0 flex-1 flex-col">
            {nameLine.asksToPersonalize ? (
              // Gentle call-to-action voice — NOT semibold, so it never
              // reads as the confident brand name it is standing in for.
              <span className="truncate text-[12.5px] font-normal leading-tight text-ink-secondary">
                {nameLine.text}
              </span>
            ) : (
              <span className="truncate text-[13px] font-medium leading-tight text-foreground">
                {nameLine.text}
              </span>
            )}
            {runtime.live ? (
              // The hallmark shows ONLY while the runtime is verifiably
              // healthy; any other state speaks plain telemetry. It used to
              // earn a serif italic for the distinction - the serif left shell
              // chrome (owner 6a, ratified 2026-08-21), so the line is now
              // marked by its TIER against the tertiary telemetry beside it.
              <span className="truncate text-[12px] leading-tight text-ink-secondary">
                {NIGHT_SHIFT_MESSAGE}
              </span>
            ) : (
              <span className="vex-micro truncate leading-tight text-ink-tertiary">
                {runtime.label}
              </span>
            )}
          </span>
          {/* Chevron affordance — the menu opens upward, so the closed state
           * points up and rotates when open. */}
          <IconChevronUp
            size={15}
            className={cn(
              "shrink-0 text-ink-tertiary transition-transform duration-200",
              open && "rotate-180",
            )}
          />
        </>
      ) : null}
    </button>
  );

  return (
    <div
      data-vex-area="sidebar-profile"
      className="relative border-t border-[var(--vex-line)] bg-[var(--vex-rail-strong)]"
    >
      <Menu
        open={open}
        anchor={trigger}
        items={items}
        footer={footer}
        onSelect={onSelect}
        onClose={() => setOpen(false)}
        portal
        side="top"
        align="start"
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

/** Status derivation — ONE short word (test-pinned; casing is CSS-only). */
function getRuntimeStatus({ loading, result }: RuntimeStatusInput): {
  readonly label: string;
  /** True only when the runtime is verifiably connected and healthy. */
  readonly live: boolean;
} {
  if (loading || result === undefined) {
    return { label: "Connecting", live: false };
  }
  if (!result.ok) {
    return { label: "Unavailable", live: false };
  }
  if (result.data.overall === "ok") {
    return { label: "Connected", live: true };
  }
  return {
    label: result.data.overall === "degraded" ? "Degraded" : "Not ready",
    live: false,
  };
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
    // Test-pinned copy — VexSetupDialog's matching field label reuses the
    // same literal for its "What should Vex call you?" input.
    return { asksToPersonalize: true, text: "What should Vex call you?" };
  }
  return { asksToPersonalize: false, text: result.data.displayName };
}
