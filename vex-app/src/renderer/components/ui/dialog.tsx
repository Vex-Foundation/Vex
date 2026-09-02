/**
 * Custom Dialog primitive (M12) — native `<dialog>` element + Tailwind.
 *
 * vex-app deliberately avoids Radix Dialog: the Portal-based primitive
 * needs a CSP audit before adoption (see `MOTION-POLICY.md`), and shipping
 * the shell with one custom 200-line module is cheaper than expanding the
 * Radix surface area.
 *
 * Browser semantics we lean on:
 *   - `dialog.showModal()` traps focus, opens the top-layer, and exposes
 *     the native ESC-to-close intent. We intercept the `cancel` event so
 *     callers receive a single source-of-truth `onOpenChange(false)`.
 *   - Top-layer rendering means we don't need `position: fixed` + z-index
 *     gymnastics; the dialog stays above every painted layer.
 *   - When the dialog closes we restore focus to whatever was focused
 *     before opening (the trigger).
 *
 * CSP: NO inline `style` attributes anywhere. Every effect is Tailwind
 * + classes from `globals.css`. Backdrop styling (mask + blur) rides on the
 * native `::backdrop` pseudo-element via the `.vex-dialog` rules in
 * `global-css/ui-primitives.css`, so we don't need a separate sibling div.
 *
 * Sub-components mirror shadcn naming so application code reads the
 * same as the rest of the project (`<DialogContent>`, `<DialogHeader>`,
 * `<DialogTitle>`, etc.). They are pure Tailwind wrappers — no Radix
 * Slot or asChild composition.
 */

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type JSX,
  type ReactEventHandler,
  type ReactNode,
} from "react";
import { IconWarning } from "../icons/index.js";
import { cn } from "../../lib/utils.js";

interface DialogContextValue {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly titleId: string;
  readonly descriptionId: string;
}

const DialogContext = createContext<DialogContextValue | null>(null);

function useDialogContext(component: string): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (ctx === null) {
    throw new Error(`<${component}> must be used inside <Dialog>.`);
  }
  return ctx;
}

export interface DialogProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly children: ReactNode;
}

/**
 * Controlled Dialog root. Owns the `<DialogContext>` so descendants
 * (DialogContent, DialogClose) can read open state and invoke close
 * intent without prop drilling.
 *
 * Renders nothing on its own — descendant `<DialogContent>` paints the
 * actual native `<dialog>` element.
 */
export function Dialog({ open, onOpenChange, children }: DialogProps): JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const value: DialogContextValue = {
    open,
    onOpenChange,
    titleId,
    descriptionId,
  };
  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
}

/**
 * How wide the dialog box is allowed to get.
 *
 * ADDITIVE. `default` is the 380px prompt column every existing consumer
 * renders and its classes are unchanged. `board` is the Token Radar surface:
 * nine tenths of the viewport, capped at 1280px, with the same 85vh height
 * bound so the body stays the single scroll region.
 */
export type DialogSize = "default" | "board";

const DIALOG_WIDTH_CLASS: Readonly<Record<DialogSize, string>> = {
  default: "w-full max-w-[380px]",
  board: "w-[90vw] max-w-[1280px]",
};

/**
 * NAME THE ELEMENT THAT TAKES FOCUS WHEN THIS DIALOG OPENS.
 *
 * Spread onto the ONE element the dialog wants focused:
 *
 * ```tsx
 * <Button variant="ghost" onClick={onClose} {...DIALOG_INITIAL_FOCUS}>Cancel</Button>
 * ```
 *
 * ## Why an attribute and not React's `autoFocus`
 *
 * Measured in a real browser, not assumed: React does NOT render the
 * `autoFocus` prop as the `autofocus` CONTENT attribute - it strips the prop
 * and calls `.focus()` imperatively during the commit. `DialogContent` then
 * calls `showModal()` from its own effect, and a parent's effect runs AFTER
 * its children's, so the native dialog focusing steps ran LAST and moved focus
 * to the first focusable descendant. That is how `ProjectDeleteDialog` opened
 * on the typed confirmation field that ARMS the delete, and the keep-alive
 * dialog on a project's `Close` button, while both files said `autoFocus` on
 * Cancel and every `document.activeElement` assertion passed.
 *
 * `autofocus` is the attribute the platform's own focusing steps read, so it
 * means the same thing to the browser, to the jsdom polyfill, and to
 * `DialogContent` below. It is a content attribute, so a test can assert it
 * without a live focus manager.
 */
