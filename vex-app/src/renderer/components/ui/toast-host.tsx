/**
 * ToastHost: the app's one transient-surface mount.
 *
 * It renders three things and owns one signal:
 *
 *  - the MODEL's toast stack (`NotificationToastStack`). The model's single
 *    aria owner is mounted by `ShellStatusStrip` instead: a live region is a
 *    permanent, always-present node, and parking one inside a host that other
 *    surfaces query for `role="alert"` would make every such query ambiguous;
 *  - the pre-model transient slot and sticky slot from `lib/toast.ts`, kept
 *    working unchanged for their existing call sites (B2.2 migrates them to
 *    `notify`, and both slots plus the offset below go with them);
 *  - the MODAL TOP-LAYER signal the model needs, because only a DOM mount can
 *    observe it.
 *
 * The legacy transient banner and the model stack share the top-center anchor,
 * so while the legacy one is on screen the stack renders below it rather than
 * over it. One attribute, one rule in `overlays.css`, removed with B2.2.
 */

import { useCallback, useEffect, useSyncExternalStore, type JSX } from "react";
import { Toast } from "./toast.js";
import { StickyToast } from "./sticky-toast.js";
import { NotificationToastStack } from "./notification-toast.js";
import { notifications } from "../../lib/notifications/index.js";
import {
  clearToast,
  getStickyToastSnapshot,
  getToastSnapshot,
  subscribeStickyToast,
  subscribeToast,
} from "../../lib/toast.js";

/**
 * Tell the model when a native dialog holds the top layer.
 *
 * `showModal()` sets the `open` attribute and makes the rest of the document
 * inert, so a fixed toast painted then is under the dialog: unreadable and
 * undismissable. One MutationObserver for the window, disposed on unmount,
 * watching exactly the attribute that changes. ANY open `<dialog>` counts:
 * every dialog in this app is modal, and treating a non-modal one as top layer
 * would only defer a toast to the center, which is the safe direction.
 */
function useModalTopLayerSignal(): void {
  useEffect(() => {
    const update = (): void => {
      notifications.setModalOpen(document.querySelector("dialog[open]") !== null);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => {
      observer.disconnect();
      notifications.setModalOpen(false);
    };
  }, []);
}

export function ToastHost(): JSX.Element {
  useModalTopLayerSignal();
  const toast = useSyncExternalStore(subscribeToast, getToastSnapshot);
  const sticky = useSyncExternalStore(
    subscribeStickyToast,
    getStickyToastSnapshot,
  );
  const id = toast?.id;
  const onDone = useCallback(() => {
    if (id !== undefined) clearToast(id);
  }, [id]);
  return (
    <>
      {toast !== null ? (
        <Toast key={toast.id} text={toast.text} tone={toast.tone} onDone={onDone} />
      ) : null}
      {sticky !== null ? <StickyToast key={sticky.id} entry={sticky} /> : null}
      <NotificationToastStack legacyToastVisible={toast !== null} />
    </>
  );
}
