import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectCleanupNotices } from "../ProjectCleanupNotices.js";

afterEach(cleanup);
describe("unfinished delete notices", () => {
  it("shows a durable refusal on remount and retries the recorded folder decision", async () => {
    const item = {
      projectId: "11111111-1111-4111-8111-111111111111", name: "Example", folder: "example",
      trashRequested: true, attempts: 2, trashFailure: "busy",
    };
    let pending = true;
    const list = vi.fn(async () => ({ ok: true, data: { items: pending ? [item] : [], nextOffset: null } }));
    const retry = vi.fn(async () => { pending = false; return { ok: true, data: { outcome: "already_removed" } }; });
    Object.defineProperty(window, "vex", { configurable: true, value: { projects: { pendingCleanups: list, delete: retry } } });
    const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <ProjectCleanupNotices />
    </QueryClientProvider>);
    const first = mount();
    await screen.findByText(/The folder is in use/);
    expect(retry).not.toHaveBeenCalled();
    first.unmount();
    mount();
    const button = await screen.findByRole("button", { name: "Retry cleanup for Example" });
    fireEvent.click(button);
    await waitFor(() => expect(retry).toHaveBeenCalledWith({
      projectId: item.projectId, expectedName: item.name, alsoTrashFolder: true,
    }));
    await waitFor(() => expect(screen.queryByText(/The folder is in use/)).toBeNull());
  });

  it("does not present a failed obligation read as an empty success", async () => {
    Object.defineProperty(window, "vex", { configurable: true, value: { projects: {
      pendingCleanups: async () => ({ ok: false, error: { message: "No database" } }),
    } } });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <ProjectCleanupNotices />
    </QueryClientProvider>);
    await screen.findByText("Unfinished project cleanups could not be loaded.");
    expect(screen.getByRole("button", { name: "Retry loading cleanups" })).toBeDefined();
  });
});
