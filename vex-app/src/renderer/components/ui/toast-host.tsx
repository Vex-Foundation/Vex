/**
 * ToastHost: mounts once near the app root and renders the store's current
 * toast. Keyed by the per-show id so re-showing restarts the CSS cycle.
 */

import { useCallback, useSyncExternalStore, type JSX } from "react";
import { Toast } from "./toast.js";
import {
  clearToast,
  getToastSnapshot,
  subscribeToast,
} from "../../lib/toast.js";

export function ToastHost(): JSX.Element | null {
  const toast = useSyncExternalStore(subscribeToast, getToastSnapshot);
  const id = toast?.id;
  const onDone = useCallback(() => {
    if (id !== undefined) clearToast(id);
  }, [id]);
  if (toast === null) return null;
  return <Toast key={toast.id} text={toast.text} tone={toast.tone} onDone={onDone} />;
}
