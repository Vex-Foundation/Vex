/**
 * APPROVAL PROVENANCE (B4c) - which project asked, on the inbox row and in the
 * card.
 *
 * The contract, from `shared/schemas/approvals.ts`: `projectId` is the
 * IDENTITY (uuid, nullable) and `projectName` is DISPLAY-ONLY user-authored
 * text that deliberately survives a project tombstone. So:
 *  - the NAME is what the user reads, the ID is always in the title/accessible
 *    name, because a name can be edited or outlive its project;
 *  - a row WITHOUT a project renders nothing at all. An agent approval has no
 *    project, and an empty "Project" row would invent a fact;
 *  - with an id but no joined name (the inline session card reads
 *    `ApprovalSummaryDto`, which has no join) the id itself is the display
 *    text - never a placeholder, never blank.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";

vi.mock("../../../lib/api/approvals.js", () => ({
  useApprove: () => ({ mutate: vi.fn(), isPending: false }),
  useReject: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { GlobalApprovalItem } = await import(
  "../GlobalApprovals/GlobalApprovalItem.js"
);
const { ApprovalCard } = await import("../ApprovalCard.js");

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
    requestedByClient: null,
    projectName: null,
    sessionTitle: "Alpha session",
    ...over,
  };
}

function renderItem(row: ApprovalPendingGlobalDto): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <GlobalApprovalItem row={row} onOpenSession={() => undefined} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the inbox row's project tag", () => {
  it("shows the project NAME and carries the id in its accessible detail", () => {
    renderItem(makeRow({ projectId: PROJECT, projectName: "Acme Trading" }));
    const tag = document.querySelector('[data-vex-area="approval-project-tag"]');
    expect(tag).not.toBeNull();
    expect(tag?.textContent).toBe("Acme Trading");
    expect(tag?.getAttribute("title")).toBe(
      `Vex Studio project Acme Trading (${PROJECT})`,
    );
    expect(tag?.getAttribute("aria-label")).toBe(
      `Vex Studio project Acme Trading (${PROJECT})`,
    );
  });

  it("falls back to the id when the row carries no name", () => {
    renderItem(makeRow({ projectId: PROJECT, projectName: null }));
    const tag = document.querySelector('[data-vex-area="approval-project-tag"]');
    expect(tag?.textContent).toBe(PROJECT);
    expect(tag?.getAttribute("title")).toBe(`Vex Studio project ${PROJECT}`);
  });

  it("renders NOTHING for an agent approval with no project", () => {
    renderItem(makeRow());
    expect(
      document.querySelector('[data-vex-area="approval-project-tag"]'),
    ).toBeNull();
    // The session header is still there - the tag's absence removes a fact,
    // not the row's identity.
    expect(screen.getByText("Alpha session")).not.toBeNull();
  });
});

describe("the approval card's project field", () => {
  it("labels the field and shows the joined name from the inbox row", () => {
    renderItem(makeRow({ projectId: PROJECT, projectName: "Acme Trading" }));
    const field = screen.getByTestId("approval-project");
    expect(field.textContent).toContain("Project");
    expect(field.textContent).toContain("Acme Trading");
  });

  it("shows the id when the card is mounted without a joined name", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <ApprovalCard
          summary={makeRow({ projectId: PROJECT })}
          sessionId={SESSION}
          focusOnMount={false}
        />
      </QueryClientProvider>,
    );
    const field = screen.getByTestId("approval-project");
    expect(field.textContent).toContain(PROJECT);
  });

  it("renders no field at all for an approval with no project", () => {
    renderItem(makeRow());
    expect(screen.queryByTestId("approval-project")).toBeNull();
  });
});