export const DIALOG_INITIAL_FOCUS: { readonly autofocus?: string } = {
  autofocus: "",
};

/**
 * Which element `DialogContent` focuses after `showModal()`.
 *
 * The element the dialog NAMED, and otherwise the dialog itself - never the
 * first focusable descendant, which is what the platform default does and what
 * put focus on a delete-arming field.
 *
 * Focusing the dialog element arms nothing, lets the accessible name and
 * description be announced, and leaves the first control one Tab away. The
 * alternative default considered and REJECTED was "the first control in the
 * footer" (the cancel seat in most of this app's dialogs): `PlanDisplayModal`
 * renders `Accept plan` first in its footer, so that rule would hand default
 * focus to a state-changing action in exactly the kind of dialog rule 08 is
 * about.
 *
 * A named element that is disabled cannot take focus, so the dialog does.
 */
function resolveDialogInitialFocus(dialog: HTMLDialogElement): HTMLElement {
  const named = dialog.querySelector<HTMLElement>("[autofocus]");
  if (
    named !== null &&
    !named.hasAttribute("disabled") &&
    named.getAttribute("aria-disabled") !== "true"
  ) {
    return named;
  }
  return dialog;
}

export interface DialogContentProps extends HTMLAttributes<HTMLDialogElement> {
  /** Width family; omitted means the 380px prompt column. */
  readonly size?: DialogSize;
  /**
   * When true (default) the dialog closes on backdrop click. Set to
   * false for destructive prompts that require an explicit choice.
   */
  readonly closeOnBackdropClick?: boolean;
  /**
   * Native `<dialog>` cancel intent (ESC). `HTMLAttributes` does not
   * include it (React types it on `DialogHTMLAttributes` only), so it is
   * declared here to match the wired implementation. Runs before the
   * component routes the close through `onOpenChange(false)`.
   */
  readonly onCancel?: ReactEventHandler<HTMLDialogElement>;
}

/**
 * Native `<dialog>` element wrapper. Owns:
 *  - `showModal()` / `close()` lifecycle keyed off context.open
 *  - ESC handling (the browser fires `cancel` → we route to onOpenChange)
 *  - Backdrop click handling — `mousedown` on the dialog itself (not
 *    children, courtesy of e.target === e.currentTarget check)
 *  - INITIAL FOCUS after `showModal()` (see `DIALOG_INITIAL_FOCUS` and
 *    `resolveDialogInitialFocus`): the dialog decides where focus lands, so
 *    the decision is made once here rather than by whichever control the
 *    markup happens to render first.
 *  - Focus restoration on close
 *
 * Focus trap: the native `<dialog>` element + `showModal()` already
 * provides a real focus trap (Tab cycles inside the dialog, focus can't
 * leave via Shift+Tab). We do NOT reimplement it with JS.
 */
