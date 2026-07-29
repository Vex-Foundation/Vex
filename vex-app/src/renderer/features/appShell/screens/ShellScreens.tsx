/**
 * ShellScreens — the AppShell-mounted host for the full-app overlay screens
 * (Chronos screens redesign, 2026-07-20; atomic `shellRoute` since the
 * token-history round). Reads `uiStore.shellRoute`, mounts the matching
 * screen inside `AnimatePresence` (so the ShellScreen exit animation
 * actually plays), and owns the single close path:
 *
 *  - every screen closes back to `{ kind: "none" }`,
 *  - EXCEPT a token-history screen opened FROM the All-assets screen
 *    (`returnTo.kind === "assets"`), which returns there — remounted with a
 *    null origin (centered expand): the original morph origin belonged to a
 *    row instance that no longer exists, so reusing it would anchor a stale
 *    rect. The return CARRIES `returnTo.sessionId`, so a session-scoped
 *    All-assets register comes back session-scoped; re-minting a bare global
 *    route here silently widened the register behind the user's back.
 */

import { useCallback, type JSX } from "react";
import { AnimatePresence } from "motion/react";
import { useUiStore } from "../../../stores/uiStore.js";
import { MemoryScreen } from "./MemoryScreen.js";
import { SessionsScreen } from "./SessionsScreen.js";
import { HowVexWorksScreen } from "./HowVexWorksScreen.js";
import { AgentScanScreen } from "./AgentScanScreen.js";
import { AssetsScreen } from "./AssetsScreen.js";
import { SettingsScreen } from "./SettingsScreen.js";
import { TokenHistoryScreen } from "./TokenHistoryScreen.js";

export function ShellScreens(): JSX.Element {
  const route = useUiStore((s) => s.shellRoute);
  const setShellRoute = useUiStore((s) => s.setShellRoute);

  const close = useCallback((): void => {
    // Read the CURRENT route at close time (not a render-time capture):
    // Escape rides a window listener, so the callback may outlive a route swap.
    const current = useUiStore.getState().shellRoute;
    if (current.kind === "tokenHistory" && current.returnTo.kind === "assets") {
      setShellRoute({
        kind: "assets",
        origin: null,
        sessionId: current.returnTo.sessionId,
      });
      return;
    }
    setShellRoute({ kind: "none" });
  }, [setShellRoute]);

  return (
    <AnimatePresence>
      {route.kind === "memory" ? (
        <MemoryScreen key="memory" origin={route.origin} onClose={close} />
      ) : route.kind === "sessions" ? (
        <SessionsScreen key="sessions" origin={route.origin} onClose={close} />
      ) : route.kind === "agentScan" ? (
        <AgentScanScreen
          // Identity-keyed on the scope: swapping between the global feed and
          // a session preset must remount, not reuse the old filter state.
          key={`agentScan:${route.sessionId ?? "global"}`}
          origin={route.origin}
          sessionId={route.sessionId}
          onClose={close}
        />
      ) : route.kind === "howItWorks" ? (
        <HowVexWorksScreen key="howItWorks" origin={route.origin} onClose={close} />
      ) : route.kind === "assets" ? (
        <AssetsScreen
          key={`assets:${route.sessionId ?? "global"}`}
          origin={route.origin}
          sessionId={route.sessionId}
          onClose={close}
        />
      ) : route.kind === "settings" ? (
        <SettingsScreen
          key="settings"
          origin={route.origin}
          section={route.section}
          onClose={close}
        />
      ) : route.kind === "tokenHistory" ? (
        <TokenHistoryScreen
          // Identity-keyed so switching tokens always remounts a fresh screen.
          key={`tokenHistory:${route.token.chainId}:${route.token.tokenAddress}`}
          origin={route.origin}
          token={route.token}
          onClose={close}
        />
      ) : null}
    </AnimatePresence>
  );
}
