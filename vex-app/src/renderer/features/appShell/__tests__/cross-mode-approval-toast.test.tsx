/**
 * THE CROSS-MODE APPROVAL TOAST (B4c) - fired once, and only once.
 *
 * The whole value of this surface is that it does NOT nag. The list it watches
 * is redelivered constantly: a 15s/60s fallback poll, every push invalidation,
 * and React's StrictMode double-invoke. And the moment that makes an approval
 * "cross-mode" is a MODE SWITCH, which is exactly when a component-scoped
 * memory would reset and re-announce every pending row.
 *
 * So the pins are: first observation fires; refetch, a StrictMode remount and
 * a mode switch fire nothing more; a genuinely NEW id fires again; and an
 * approval raised in the mode already on screen never fires at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";
import type { Result } from "@shared/ipc/result.js";

const shown: string[] = [];
vi.mock("../../../lib/toast.js", () => ({
  showToast: (text: string) => {
    shown.push(text);
  },
}));

let pendingState: {
  data: Result<ReadonlyArray<ApprovalPendingGlobalDto>> | undefined;
} = { data: undefined };

vi.mock("../../../lib/api/approvals.js", () => ({
  usePendingApprovalsAll: () => pendingState,
  useGlobalApprovalsLiveSync: () => {},
  useApprove: () => ({ mutate: vi.fn(), isPending: false }),
  useReject: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { GlobalApprovals } = await import("../GlobalApprovals.js");
const { useUiStore } = await import("../../../stores/uiStore.js");
const { resetCrossModeToastMemory } = await import(
  "../approvals/useCrossModeApprovalToast.js"
);

const SESSION = "00000000-0000-4000-8000-0000000000a1";
const PROJECT = "9c1b0e8e-0000-4000-8000-0000000000ab";

function makeRow(
  over: Partial<ApprovalPendingGlobalDto> = {},
): ApprovalPendingGlobalDto {
  return {
    id: "g-1",
    sessionId: SESSION,
    toolCallId: "tc-1",
    toolName: "wallet:send",
    status: "pending",
    permissionAtEnqueue: "restricted",
    createdAt: "2026-05-28T10:00:00.000Z",
    resolvedAt: null,
    reasoningPreview: "confirm transfer",
    actionKind: "read",
    riskLevel: "info",
    preview: null,
    expiresAt: null,
    decision: null,
    decisionReason: null,
    executionStatus: null,
    origin: null,
    projectId: null,
    projectName: null,
    sessionTitle: "Alpha session",
    ...over,
  };
}

const STUDIO_ROW = makeRow({
  id: "studio-1",
  projectId: PROJECT,
  projectName: "Acme Trading",
  origin: "studio_mcp",
});

function setRows(rows: ReadonlyArray<ApprovalPendingGlobalDto>): void {
  pendingState = { data: { ok: true, data: rows } };
}

function renderBadge(strict = false): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={qc}>
      <GlobalApprovals />
    </QueryClientProvider>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

beforeEach(() => {
  shown.length = 0;
  resetCrossModeToastMemory();
  pendingState = { data: undefined };
  useUiStore.setState({ runtimeMode: "agent", activeProjectId: null });
});

describe("a Studio-raised approval seen from agent mode", () => {
  it("announces once, naming the tool and the project", () => {
    setRows([STUDIO_ROW]);
    renderBadge();
    expect(shown).toEqual([
      "Approval waiting in Acme Trading: wallet:send",
    ]);
  });

  it("a REFETCH delivering the same row announces nothing more", () => {
    setRows([STUDIO_ROW]);
    const view = renderBadge();
    expect(shown).toHaveLength(1);
    // A new array identity, same rows - exactly what a poll tick produces.
    setRows([{ ...STUDIO_ROW }]);
    view.rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <GlobalApprovals />
      </QueryClientProvider>,
    );
    expect(shown).toHaveLength(1);
  });

  it("a StrictMode double-mount announces once, not twice", () => {
    setRows([STUDIO_ROW]);
    renderBadge(true);
    expect(shown).toHaveLength(1);
  });

  it("a MODE SWITCH announces nothing for an already-observed row", () => {
    setRows([STUDIO_ROW]);
    const view = renderBadge();
    expect(shown).toHaveLength(1);
    // The row is now same-mode, and it was already observed either way. The
    // memory lives above the mode dispatch precisely so this stays silent.
    useUiStore.setState({ runtimeMode: "studio" });
    view.rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <GlobalApprovals />
      </QueryClientProvider>,
    );
    expect(shown).toHaveLength(1);
  });

  it("a genuinely NEW id announces again", () => {
    setRows([STUDIO_ROW]);
    const view = renderBadge();
    setRows([
      STUDIO_ROW,
      makeRow({
        id: "studio-2",
        projectId: PROJECT,
        projectName: "Acme Trading",
        origin: "studio_mcp",
        toolName: "wallet:swap",
        createdAt: "2026-05-28T10:05:00.000Z",
      }),
    ]);
    view.rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <GlobalApprovals />
      </QueryClientProvider>,
    );
    expect(shown).toEqual([
      "Approval waiting in Acme Trading: wallet:send",
      "Approval waiting in Acme Trading: wallet:swap",
    ]);
  });
});

describe("a BATCH observed in one tick", () => {
  it("names the oldest and REPORTS how many came with it", () => {
    // Three cross-mode rows arrive together. All three are marked announced by
    // the observation, and there is one transient slot, so only the oldest can
    // be named - which is exactly why the other two have to be counted. A bare
    // single-row line would silently swallow them.
    setRows([
      STUDIO_ROW,
      makeRow({
        id: "studio-2",
        projectId: PROJECT,
        projectName: "Acme Trading",
        origin: "studio_mcp",
        toolName: "wallet:swap",
        createdAt: "2026-05-28T10:01:00.000Z",
      }),
      makeRow({
        id: "studio-3",
        projectId: PROJECT,
        projectName: "Acme Trading",
        origin: "studio_mcp",
        toolName: "wallet:approve",
        createdAt: "2026-05-28T10:02:00.000Z",
      }),
    ]);
    renderBadge();
    expect(shown).toEqual([
      "Approval waiting in Acme Trading: wallet:send, and 2 more awaiting",
    ]);
  });

  it("counts only the CROSS-MODE rows, not the same-mode ones beside them", () => {
    // Two agent rows ride along in the same tick. From agent mode they are not
    // cross-mode, they raise no announcement, and counting them would tell the
    // user there is more waiting elsewhere than there is.
    setRows([
      STUDIO_ROW,
      makeRow({ id: "agent-1", origin: "agent", createdAt: "2026-05-28T10:01:00.000Z" }),
      makeRow({ id: "agent-2", origin: "agent", createdAt: "2026-05-28T10:02:00.000Z" }),
    ]);
    renderBadge();
    expect(shown).toEqual(["Approval waiting in Acme Trading: wallet:send"]);
  });

  it("a single cross-mode row carries no count", () => {
    setRows([STUDIO_ROW]);
    renderBadge();
    expect(shown).toEqual(["Approval waiting in Acme Trading: wallet:send"]);
  });
});

describe("same-mode approvals stay silent", () => {
  it("an agent approval seen from agent mode announces nothing", () => {
    setRows([makeRow({ origin: "agent" })]);
    renderBadge();
    expect(shown).toEqual([]);
  });

  it("a Studio approval seen from Studio mode announces nothing", () => {
    useUiStore.setState({ runtimeMode: "studio" });
    setRows([STUDIO_ROW]);
    renderBadge();
    expect(shown).toEqual([]);
  });

  it("an agent approval seen from Studio mode names the agent shell", () => {
    useUiStore.setState({ runtimeMode: "studio" });
    setRows([makeRow({ origin: "agent" })]);
    renderBadge();
    expect(shown).toEqual([
      "Approval waiting in the agent shell: wallet:send",
    ]);
  });
});

describe("an unknown list is not an observation", () => {
  it("a loading read announces nothing and records nothing", () => {
    pendingState = { data: undefined };
    const view = renderBadge();
    expect(shown).toEqual([]);
    // ... and the row still announces when it finally arrives.
    setRows([STUDIO_ROW]);
    view.rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <GlobalApprovals />
      </QueryClientProvider>,
    );
    expect(shown).toHaveLength(1);
  });

  it("a FAILED read announces nothing and records nothing", () => {
    pendingState = {
      data: {
        ok: false,
        error: {
          code: "internal.unexpected",
          domain: "approvals",
          message: "Unable to load approvals.",
          retryable: true,
          userActionable: false,
          redacted: true,
          correlationId: "req-x",
        },
      },
    };
    const view = renderBadge();
    expect(shown).toEqual([]);
    setRows([STUDIO_ROW]);
    view.rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <GlobalApprovals />
      </QueryClientProvider>,
    );
    expect(shown).toHaveLength(1);
  });
});