export const DialogContent = forwardRef<HTMLDialogElement, DialogContentProps>(
  (
    {
      className,
      children,
      onClick,
      onCancel,
      closeOnBackdropClick = true,
      size = "default",
      ...rest
    },
    ref,
  ) => {
    const { open, onOpenChange, titleId, descriptionId } = useDialogContext(
      "DialogContent",
    );
    const internalRef = useRef<HTMLDialogElement | null>(null);
    const previouslyFocused = useRef<HTMLElement | null>(null);

    const assignRef = useCallback(
      (node: HTMLDialogElement | null): void => {
        internalRef.current = node;
        if (typeof ref === "function") {
          ref(node);
        } else if (ref !== null && ref !== undefined) {
          (ref as React.MutableRefObject<HTMLDialogElement | null>).current = node;
        }
      },
      [ref],
    );

    // Mount/unmount native modal state in step with the controlled prop.
    useEffect(() => {
      const node = internalRef.current;
      if (node === null) return;
      if (open && !node.open) {
        // Capture the active element so we can restore focus on close.
        const active = document.activeElement;
        previouslyFocused.current =
          active instanceof HTMLElement ? active : null;
        try {
          node.showModal();
        } catch {
          // showModal throws if already open (we just checked) or if the
          // dialog is detached. Both are programmer errors; swallow so a
          // misuse during fast unmount doesn't crash the renderer.
        }
        // AFTER showModal, always: this effect runs after the children's, and
        // the native focusing steps ran inside showModal, so this is the last
        // word on where the dialog opens. Unconditional - a re-run would only
        // happen on a fresh open, which is exactly when initial focus applies.
        resolveDialogInitialFocus(node).focus();
      } else if (!open && node.open) {
        node.close();
      }
    }, [open]);

    // Restore focus to the trigger when the dialog closes. We listen on
    // the dialog's `close` event because `showModal` may be ended by
    // native UA shortcuts (e.g. ESC) before React re-runs the open
    // effect.
    useEffect(() => {
      const node = internalRef.current;
      if (node === null) return;
      const handleClose = (): void => {
        const target = previouslyFocused.current;
        if (target !== null && document.contains(target)) {
          target.focus();
        }
        previouslyFocused.current = null;
      };
      node.addEventListener("close", handleClose);
      return () => node.removeEventListener("close", handleClose);
    }, []);

    // ESC: browser fires `cancel` on the dialog. Preventing default
    // keeps the controlled state authoritative — we send the close
    // intent through the same path as a backdrop click.
    const handleCancel = useCallback(
      (event: React.SyntheticEvent<HTMLDialogElement, Event>): void => {
        event.preventDefault();
        onCancel?.(event);
        onOpenChange(false);
      },
      [onCancel, onOpenChange],
    );

    // Backdrop click: native `<dialog>` receives a click whose target
    // is the dialog itself when the click lands on the backdrop.
    const handleClick = useCallback(
      (event: React.MouseEvent<HTMLDialogElement>): void => {
        onClick?.(event);
        if (!closeOnBackdropClick) return;
        if (event.target === event.currentTarget) {
          onOpenChange(false);
        }
      },
      [closeOnBackdropClick, onClick, onOpenChange],
    );

    return (
      <dialog
        ref={assignRef}
        // Programmatically focusable, never in the Tab order: the dialog is
        // where focus rests when the surface names no element of its own
        // (`resolveDialogInitialFocus`), and a `<dialog>` without a tabindex
        // ignores `.focus()`.
        tabIndex={-1}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={handleCancel}
        onClick={handleClick}
        className={cn(
          // Center the dialog box itself — keeps backdrop-target clicks
          // on the dialog element, not the inner content (so the
          // currentTarget check above is reliable).
          // The width family is interpolated rather than appended, so the
          // default case emits the byte-identical class string every existing
          // 380px consumer already renders.
          `fixed inset-0 m-auto max-h-[85vh] ${DIALOG_WIDTH_CLASS[size]} overflow-hidden`,
          // Tokens-v2 chrome: solid layer-2 card, the system's boldest
          // radius (24), lv3 elevation (its 1px layer draws the edge on
          // dark). The backdrop mask + blur ride the .vex-dialog class in
          // ui-primitives.css (native ::backdrop pseudo-element).
          "vex-dialog rounded-[24px] border border-line-1 bg-surface-2 p-0 text-ink-primary shadow-lv3",
          "open:flex open:flex-col",
          className,
        )}
        {...rest}
      >
        {children}
      </dialog>
    );
  },
);
DialogContent.displayName = "DialogContent";

