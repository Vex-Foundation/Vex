import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretsBridge } from "@shared/types/bridge/shell/secrets.js";
import { err, ok } from "@shared/ipc/result.js";
import { useUiStore } from "../../../stores/uiStore.js";

const feature = vi.hoisted(() => ({ enabled: true }));
vi.mock("@shared/lock-button.js", () => ({ get LOCK_BUTTON() { return feature.enabled; } }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/toast.js", () => ({ showToast: toast }));
import { LockVexControl, useLockVexControl } from "../LockVexControl.js";

const lock = vi.fn<SecretsBridge["lock"]>();
const unsubscribe = vi.fn();
let menuRequest: () => void = () => undefined;
const subscribe = vi.fn((callback: () => void) => { menuRequest = callback; return unsubscribe; });

function Trigger() {
  const control = useLockVexControl();
  return <button disabled={control.pending} onClick={control.requestLock}>{control.pending ? "Locking" : "Lock now"}</button>;
}
function renderControl() {
  return render(<LockVexControl><Trigger /></LockVexControl>);
}

beforeEach(() => {
  feature.enabled = true;
  toast.mockReset();
  lock.mockReset();
  subscribe.mockClear();
  unsubscribe.mockClear();
  menuRequest = () => undefined;
  Object.defineProperty(window, "vex", { configurable: true, value: { secrets: { lock, onLockRequested: subscribe } } });
  useUiStore.setState({ currentView: "appShell", unlockReturnView: "appShell" });
});

describe("Lock Vex request owner", () => {
  it("deduplicates click, menu and shortcut while pending, then opens the existing unlock screen", async () => {
    let finish: (value: Awaited<ReturnType<SecretsBridge["lock"]>>) => void = () => undefined;
    lock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderControl();
    fireEvent.click(screen.getByText("Lock now"));
    act(menuRequest);
    fireEvent.keyDown(window, { key: "L", ctrlKey: true, shiftKey: true });
    expect(lock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button").getAttribute("disabled")).not.toBeNull();
    expect(useUiStore.getState().currentView).toBe("appShell");
    await act(async () => { finish(ok({ locked: true })); });
    expect(useUiStore.getState().currentView).toBe("unlock");
    expect(useUiStore.getState().unlockReturnView).toBe("appShell");
  });

  it("keeps the shell open on busy and allows a fresh retry", async () => {
    lock.mockResolvedValueOnce(err({ code: "secrets.lock_busy", domain: "wallet", message: "Wait for the transaction, then lock Vex.", retryable: true, userActionable: true, redacted: true, correlationId: "test" }));
    lock.mockResolvedValueOnce(ok({ locked: true }));
    renderControl();
    fireEvent.click(screen.getByText("Lock now"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Wait for the transaction, then lock Vex.", { tone: "warning" }));
    expect(useUiStore.getState().currentView).toBe("appShell");
    fireEvent.click(screen.getByText("Lock now"));
    await waitFor(() => expect(useUiStore.getState().currentView).toBe("unlock"));
    expect(lock).toHaveBeenCalledTimes(2);
  });

  it("uses bounded fallback copy on transport failure and cleans up subscriptions", async () => {
    lock.mockRejectedValue(new Error("private transport details"));
    const view = renderControl();
    act(menuRequest);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Vex could not lock. Try again.", { tone: "error" }));
    expect(useUiStore.getState().currentView).toBe("appShell");
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "L", ctrlKey: true, shiftKey: true });
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it("ignores repeated and ordinary keys and handles the password-lock shortcut", async () => {
    lock.mockResolvedValue(ok({ locked: true }));
    renderControl();
    fireEvent.keyDown(window, { key: "L", shiftKey: true });
    fireEvent.keyDown(window, { key: "L", metaKey: true, shiftKey: true, repeat: true });
    expect(lock).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "l", metaKey: true, shiftKey: true });
    await waitFor(() => expect(lock).toHaveBeenCalledTimes(1));
  });

  it("does not subscribe, invoke or handle the shortcut when the feature is off", () => {
    feature.enabled = false;
    renderControl();
    fireEvent.click(screen.getByText("Lock now"));
    fireEvent.keyDown(window, { key: "L", ctrlKey: true, shiftKey: true });
    expect(subscribe).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
  });
});
