/**
 * ImageLightbox: document-level original-image preview opened by clicking a
 * thumbnail. Closes on Escape, backdrop press, or the close control, and
 * restores focus to the opener on unmount. Body-portaled: an opener inside
 * a transformed/filtered ancestor would otherwise trap the fixed backdrop.
 * Copy (dialog/close labels) arrives via props.
 */

import { useEffect, useRef, type ReactPortal } from "react";
import { createPortal } from "react-dom";
import { IconClose } from "../icons/index.js";

export interface ImageLightboxLabels {
  /** Accessible name of the preview dialog. */
  readonly dialog: string;
  /** Accessible label of the close control. */
  readonly close: string;
}

export function ImageLightbox({ src, alt, labels, onClose }: {
  readonly src: string;
  readonly alt: string;
  readonly labels: ImageLightboxLabels;
  readonly onClose: () => void;
}): ReactPortal {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      restoreRef.current?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="vex-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={labels.dialog}
    >
      <div className="vex-lightbox-mask" aria-hidden="true" onMouseDown={onClose} />
      <img className="vex-lightbox-image" src={src} alt={alt} />
      <button
        ref={closeRef}
        type="button"
        className="vex-lightbox-close"
        aria-label={labels.close}
        onClick={onClose}
      >
        <IconClose size={16} />
      </button>
    </div>,
    document.body,
  );
}
