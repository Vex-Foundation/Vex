import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { LOCK_BUTTON } from "@shared/lock-button.js";
import { useUiStore } from "../../stores/uiStore.js";
import { showToast } from "../../lib/toast.js";

interface LockControl {
  readonly pending: boolean;
  readonly requestLock: () => void;
}
const LockContext = createContext<LockControl>({ pending: false, requestLock: () => undefined });

export function useLockVexControl(): LockControl {
  return useContext(LockContext);
}

/** One request owner across profile controls, native menu and runtime-mode changes. */
export function LockVexControl({ children }: { readonly children: ReactNode }): ReactNode {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const requestLock = useCallback((): void => {
    if (!LOCK_BUTTON || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    void (async () => {
      try {
        const result = await window.vex.secrets.lock();
        if (result.ok) {
          useUiStore.getState().openUnlock("appShell");
        } else {
          showToast(result.error.message, { tone: result.error.code === "secrets.lock_busy" ? "warning" : "error" });
        }
      } catch {
        showToast("Vex could not lock. Try again.", { tone: "error" });
      } finally {
        inFlight.current = false;
        if (mounted.current) setPending(false);
      }
    })();
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!LOCK_BUTTON) return () => { mounted.current = false; };
    const unsubscribe = window.vex?.secrets?.onLockRequested?.(requestLock);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || event.altKey || !event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "l") return;
      event.preventDefault();
      requestLock();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      mounted.current = false;
      unsubscribe?.();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [requestLock]);

  return <LockContext.Provider value={{ pending, requestLock }}>{children}</LockContext.Provider>;
}
