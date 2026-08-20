/**
 * ToastHost: mounts once near the app root and renders both toast slots -
 * the transient top-center toast (keyed by the per-show id so re-showing
 * restarts the CSS cycle) and the persistent bottom-right sticky toast
 * (keyed by its caller-chosen id so in-place updates never replay the
 * entrance). The two occupy opposite anchors and can coexist.
 */

import { useCallback, useSyncExternalStore, type JSX } from "react";
import { Toast } from "./toast.js";
import { StickyToast } from "./sticky-toast.js";
import {
  clearToast,
  getStickyToastSnapshot,
  getToastSnapshot,
  subscribeStickyToast,
  subscribeToast,
} from "../../lib/toast.js";

export function ToastHost(): JSX.Element | null {
  const toast = useSyncExternalStore(subscribeToast, getToastSnapshot);
  const sticky = useSyncExternalStore(
    subscribeStickyToast,
    getStickyToastSnapshot,
  );
  const id = toast?.id;
  const onDone = useCallback(() => {
    if (id !== undefined) clearToast(id);
  }, [id]);
  if (toast === null && sticky === null) return null;
  return (
    <>
      {toast !== null ? (
        <Toast key={toast.id} text={toast.text} tone={toast.tone} onDone={onDone} />
      ) : null}
      {sticky !== null ? <StickyToast key={sticky.id} entry={sticky} /> : null}
    </>
  );
}
