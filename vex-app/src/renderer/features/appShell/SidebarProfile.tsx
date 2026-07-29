/**
 * SIDEBAR PROFILE — the rail's footer identity element (Chronos redesign,
 * 2026-07-20). One avatar row whose anchored side-panel menu owns the app's
 * destinations, so the rail ends in a single calm line instead of a stack of
 * registry rows.
 *
 * The row: the Vex mark (`/icon.png`), a NAME line, a state-voiced subtitle —
 * the Chronos hallmark ("The night shift is active.", serif italic) while the
 * runtime is verifiably healthy, plain mono telemetry the moment it is not —
 * and a chevron (the clickability affordance; the old avatar status dot is
 * gone, runtime state lives in the menu's status row).
 *
 * The name line is the user's own "Vex setup" `displayName`
 * (`@shared/schemas/user-profile.js`, via `useUserProfile`) once set; before
 * that it is a gentle ask ("What should Vex call you?"). The trigger's own
 * `aria-label` keeps the stable "Vex" brand regardless — it names the menu,
 * not the person.
 *
 * The menu follows the repo-native anchored-panel pattern (GlobalApprovals /
 * components/ui/select-menu.tsx): no portals, outside pointerdown + Escape
 * close, focus moved into the panel on open and restored to the trigger on
 * close. The panel is `absolute bottom-full` — OUT of flow, deliberately
 * WIDER than the rail (340px, overflowing to the right; the rail must not
 * clip it), so opening it can never displace the session list (the previous
 * round's `.vex-distorted-glass` class carried an unlayered
 * `position: relative` that beat the layered `absolute` utility and dropped
 * the panel INTO flow — the "whole sidebar jumps" bug). Entries carry hint
 * sublines; Personalize opens the "Vex setup" dialog (with a STATIC cobalt
 * attention dot while no display name is set), Memory / Sessions / Agent Scan
 * / How Vex works open their full-app ShellScreens (measuring the row rect as
 * the screen's expand origin; Missions is retired — Sessions covers it), and
 * Settings opens the in-shell Settings ShellScreen (Phase 2b — the
 * reconfigure-wizard door is retired). The footer status row speaks
 * one short word ("Connected" / "Connecting" / …) beside the Docker/Postgres
 * provenance marks — no dots anywhere (the pulse-dot law is retired).
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import {
  AiChat01Icon,
  ArrowUp01Icon,
  BookOpen01Icon,
  Brain01Icon,
  type IconGlyph,
  Radar01Icon,
  Settings02Icon,
  UserEdit01Icon,
  VexIcon,
} from "../../components/icons/index.js";
import { Docker, Postgresql } from "@thesvg/react";
import type { Result } from "@shared/ipc/result.js";
import type { HealthReport } from "@shared/schemas/system.js";
import type { UserProfile } from "@shared/schemas/user-profile.js";
import { cn } from "../../lib/utils.js";
import { EASE_STANDARD, SPRING_SNAPPY } from "../../lib/motion.js";
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

/** jsdom-safe reduced-motion probe (matchMedia may be absent in jsdom). */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// macOS-menu pop (cult SidePanel DNA on the shared constants): the panel
// springs open from the trigger corner (`origin-bottom-left` in the
// className), then rows cascade on the EASE_STANDARD tween at ~0.05s.
const panelVariants: Variants = {
  hidden: { opacity: 0, y: 8, scale: 0.92 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      ...SPRING_SNAPPY,
      delayChildren: 0.08,
      staggerChildren: 0.05,
    },
  },
  exit: {
    opacity: 0,
    y: 6,
    scale: 0.96,
    transition: { duration: 0.15, ease: EASE_STANDARD },
  },
};

