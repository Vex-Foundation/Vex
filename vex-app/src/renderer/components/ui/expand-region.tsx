/**
 * EXPAND REGION - the app's single smooth open/close reveal (owner motion law,
 * round 3 item 9). Every in-flow disclosure body goes through this component so
 * one curve, one duration and one accessibility contract cover the whole app.
 *
 * The height animation itself is pure build-time CSS (`.vex-expand` in
 * `motion-primitives.css`, `interpolate-size: allow-keywords` with a 0 <-> auto
 * height pair). This file writes no styles and measures nothing: React toggles
 * `data-open`, `aria-hidden` and `inert`, and the stylesheet does the rest.
 * MOTION-POLICY-safe by construction - no `<style>` injection, no Motion
 * `layout`, no inline style attribute.
 *
 * MOUNTED WHILE CLOSING. `{open ? children : null}` cannot animate closed - the
 * content is gone before the first frame. So once a region has been opened its
 * children stay mounted for the rest of its life, and only `data-open` flips.
 *
 * LAZY FIRST MOUNT. Children are not rendered until the region is first opened.
 * A transcript can hold hundreds of collapsed reasoning traces and tool bodies;
 * mounting all of them eagerly to buy a closing animation nobody has asked for
 * would be a real cost for no gain. The first open still animates: the outer box
 * mounts closed, so the commit that adds the children also moves the computed
 * height off 0 and the transition runs.
 *
 * CLOSED CONTENT IS INERT. A closed region is `aria-hidden` and `inert`, so it
 * leaves the accessibility tree and the tab order even though it is still in the
 * DOM. Because a browser blurs whatever is focused inside a subtree that turns
 * inert, the region hands focus back to its trigger before closing - otherwise
 * focus would land on `<body>` and the reader would lose their place.
 *
 * TRIGGER CONTRACT. The trigger keeps `aria-expanded` and points
 * `aria-controls` at this region's `id`; both are the caller's to write, since
 * the trigger is the caller's element.
 */

import {
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "../../lib/utils.js";

export interface ExpandRegionProps {
  /** The `aria-controls` target of the trigger. */
  readonly id: string;
  readonly open: boolean;
  /**
   * The trigger that owns this region. Focus is returned to it before the
   * region closes, so it is not lost inside the subtree going inert.
   */
  readonly triggerRef?: RefObject<HTMLElement | null>;
  /** Classes for the INNER content box - all padding, border and margin. */
  readonly className?: string;
  /** Classes for the animated outer box. Must add no vertical box chrome. */
  readonly outerClassName?: string;
  readonly children?: ReactNode;
}

export function ExpandRegion({
  id,
  open,
  triggerRef,
  className,
  outerClassName,
  children,
}: ExpandRegionProps): JSX.Element {
  const [everOpened, setEverOpened] = useState(open);
  const outerRef = useRef<HTMLDivElement>(null);
  if (open && !everOpened) setEverOpened(true);

  // Runs before paint on the commit that closes the region, which is also the
  // commit that sets `inert`. Only pulls focus when it actually sits inside -
  // a close triggered from elsewhere on the page must not steal it.
  useLayoutEffect(() => {
    if (open) return;
    const outer = outerRef.current;
    const trigger = triggerRef?.current ?? null;
    if (outer === null || trigger === null) return;
    if (!outer.contains(document.activeElement)) return;
    trigger.focus();
  }, [open, triggerRef]);

  return (
    <div
      ref={outerRef}
      id={id}
      className={cn("vex-expand", outerClassName)}
      data-open={open ? "true" : "false"}
      aria-hidden={open ? undefined : true}
      inert={!open}
    >
      {everOpened ? <div className={className}>{children}</div> : null}
    </div>
  );
}
