import { StrictMode } from "react";
import type { JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { HealthReport } from "@shared/schemas/system.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { createQueryClient } from "../../../../app/queryClient.js";

/**
 * Shared AppShell test-render + fixture helpers. Before the F1 500-line-cap
 * split, this exact ~130-line block was duplicated byte-for-byte at the
 * bottom of every AppShell/*.test.tsx sibling file. Extracting it here is
 * what makes welcome-create.test.tsx's split possible at all: that file's
 * own domain-specific header setup (reasoning/models query mocks) already
 * runs ~368 lines, leaving no room under the 500-line cap to also inline
 * this block in every resulting split file.
 *
 * `AppShell` itself stays a PER-FILE dynamic import (`await
 * import("../../AppShell.js")`) — each test file's own `vi.mock()` calls
 * must register before the component module loads, so the component can't
 * be statically imported from a shared module. `createShellRenderers` takes
 * the already-resolved component and returns the same zero-arg
 * `renderShell`/`renderShellStrict` call shape every test already used, so
 * no it() body changes.
 */
export function createShellRenderers(AppShell: () => JSX.Element): {
  readonly renderShell: () => ReturnType<typeof render> & {
    readonly queryClient: QueryClient;
  };
  readonly renderShellStrict: () => ReturnType<typeof render>;
} {
  function renderShell(): ReturnType<typeof render> & {
    readonly queryClient: QueryClient;
  } {
    const client = createQueryClient();
    client.setDefaultOptions({
      queries: {
        retry: false,
      },
    });
    const result = render(
      <QueryClientProvider client={client}>
        <AppShell />
      </QueryClientProvider>,
    );
    // Object.assign keeps the existing call-sites (which use `renderShell()`
    // without destructuring) working while letting new tests read the
    // QueryClient for direct cache assertions.
    return Object.assign(result, { queryClient: client });
  }

  // Same as `renderShell` but wrapped in <StrictMode> so dev mount-effect
  // replay (subscribe → cleanup → subscribe) is exercised — the condition that
  // detaches the chat MutationObserver mid-flight and froze `isPending`.
  function renderShellStrict(): ReturnType<typeof render> {
    const client = createQueryClient();
    client.setDefaultOptions({ queries: { retry: false } });
    return render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <AppShell />
        </QueryClientProvider>
      </StrictMode>,
    );
  }

  return { renderShell, renderShellStrict };
}

export function makeAgentRow(title: string): SessionListItem {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    mode: "agent",
    permission: "restricted",
    title,
    initialGoal: null,
    startedAt: localIsoDaysAgo(0),
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
  };
}

export function makeSessionRows(): readonly SessionListItem[] {
  return [
    {
      id: "fb7bf453-df76-43e9-b756-02c3b717f242",
      mode: "mission",
      permission: "restricted",
      title: "Arbitrum LP Rebalance",
      initialGoal: "Arbitrum LP Rebalance",
      startedAt: localIsoDaysAgo(0),
      endedAt: null,
      missionStatus: "running",
      pinnedAt: null,
    },
    {
      id: "2c7e7135-6d80-443c-b73e-b43717a09425",
      mode: "agent",
      permission: "restricted",
      title: null,
      initialGoal: null,
      startedAt: localIsoDaysAgo(0),
      endedAt: null,
      missionStatus: null,
      pinnedAt: null,
    },
    {
      id: "cf0788b8-87c7-4eb2-b4b9-4252779f906d",
      mode: "mission",
      permission: "full",
      title: "Open BTC Perp Position",
      initialGoal: "Open BTC Perp Position",
      startedAt: localIsoDaysAgo(1),
      endedAt: null,
      missionStatus: "paused_wake",
      pinnedAt: null,
    },
    {
      id: "db01d1f7-8b1e-4607-a59c-cda6a9ff1024",
      mode: "agent",
      permission: "restricted",
      title: "Portfolio Check",
      initialGoal: "Portfolio Check",
      startedAt: localIsoDaysAgo(3),
      endedAt: null,
      missionStatus: null,
      pinnedAt: null,
    },
  ];
}

export function localIsoDaysAgo(days: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export function makeHealthReport(overall: HealthReport["overall"]): HealthReport {
  return {
    os: {
      platform: "linux",
      arch: "x64",
      release: "test",
      distro: "test",
      homedir: "/home/test",
      userDataDir: "/tmp/vex-test",
      appVersion: "0.0.0-test",
      electronVersion: "0.0.0-test",
      nodeVersion: "0.0.0-test",
    },
    network: {
      online: true,
      latencyMs: 1,
      probedAt: new Date("2026-05-19T12:00:00.000Z").toISOString(),
    },
    translocated: false,
    setupComplete: true,
    overall,
  };
}
