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
    const retry = vi.fn(async (_input: unknown) => { pending = false; return { ok: true, data: { outcome: "already_removed" } }; });
    Object.defineProperty(window, "vex", { configurable: true, value: { projects: { pendingCleanups: list, deleteAbortable: (input: unknown) => ({ promise: retry(input), cancel: vi.fn() }) } } });
    const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <ProjectCleanupNotices />
    </QueryClientProvider>);
    const first = mount();
    const disclosure = await screen.findByRole("button", { name: /Example.*Pending cleanup/ });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/Another program is using/)).toBeNull();
    fireEvent.keyDown(disclosure, { key: "Enter" });
    await screen.findByText(/Another program is using/);
    expect(retry).not.toHaveBeenCalled();
    first.unmount();
    mount();
    fireEvent.keyDown(await screen.findByRole("button", { name: /Example.*Pending cleanup/ }), { key: " " });
    const button = await screen.findByRole("button", { name: "Retry cleanup for Example" });
    fireEvent.click(button);
    await waitFor(() => expect(retry).toHaveBeenCalledWith({
      projectId: item.projectId, expectedName: item.name, alsoTrashFolder: true,
    }));
    await waitFor(() => expect(screen.queryByText(/Another program is using/)).toBeNull());
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

it("names the own orphan, sends only project intent, and exposes cancellation", async () => {
  const cancel = vi.fn();
  let finish: (value: unknown) => void = () => {};
  const retry = vi.fn(() => ({ promise: new Promise((resolve) => { finish = resolve; }), cancel }));
  const item = { projectId: "11111111-1111-4111-8111-111111111111", name: "Trading", folder: "trading",
    trashRequested: true, attempts: 5, trashFailure: { reason: "busy", folder: "C:\\projects\\trading",
      holders: [{ kind: "vex_orphaned_terminal", pid: 6484 }] } };
  Object.defineProperty(window, "vex", { configurable: true, value: { projects: {
    pendingCleanups: async () => ({ ok: true, data: { items: [item], nextOffset: null } }), deleteAbortable: retry,
  } } });
  const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
    <ProjectCleanupNotices />
  </QueryClientProvider>);
  const row = await screen.findByRole("button", { name: /Trading.*Pending cleanup/ });
  row.focus();
  fireEvent.keyDown(row, { key: "Enter" });
  expect(screen.getByText(/A Vex terminal from a previous session/)).toBeDefined();
  expect(screen.getByText("PID 6484")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Close it and retry" }));
  await waitFor(() => expect(retry).toHaveBeenCalledWith({
    projectId: item.projectId, expectedName: "Trading", alsoTrashFolder: true, closeHolders: true,
  }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel cleanup" }));
  expect(cancel).toHaveBeenCalledOnce();
  view.unmount();
  finish({ ok: true, data: { outcome: "already_removed" } });
});


it.each(["result", "transport"] as const)("leaves a shared %s failure to the projects error surface", async (failureKind) => {
  const failure = { ok: false, error: { message: "No database" } };
  const list = vi.fn(async () => {
    if (failureKind === "transport") throw new Error("Bridge unavailable");
    return failure;
  });
  Object.defineProperty(window, "vex", { configurable: true, value: { projects: { pendingCleanups: list } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = (projectsReadFailed: boolean) => <QueryClientProvider client={client}>
    <ProjectCleanupNotices showReadError={!projectsReadFailed} />
  </QueryClientProvider>;
  const view = render(tree(true));
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry loading cleanups" })).toBeNull();

  // The cleanup read still failed after projects recovered, so it now owns its error.
  view.rerender(tree(false));
  await screen.findByText("Unfinished project cleanups could not be loaded.");
  expect(screen.getByRole("button", { name: "Retry loading cleanups" })).toBeDefined();
  expect(list).toHaveBeenCalledOnce();
});
