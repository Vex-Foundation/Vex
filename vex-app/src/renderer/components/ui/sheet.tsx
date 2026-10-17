/**
 * Sheet: a surface over the centre column with both sidebars standing
 * (docs/design/R3-MINIMAL.md section 12). The mission contract and other
 * long forms open here instead of in a dimmed modal.
 *
 * It IS the native modal `<dialog>` (`DialogContent` with `size="sheet"` and
 * no scrim), so every dialog rule holds unchanged: `showModal()` traps focus,
 * the dialog names where focus lands (`DIALOG_INITIAL_FOCUS`), Escape routes
 * through `onOpenChange(false)`, focus returns to the trigger on close. What
 * differs is the placement: the sheet covers the box of one element, its
 * `anchor` (by default the element the sheet is mounted in), and follows that
 * box while open. Mount it in the column body under the title bar and it
 * runs from under the head to the foot of the column.
 *
 * Parts, values from the spec: a 56px head (title 16 / 500) with a quiet rule
 * below, a body padded 0 28 that is the one scroll region, a 68px foot with a
 * quiet rule above.
 *
 *   <Sheet open={open} onOpenChange={setOpen}>
 *     <SheetContent>
 *       <SheetHeader><SheetTitle>Mission contract</SheetTitle></SheetHeader>
 *       <SheetBody>...</SheetBody>
 *       <SheetFooter>...</SheetFooter>
 *     </SheetContent>
 *   </Sheet>
 */

import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type JSX,
} from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogTitle,
  type DialogContentProps,
  type DialogProps,
} from "./dialog.js";
import { cn } from "../../lib/utils.js";

/** The sheet's root: the controlled dialog root under another name. */
export function Sheet(props: DialogProps): JSX.Element {
  return <Dialog {...props} />;
}

export interface SheetContentProps
  extends Omit<DialogContentProps, "size" | "backdrop"> {
  /**
   * The element whose box the sheet covers. Omitted: the element the sheet
   * is mounted in.
   */
  readonly anchor?: () => Element | null;
}

/**
 * Pin a fixed box to another element's box: once on mount, then on every
 * window resize and every size change of the anchor. CSSOM property writes
 * only (CSP-safe, MOTION-POLICY.md).
 */
function usePinnedBox(
  nodeRef: { readonly current: HTMLElement | null },
  anchor: (() => Element | null) | undefined,
): void {
  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (node === null) return undefined;
    const target = anchor?.() ?? node.parentElement;
    if (target === null) return undefined;
    const pin = (): void => {
      const box = target.getBoundingClientRect();
      node.style.top = `${box.top}px`;
      node.style.left = `${box.left}px`;
      node.style.width = `${box.width}px`;
      node.style.height = `${box.height}px`;
    };
    pin();
    window.addEventListener("resize", pin);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(pin);
    observer?.observe(target);
    return () => {
      window.removeEventListener("resize", pin);
      observer?.disconnect();
    };
  }, [nodeRef, anchor]);
}

export const SheetContent = forwardRef<HTMLDialogElement, SheetContentProps>(
  ({ anchor, closeOnBackdropClick = false, className, ...rest }, ref) => {
    const localRef = useRef<HTMLDialogElement | null>(null);
    const assignRef = useCallback(
      (node: HTMLDialogElement | null): void => {
        localRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref !== null) ref.current = node;
      },
      [ref],
    );
    usePinnedBox(localRef, anchor);
    return (
      <DialogContent
        ref={assignRef}
        size="sheet"
        backdrop="none"
        // The sidebars stay in view but inert; a press on them is not a
        // decision about the sheet. Escape and the sheet's own keys close it.
        closeOnBackdropClick={closeOnBackdropClick}
        className={className}
        {...rest}
      />
    );
  },
);
SheetContent.displayName = "SheetContent";

export const SheetHeader = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex h-14 shrink-0 items-center gap-3 border-b border-rule-quiet px-7",
      className,
    )}
    {...props}
  />
));
SheetHeader.displayName = "SheetHeader";

export const SheetTitle = forwardRef<
  HTMLHeadingElement,
  HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <DialogTitle
    ref={ref}
    className={cn("text-[16px] leading-6 tracking-normal", className)}
    {...props}
  />
));
SheetTitle.displayName = "SheetTitle";

export const SheetBody = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <DialogBody ref={ref} className={cn("px-7 py-0", className)} {...props} />
));
SheetBody.displayName = "SheetBody";

export const SheetFooter = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex h-[68px] shrink-0 items-center gap-3 border-t border-rule-quiet px-7",
      className,
    )}
    {...props}
  />
));
SheetFooter.displayName = "SheetFooter";
