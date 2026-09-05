/**
 * ToastHost: the app's one floating-notification mount.
 *
 * It renders the model's toast stack and owns one signal the model cannot
 * observe for itself. Since B2.2 there is nothing else here: the pre-model
 * transient slot and the bottom-right sticky slot were migrated onto the
 * model, so this host mounts one region instead of three.
 *
 * The model's single aria owner is mounted by `ShellStatusStrip` instead: a
 * live region is a permanent, always-present node, and parking one inside a
 * host that other surfaces query for `role="alert"` would make every such
 * query ambiguous.
 */

import { useEffect, type JSX } from "react";
import { NotificationToastStack } from "./notification-toast.js";
import { notifications } from "../../lib/notifications/index.js";

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
  return <NotificationToastStack />;
}