export const DialogHeader = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      // Asymmetric header: 22 top / 14 right (close-control seat) / 12
      // bottom / 24 left; no divider - whitespace separates.
      "flex shrink-0 flex-col gap-1.5 pt-[22px] pr-3.5 pb-3 pl-6",
      className,
    )}
    {...props}
  />
));
DialogHeader.displayName = "DialogHeader";

export const DialogTitle = forwardRef<
  HTMLHeadingElement,
  HTMLAttributes<HTMLHeadingElement>
>(({ className, id, ...props }, ref) => {
  const ctx = useDialogContext("DialogTitle");
  return (
    <h2
      ref={ref}
      id={id ?? ctx.titleId}
      // Chrome register, weight capped at 500 (the serif voice is gate-only
      // since the tokens-v2 rebrand).
      className={cn("text-[16px] font-medium leading-6", className)}
      {...props}
    />
  );
});
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = forwardRef<
  HTMLParagraphElement,
  HTMLAttributes<HTMLParagraphElement>
>(({ className, id, ...props }, ref) => {
  const ctx = useDialogContext("DialogDescription");
  return (
    <p
      ref={ref}
      id={id ?? ctx.descriptionId}
      className={cn("text-sm text-ink-secondary", className)}
      {...props}
    />
  );
});
DialogDescription.displayName = "DialogDescription";

export interface DialogHeadlessHeaderProps {
  readonly title: string;
  readonly description: string;
}

/**
 * HEADLESS HEADER - an accessible name for a dialog that paints its own.
 *
 * ADDITIVE, and it does not remove anything: a surface with a bespoke sticky
 * header (Token Radar) still owes the screen reader a real heading and a real
 * description carrying the context ids that `<dialog aria-labelledby>` and
 * `aria-describedby` point at. Rendering nothing there would leave the dialog
 * announced as "dialog" with no name at all.
 *
 * So the elements are REAL `DialogTitle` / `DialogDescription` nodes with the
 * context ids, visually hidden by `sr-only` rather than by `display:none` -
 * a hidden element cannot be an accessible name.
 */
export function DialogHeadlessHeader({
  title,
  description,
}: DialogHeadlessHeaderProps): JSX.Element {
  return (
    <div className="sr-only">
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>{description}</DialogDescription>
    </div>
  );
}

/**
 * Which register the consequence strip reads in.
 *
 * Two, and only two, because there are two kinds of consent this product asks
 * for. `warning` is for an action that ends something or moves the user's files;
 * `notice` is for one that changes files Vex itself maintains and can rewrite
 * again. Repair is the reason `notice` exists: it overwrites a file the user may
 * have edited, so it needs the strip, but dressing it in the same red as Delete
 * would leave Studio's two most consequential buttons speaking one tone for two
 * very different outcomes.
 */
export type DialogConsequenceTone = "warning" | "notice";

const CONSEQUENCE_TONE_CLASS: Readonly<Record<DialogConsequenceTone, string>> = {
  warning: "border-warning/40 bg-warning-wash text-warning-label",
  notice: "border-accent-primary/30 bg-accent-wash text-ink-primary",
};

export interface DialogConsequenceProps
  extends HTMLAttributes<HTMLDivElement> {
  /** Register. Defaults to `warning`. */
  readonly tone?: DialogConsequenceTone;
}

/**
 * THE CONSEQUENCE STRIP: what this dialog is about to do, above everything else.
 *
 * ADDITIVE - no existing consumer changes shape by this existing. It sits
 * BETWEEN `DialogHeader` and `DialogBody` as a `shrink-0` sibling, so it is
 * outside the body's `overflow-y-auto` container and is the first thing read
 * whatever the body is scrolled to.
 *
 * ## The defect it closes
 *
 * Studio's consent dialogs led with a title and a description and left the
 * consequence to be inferred from a paragraph in a scrolling form: "Delete
 * project?" over a body the user had to read to learn that the running
 * terminals would be closed, and a Full access radio card whose one sentence of
 * caution sat in the same register as the option beside it. The strip states the
 * three facts a person needs before consenting - WHAT will happen, TO WHAT
 * (folder, project, wallets), and WHETHER IT CAN BE UNDONE - in the dialog's own
 * chrome, where nothing can scroll it away from the button that performs it.
 *
 * The strip is a statement, not a control, EXCEPT where the consequence is a
 * GRANT: an acknowledgement checkbox rendered as its child binds the consent to
 * the exact proposal on screen (rule 09 - approval binds to the exact action and
 * parameters). The primitive owns the register and the layout; the words and the
 * acknowledgement belong to the surface, which is where their copy lives.
 *
 * The glyph is `aria-hidden`: the strip's text carries the whole meaning, and a
 * screen reader that also announced "warning" would be reading the decoration.
 */