const rowVariants: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE_STANDARD } },
};

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
  // Sampled once per mount — the menu is tiny, a live OS-preference flip can
  // wait for the next mount.
  const [reduced] = useState(prefersReducedMotion);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const closeMenu = useCallback((): void => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Outside pointerdown collapses the menu (no focus restore — the user is
  // deliberately interacting elsewhere). Only wired while open.
  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Move focus into the panel on open; the root's Escape handler below then
  // closes from anywhere within and restores the trigger.
  useEffect((): void => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closeMenu();
    }
  };

  // Screen rows measure their own rect on click — the ShellScreen expands
  // out of the exact row the user pressed.
  const openScreenFromRow = useCallback(
    (screen: ProfileMenuScreen, event: MouseEvent<HTMLButtonElement>): void => {
      const rect = event.currentTarget.getBoundingClientRect();
      setOpen(false);
      setShellRoute({
        kind: screen,
        origin: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    },
    [setShellRoute],
  );

  const openPersonalize = useCallback((): void => {
    setOpen(false);
    setSetupOpen(true);
  }, []);

  // Settings expands out of its own row too — same rect capture as the
  // screen rows, but the settings route carries a deep-link `section`
  // payload (null here: the profile row lands on the register).
  const openSettings = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      const rect = event.currentTarget.getBoundingClientRect();
      setOpen(false);
      setShellRoute({
        kind: "settings",
        origin: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        section: null,
      });
    },
    [setShellRoute],
  );

  return (
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      data-vex-area="sidebar-profile"
      className="relative border-t border-[var(--vex-line)] bg-[var(--vex-rail-strong)]"
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Vex — ${runtime.label}. Open menu`}
        title={sidebarOpen ? undefined : runtime.label}
        onClick={() => (open ? closeMenu() : setOpen(true))}
        className={cn(
          "flex w-full items-center transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--vex-accent)]",
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
                <span className="truncate text-[12.5px] font-normal leading-tight text-[var(--vex-text-2)]">
                  {nameLine.text}
                </span>
              ) : (
                <span className="truncate text-[13px] font-semibold leading-tight text-foreground">
                  {nameLine.text}
                </span>
              )}
              {runtime.live ? (
                // The hallmark earns the serif voice ONLY while the runtime is
                // verifiably healthy; any other state speaks plain telemetry.
                <span className="truncate font-serif text-[12px] italic leading-tight text-[var(--vex-text-2)]">
                  {NIGHT_SHIFT_MESSAGE}
                </span>
              ) : (
                <span className="truncate font-mono text-[9.5px] uppercase tracking-[0.14em] leading-tight text-[var(--vex-text-3)]">
                  {runtime.label}
                </span>
              )}
            </span>
            {/* Chevron affordance — the menu opens upward, so the closed state
             * points up and rotates when open. */}
            <VexIcon
              icon={ArrowUp01Icon}
              size={15}
              aria-hidden
              className={cn(
                "shrink-0 text-[var(--vex-text-3)] transition-transform duration-200",
                open && "rotate-180",
              )}
            />
          </>
        ) : null}
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            ref={panelRef}
            id={panelId}
            role="menu"
            aria-label="Vex menu"
            data-vex-area="sidebar-profile-menu"
            tabIndex={-1}
            variants={panelVariants}
            initial={reduced ? false : "hidden"}
            animate="show"
            exit={reduced ? undefined : "exit"}
            // Floating Chronos glass panel (owner correction round,
            // 2026-07-20): ink glass + blur carries legibility, a static
            // grain overlay decorates — never a filter on content (the
            // previous DistortedGlass displacement filter warped this menu's
            // text into illegible squiggles and is retired). Directional
            // drop shadow, never a resting glow. 340px — deliberately WIDER
            // than the rail, overflowing to the right (the rail's z-20 keeps
            // the overflow painted above the center column); absolute = out
            // of flow, zero layout shift.
            className="absolute bottom-full left-3 z-40 mb-2 w-[340px] origin-bottom-left overflow-hidden rounded-xl border border-[var(--vex-line-strong)] bg-[var(--vex-glass-strong)] py-1.5 shadow-[0_18px_40px_-18px_rgba(0,0,0,0.8)] backdrop-blur-xl focus-visible:outline-none"
          >
            <div
              aria-hidden
              className="vex-noise vex-noise--panel pointer-events-none absolute inset-0 -z-10 rounded-[inherit]"
            />
            <ProfileMenuItem
              icon={UserEdit01Icon}
              label="Personalize"
              hint={
                nameLine.asksToPersonalize
                  ? "You didn't set up your name"
                  : "Name, tone, instructions"
              }
              attention={nameLine.asksToPersonalize}
              onSelect={() => openPersonalize()}
            />
            {memoryEnabled ? (
              <ProfileMenuItem
                icon={Brain01Icon}
                label="Memory"
                hint="What Vex has learned"
                onSelect={(event) => openScreenFromRow("memory", event)}
              />
            ) : null}
            <ProfileMenuItem
              icon={AiChat01Icon}
              label="Sessions"
              hint="Find any conversation"
              onSelect={(event) => openScreenFromRow("sessions", event)}
            />
            <ProfileMenuItem
              icon={Radar01Icon}
              label="Agent Scan"
              hint="Every move, verified on-chain"
              onSelect={(event) => openScreenFromRow("agentScan", event)}
            />
            <ProfileMenuItem
              icon={BookOpen01Icon}
              label="How Vex works"
              hint="Start here — the five-minute tour"
              onSelect={(event) => openScreenFromRow("howItWorks", event)}
            />
            <ProfileMenuItem
              icon={Settings02Icon}
              label="Settings"
              hint="Wallets, keys, model"
              onSelect={(event) => openSettings(event)}
            />
            <motion.div
              variants={rowVariants}
              aria-hidden
              className="mx-3 my-1.5 h-px bg-[var(--vex-line)]"
            />
            {/* Runtime provenance row — one short word + the Docker/Postgres
             * marks. Read-only, dot-free by decree. */}
            <motion.div
              variants={rowVariants}
              className="flex items-center gap-2 px-4 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--vex-text-2)]">
                {runtime.label}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-[var(--vex-text-3)]">
                <Docker width={14} height={14} aria-hidden focusable={false} />
                <Postgresql width={14} height={14} aria-hidden focusable={false} />
              </span>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <VexSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
    </div>
  );
}

function ProfileMenuItem({
  icon,
  label,
  hint,
  attention = false,
  onSelect,
}: {
  readonly icon: IconGlyph;
  readonly label: string;
  readonly hint: string;
  /** Static cobalt attention dot on the row edge — color only, never motion. */
  readonly attention?: boolean;
  readonly onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  return (
    <motion.button
      variants={rowVariants}
      type="button"
      role="menuitem"
      onClick={onSelect}
      className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--vex-accent)]"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--vex-line)] text-[var(--vex-text-2)]">
        <VexIcon icon={icon} size={15} aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] leading-tight text-foreground">
          {label}
        </span>
        <span className="truncate text-[11px] leading-tight text-[var(--vex-text-3)]">
          {hint}
        </span>
      </span>
      {attention ? (
        <span
          aria-hidden
          data-vex-attention-dot
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--vex-accent)]"
        />
      ) : null}
    </motion.button>
  );
}

interface RuntimeStatusInput {
  readonly loading: boolean;
  readonly result: Result<HealthReport> | undefined;
}

/** Status derivation — the same health fork the retired RuntimeLedger used,
 * now speaking ONE short word (test-pinned; visual casing is CSS-only). */
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
 * profile has actually loaded — the ask is a positive statement ("this user
 * has no name set yet"), not a default we can assume mid-fetch.
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
