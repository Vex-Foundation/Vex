/**
 * Component tests for the Migrations screen after the glass-aesthetic
 * redesign. Mocks `window.vex` per skill §12 - never reaches a real
 * IPC bridge.
 *
 * Preserves the four pre-existing assertions:
 *   - applied result renders Continue button (no Retry)
 *   - noop result auto-advances via openWizard("setup")
 *   - err result renders Retry button (no Continue)
 *   - progress events from the bus drive live UI updates
 *
 * Adds branch-level coverage for the redesign:
 *   - applied → ReadyBody shows "{N} migrations applied"
 *   - err with `details.failedAt` → ErrorBody shows version + file
 *   - data-vex-onboarding wrapper attribute set
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JSX } from "react";
import type { MigrateProgress } from "@shared/schemas/database.js";

function renderWithQuery(ui: JSX.Element): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

type ProgressCb = (payload: MigrateProgress) => void;

const mockMigrate = vi.fn();
const mockOnProgress = vi.fn();
const mockOpenWizard = vi.fn();
const mockOpenLogsFolder = vi.fn();
let progressCb: ProgressCb | null = null;

vi.mock("../../../stores/uiStore.js", () => ({
  useUiStore: (selector: (s: { openWizard: typeof mockOpenWizard }) => unknown) =>
    selector({ openWizard: mockOpenWizard }),
}));

beforeEach(() => {
  mockMigrate.mockReset();
  mockOnProgress.mockReset();
  mockOpenWizard.mockReset();
  mockOpenLogsFolder.mockReset().mockResolvedValue({
    ok: true,
    data: { opened: true },
  });
  progressCb = null;
  resetStageVex();
  // The launch is over: Vex's face is the screen's, with no wake to wait for.
  stageVexEnd();

  mockOnProgress.mockImplementation((cb: ProgressCb) => {
    progressCb = cb;
    return () => {
      progressCb = null;
    };
  });

  (globalThis as unknown as { window: Record<string, unknown> }).window =
    (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
  (globalThis as unknown as { window: { vex: unknown } }).window.vex = {
    database: {
      migrate: () => mockMigrate(),
      onProgress: (cb: ProgressCb) => mockOnProgress(cb),
    },
    support: { openLogsFolder: mockOpenLogsFolder },
  };
});

afterEach(() => {
  cleanup();
  resetStageVex();
});

const { Migrations } = await import("../Migrations.js");
const { getStageVex, resetStageVex, stageVexEnd, stageVexView } = await import(
  "../../../components/onboarding/stage-vex.js"
);

describe("Migrations component", () => {
  it("renders applied phase with Continue button (preserved)", async () => {
    mockMigrate.mockResolvedValue({
      ok: true,
      data: {
        kind: "applied",
        applied: 2,
        files: ["001.sql", "002.sql"],
        message: "Applied 2 migrations.",
      },
    });
    const { findByText, queryByRole } = renderWithQuery(<Migrations />);
    await findByText(/2 migrations applied/);
    expect(queryByRole("button", { name: /Continue/ })).toBeTruthy();
    expect(queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("auto-advances to wizard on noop (preserved)", async () => {
    mockMigrate.mockResolvedValue({
      ok: true,
      data: {
        kind: "noop",
        message: "All migrations already applied.",
      },
    });
    renderWithQuery(<Migrations />);
    await waitFor(
      () => {
        expect(mockOpenWizard).toHaveBeenCalledWith("setup");
      },
      { timeout: 1500 },
    );
  });

  it("renders error phase with Retry when result is err (preserved)", async () => {
    mockMigrate.mockResolvedValue({
      ok: false,
      error: {
        code: "data.migration_failed",
        domain: "database",
        message: "Migration 007 failed: syntax error",
        retryable: true,
        userActionable: false,
        redacted: true,
      },
    });
    const { findByText, getByRole, queryByRole } = renderWithQuery(<Migrations />);
    await findByText(/Migration 007 failed/);
    expect(queryByRole("button", { name: /Retry/ })).toBeTruthy();
    expect(queryByRole("button", { name: /Continue/ })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Open logs folder" }));
    expect(mockOpenLogsFolder).toHaveBeenCalledTimes(1);
  });

  it("renders live progress from the bus (preserved)", async () => {
    mockMigrate.mockImplementation(() => new Promise(() => {}));
    const { findByText } = renderWithQuery(<Migrations />);

    await waitFor(() => {
      expect(progressCb).not.toBeNull();
    });

    progressCb?.({
      phase: "planned",
      index: 0,
      total: 5,
      version: 0,
      file: "",
      ts: 1,
    });
    await findByText(/Planning 5 migrations/);

    progressCb?.({
      phase: "start",
      index: 2,
      total: 5,
      version: 3,
      file: "003_x.sql",
      ts: 2,
    });
    await findByText(/Applying 3 of 5/);
    await findByText(/003_x\.sql/);
  });

  it("ErrorBody shows failedAt context when details has version + file", async () => {
    mockMigrate.mockResolvedValue({
      ok: false,
      error: {
        code: "data.migration_failed",
        domain: "database",
        message: "Migration v15 failed.",
        retryable: true,
        userActionable: false,
        redacted: true,
        details: { failedAt: { version: 15, file: "015_add_index.sql" } },
      },
    });
    const { container, findByText } = renderWithQuery(<Migrations />);
    // Wait for the failure path to land (message in SetupStatusCard detail).
    await findByText(/Migration v15 failed/);
    // failedAt block lives in a `<p>` with mixed inline children
    // (text + <span>v15</span> + <code>file</code>); RTL's default
    // text matcher splits across nodes, so we assert against the
    // section's flattened textContent instead.
    expect(container.textContent).toMatch(/Failed at migration/);
    expect(container.textContent).toMatch(/v15/);
    expect(container.textContent).toMatch(/015_add_index\.sql/);
  });

  it("ErrorBody omits failedAt context when details is missing or shape is wrong", async () => {
    mockMigrate.mockResolvedValue({
      ok: false,
      error: {
        code: "data.migration_failed",
        domain: "database",
        message: "Unknown migration failure.",
        retryable: true,
        userActionable: false,
        redacted: true,
        // No `details` field → extractFailedAt returns null.
      },
    });
    const { findByText, queryByText } = renderWithQuery(<Migrations />);
    await findByText(/Unknown migration failure/);
    expect(queryByText(/Failed at migration/)).toBeNull();
  });

  it("ErrorBody disclosure shows applied-before-failure list when progress events fired", async () => {
    let resolveMigrate: ((value: unknown) => void) | undefined;
    mockMigrate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMigrate = resolve;
        }),
    );
    const { findByText, queryByText, container } = renderWithQuery(
      <Migrations />,
    );
    await waitFor(() => {
      expect(progressCb).not.toBeNull();
    });
    // Emit two `applied` progress events; the ref-based history snapshot
    // must capture them by the time the migrate() promise rejects.
    progressCb?.({
      phase: "applied",
      index: 0,
      total: 3,
      version: 1,
      file: "001_init.sql",
      ts: 1,
    });
    progressCb?.({
      phase: "applied",
      index: 1,
      total: 3,
      version: 2,
      file: "002_indexes.sql",
      ts: 2,
    });
    resolveMigrate?.({
      ok: false,
      error: {
        code: "data.migration_failed",
        domain: "database",
        message: "Migration v3 failed.",
        retryable: true,
        userActionable: false,
        redacted: true,
      },
    });
    await findByText(/Migration v3 failed/);
    const disclosure = queryByText(/Show 2 applied before failure/);
    expect(disclosure).not.toBeNull();
    // Clicking the disclosure renders the bounded buffer contents.
    // act() wraps the state update so React flushes before we assert.
    await act(async () => {
      fireEvent.click(disclosure!);
    });
    expect(container.textContent).toMatch(/001_init\.sql/);
    expect(container.textContent).toMatch(/002_indexes\.sql/);
  });

  it("outer container carries data-vex-onboarding + data-vex-screen attributes", async () => {
    mockMigrate.mockImplementation(() => new Promise(() => {}));
    const { container } = renderWithQuery(<Migrations />);
    const root = container.querySelector('[data-vex-screen="migrations"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-vex-onboarding")).toBe("true");
  });

  it("stands on the plate with the Database step current and Vex working while it applies", async () => {
    mockMigrate.mockImplementation(() => new Promise(() => {}));
    const { container, getByRole } = renderWithQuery(<Migrations />);
    expect(container.querySelector('[data-vex-screen="migrations"] .vex-fr-side')).not.toBeNull();
    expect(
      getByRole("navigation", { name: "First run" }).querySelector('[aria-current="step"]')?.textContent,
    ).toContain("Database");
    expect(stageVexView(getStageVex())).toMatchObject({ emotion: "working", word: "Working" });
  });

  it("draws the real count as a progress line and names the migration being applied", async () => {
    mockMigrate.mockImplementation(() => new Promise(() => {}));
    const { container, findByText, getByText } = renderWithQuery(<Migrations />);
    await waitFor(() => {
      expect(progressCb).not.toBeNull();
    });
    // Before the count is known there is no bar to fill.
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    progressCb?.({ phase: "start", index: 15, total: 169, version: 19, file: "019_bug_reports.sql", ts: 1 });
    await findByText(/Applying 16 of 169/);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("16");
    expect(bar?.getAttribute("aria-valuemax")).toBe("169");
    expect(bar?.querySelector<HTMLElement>(".vex-fr-progress__fill")?.style.width).toMatch(/^9\.4/);
    expect(getByText("Migration v19 in progress")).toBeTruthy();
    expect(getByText("019_bug_reports.sql")).toBeTruthy();
    expect(getByText("Applying")).toBeTruthy();
    const row = container.querySelector('[data-migration-version="19"]');
    expect(row?.querySelector('.vex-swatch[data-s="ongoing"]')).not.toBeNull();
    // The next file lands as applied: a word and a solid fill.
    progressCb?.({ phase: "applied", index: 15, total: 169, version: 19, file: "019_bug_reports.sql", ts: 2 });
    await findByText("Migration v19 applied");
    expect(getByText("Applied")).toBeTruthy();
  });

  it("is ready once the schema is up to date, and in error when a migration failed", async () => {
    mockMigrate.mockResolvedValue({
      ok: true,
      data: { kind: "applied", applied: 2, files: ["001.sql", "002.sql"], message: "Applied 2 migrations." },
    });
    const ready = renderWithQuery(<Migrations />);
    await ready.findByText(/2 migrations applied/);
    // The stage word follows the result in its own commit: wait for it rather
    // than reading it in the same tick (it raced under the full suite's load).
    await waitFor(() => {
      expect(stageVexView(getStageVex()).word).toBe("Ready");
    });
    ready.unmount();

    mockMigrate.mockResolvedValue({
      ok: false,
      error: {
        code: "data.migration_failed",
        domain: "database",
        message: "Migration 007 failed: syntax error",
        retryable: true,
        userActionable: false,
        redacted: true,
      },
    });
    const failed = renderWithQuery(<Migrations />);
    await failed.findByText(/Migration 007 failed/);
    await waitFor(() => {
      expect(stageVexView(getStageVex()).word).toBe("Error");
    });
    // A failure is the ink callout, an alert.
    expect(failed.getByRole("alert").getAttribute("data-vex-callout")).toBe("error");
  });
});