export const DialogConsequence = forwardRef<
  HTMLDivElement,
  DialogConsequenceProps
>(({ className, tone = "warning", children, ...props }, ref) => (
  <div
    ref={ref}
    data-vex-dialog-consequence={tone}
    className={cn(
      "flex shrink-0 items-start gap-2 border-y px-6 py-3 text-xs leading-5",
      CONSEQUENCE_TONE_CLASS[tone],
      className,
    )}
    {...props}
  >
    <IconWarning size={14} className="mt-0.5 shrink-0" />
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
  </div>
));
DialogConsequence.displayName = "DialogConsequence";

export const DialogBody = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    // THE scroll region of a dialog. Named in the DOM so a test can assert
    // that what must stay visible is NOT inside it.
    data-vex-dialog-body=""
    className={cn(
      // 24px side padding keeps the 332px content column at max-w 380.
      "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5",
      className,
    )}
    {...props}
  />
));
DialogBody.displayName = "DialogBody";

/**
 * THE PINNED SLOT: what the user must see whatever the body is scrolled to.
 *
 * ADDITIVE - no existing consumer changes shape by this existing. It sits
 * BETWEEN `DialogBody` and `DialogFooter` as a `shrink-0` sibling, so it is
 * outside the body's `overflow-y-auto` container and cannot be scrolled off.
 *
 * ## The defect it closes
 *
 * A submit error and a render report were mounted as the LAST children of
 * `DialogBody`. The dialog is capped at 85vh, the body is the one scroll
 * region, and the footer holding the submit button is sticky - so on a form
 * taller than the viewport the answer to "why did nothing happen when I pressed
 * Create" was painted below the fold, under a button that had not moved.
 * Nothing scrolled to it and nothing announced it. A toast cannot serve either:
 * `showModal()` puts the dialog in the top layer, above every painted z-index,
 * so a toast raised while a modal is open is behind it.
 *
 * ## It owns its own bound
 *
 * A render report over a project with many artifacts is genuinely long. Letting
 * it grow would push the footer off the bottom of the dialog, which is the same
 * defect with the roles swapped, so the slot scrolls INTERNALLY at a fraction
 * of the viewport and the footer keeps its seat. Nothing is hidden: the content
 * is complete and reachable by scrolling inside the slot.
 *
 * Render it CONDITIONALLY - an empty slot would paint its divider over nothing.
 */
export const DialogPinnedSlot = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-vex-dialog-pinned=""
    className={cn(
      "flex max-h-[38vh] shrink-0 flex-col gap-4 overflow-y-auto overscroll-contain border-t border-line-2 px-6 pt-4",
      className,
    )}
    {...props}
  />
));
DialogPinnedSlot.displayName = "DialogPinnedSlot";

export const DialogFooter = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex shrink-0 flex-row justify-end gap-2 px-6 pt-3 pb-6",
      className,
    )}
    {...props}
  />
));
DialogFooter.displayName = "DialogFooter";

/**
 * Trigger-friendly close button. Routes through context so the user
 * stays on the controlled `onOpenChange` path.
 */
export const DialogClose = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, onClick, type = "button", ...props }, ref) => {
  const { onOpenChange } = useDialogContext("DialogClose");
  return (
    <button
      ref={ref}
      type={type}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onOpenChange(false);
      }}
      className={cn(className)}
      {...props}
    />
  );
});
DialogClose.displayName = "DialogClose";
