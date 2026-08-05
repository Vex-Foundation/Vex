/**
 * DRAG-TO-REORDER for the BOOK rail — native HTML5 drag-and-drop, zero new
 * dependencies.
 *
 * Motion's `<Reorder>` is banned by `MOTION-POLICY.md`: `Reorder.Item` is a
 * `layout` component by construction, and `layout` is on the same Phase-1 ban
 * list under the CSP posture. A drag library for seven static cards in one
 * vertical list is not a trade the dependency rule supports either. The
 * platform already ships the whole gesture, so this file adds only the parts
 * the platform does not: validation and a keyboard path.
 *
 * DESIGN NOTES, in the order they matter:
 *  - the HANDLE carries `draggable`, not the row. Arming the row would let a
 *    text selection inside a card start a drag, and arming it asynchronously
 *    (pointerdown → setState → draggable) has cancellation edges no test can
 *    cover;
 *  - the transient drag state lives at LIST level, in the hook, so a source
 *    `dragend` clears every row's indicator in ONE write;
 *  - movement is expressed by IDENTITY (`moveSectionRelative`), never by raw
 *    index arithmetic across a mutated array;
 *  - the dropped string is validated against the known section ids before
 *    anything moves. `dataTransfer` is a page-wide channel: a file, a text
 *    selection, or any other drag source can land here, and an unknown payload
 *    must move nothing at all;
 *  - the ONLY motion added is the drop settle (the owner's "plum"): the single
 *    card that moved plays a one-shot transform-only keyframe from
 *    `globals.css`, which is the sanctioned route (MOTION-POLICY "Allowed":
 *    build-time keyframes). The STACK is not animated — cards keep the existing
 *    `cardVariants` cascade and `key={id}` keeps React's reconciliation stable,
 *    so a reorder moves DOM nodes rather than rebuilding them and the focused
 *    drag handle survives a keyboard move.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { motion } from "motion/react";
import { prefersReducedMotion } from "./portfolio/portfolio-motion.js";
import { DragHandleIcon, VexIcon } from "../../../components/icons/index.js";
import { cn } from "../../../lib/utils.js";
import {
  BOOK_SECTION_LABEL,
  isBookSectionId,
  moveSection,
  moveSectionRelative,
  type BookSectionId,
  type DropEdge,
} from "./section-order.js";

/** Must match `.vex-section-settle`'s duration in `motion-primitives.css`. */
const SECTION_SETTLE_MS = 240;

interface DragState {
  readonly draggedId: BookSectionId;
  readonly overId: BookSectionId | null;
  readonly edge: DropEdge | null;
}

export interface BookSectionReorder {
  readonly drag: DragState | null;
  /** The card that just landed, and is playing its settle. Null when none. */
  readonly settlingId: BookSectionId | null;
  /** Live-region text for the last keyboard move, or "" when there was none. */
  readonly announcement: string;
  readonly onHandleDragStart: (
    id: BookSectionId,
    event: React.DragEvent,
  ) => void;
  readonly onRowDragOver: (id: BookSectionId, event: React.DragEvent) => void;
  readonly onRowDrop: (id: BookSectionId, event: React.DragEvent) => void;
  readonly onDragEnd: () => void;
  readonly onHandleKeyDown: (
    id: BookSectionId,
    index: number,
    event: React.KeyboardEvent,
  ) => void;
}

/**
 * The list-level drag state and every mutation the rail can make to its own
 * order. `onOrderChange` receives a NEW array; it never mutates `order`.
 */
export function useBookSectionReorder(
  order: readonly BookSectionId[],
  onOrderChange: (next: readonly BookSectionId[]) => void,
): BookSectionReorder {
  const [drag, setDrag] = useState<DragState | null>(null);
  // `nonce` is what lets the SAME card settle twice in a row: the class must
  // come fully off between moves or the keyframe cannot restart on a reused
  // DOM node (and the node IS reused — `key={id}` is what keeps the focused
  // drag handle alive across a keyboard move).
  const [settle, setSettle] = useState<{
    readonly id: BookSectionId;
    readonly nonce: number;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // Sampled once per mount, matching the rail's own `prefersReducedMotion`
  // usage: the preference must not flip a settle mid-animation.
  const [reduced] = useState(prefersReducedMotion);
  // Read inside stable callbacks so a drag in flight always sees the CURRENT
  // order without re-creating every row's handlers on each reorder.
  const orderRef = useRef(order);
  orderRef.current = order;

  const applyMove = useCallback(
    (next: readonly BookSectionId[], id: BookSectionId): void => {
      const current = orderRef.current;
      if (next === current) return;
      onOrderChange(next);
      // The settle is a REACTION to a landing, so it is armed for the moved
      // card only, and identically for the pointer and keyboard paths — the
      // affordance must not depend on which one the user reached for.
      if (!reduced) {
        setSettle((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
      }
      setAnnouncement(
        `${BOOK_SECTION_LABEL[id]} moved to position ${next.indexOf(id) + 1} of ${next.length}`,
      );
    },
    [onOrderChange, reduced],
  );

  const onHandleDragStart = useCallback(
    (id: BookSectionId, event: React.DragEvent): void => {
      // The payload is a section id and nothing else — no user data ever
      // enters the drag channel.
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
      setDrag({ draggedId: id, overId: null, edge: null });
    },
    [],
  );

  const onRowDragOver = useCallback(
    (id: BookSectionId, event: React.DragEvent): void => {
      // Without preventDefault the element is not a valid drop target at all.
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const rect = event.currentTarget.getBoundingClientRect();
      const edge: DropEdge =
        event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      setDrag((prev) =>
        prev === null ? null : { ...prev, overId: id, edge },
      );
    },
    [],
  );

  const onRowDrop = useCallback(
    (id: BookSectionId, event: React.DragEvent): void => {
      event.preventDefault();
      const payload = event.dataTransfer.getData("text/plain");
      setDrag(null);
      if (!isBookSectionId(payload)) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const edge: DropEdge =
        event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      applyMove(moveSectionRelative(orderRef.current, payload, id, edge), payload);
    },
    [applyMove],
  );

  const onDragEnd = useCallback((): void => {
    setDrag(null);
  }, []);

  // One bounded timer per landing — not an `animationend` listener. That event
  // BUBBLES, so any animation inside a card would clear the settle early, and
  // it is not observable in this jsdom build, which would leave the
  // second-move re-trigger unprovable. A single timeout is cheaper than the
  // guard the event would need, and it is deterministic in both places.
  useEffect(() => {
    if (settle === null) return undefined;
    const id = window.setTimeout(() => setSettle(null), SECTION_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [settle]);

  const onHandleKeyDown = useCallback(
    (id: BookSectionId, index: number, event: React.KeyboardEvent): void => {
      const count = orderRef.current.length;
      const target =
        event.key === "ArrowUp"
          ? index - 1
          : event.key === "ArrowDown"
            ? index + 1
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? count - 1
                : null;
      if (target === null) return;
      event.preventDefault();
      if (target < 0 || target > count - 1 || target === index) return;
      applyMove(moveSection(orderRef.current, id, target), id);
    },
    [applyMove],
  );

  return useMemo(
    () => ({
      drag,
      settlingId: settle?.id ?? null,
      announcement,
      onHandleDragStart,
      onRowDragOver,
      onRowDrop,
      onDragEnd,
      onHandleKeyDown,
    }),
    [
      drag,
      settle,
      announcement,
      onHandleDragStart,
      onRowDragOver,
      onRowDrop,
      onDragEnd,
      onHandleKeyDown,
    ],
  );
}

/**
 * One rail row: the drag affordance and nothing else. `children` renders
 * untouched, so no card learns that it can be dragged.
 *
 * `motion.li` (not a plain `li`) so the stack's stagger keeps cascading through
 * to each card's `cardVariants` — variant propagation needs an unbroken chain
 * of motion components. It declares no variants of its own and no `layout`.
 */
export function ReorderableSection({
  id,
  index,
  count,
  reorder,
  children,
}: {
  readonly id: BookSectionId;
  readonly index: number;
  readonly count: number;
  readonly reorder: BookSectionReorder;
  readonly children: ReactNode;
}): JSX.Element {
  const { drag } = reorder;
  const dropEdge = drag !== null && drag.overId === id ? drag.edge : null;
  const settling = reorder.settlingId === id;

  return (
    <motion.li
      data-vex-book-section={id}
      data-vex-drop-edge={dropEdge ?? undefined}
      data-vex-section-settling={settling ? "" : undefined}
      onDragOver={(event) => reorder.onRowDragOver(id, event)}
      onDrop={(event) => reorder.onRowDrop(id, event)}
      className={cn(
        "group relative list-none",
        settling && "vex-section-settle",
        drag?.draggedId === id && "opacity-60",
        // The drop indicator is a CSS-only hairline on the row's own edge — no
        // JS positioning, no injected style.
        dropEdge === "before" &&
          "before:absolute before:inset-x-0 before:-top-1 before:h-0.5 before:rounded-full before:bg-[var(--vex-accent)]",
        dropEdge === "after" &&
          "after:absolute after:inset-x-0 after:-bottom-1 after:h-0.5 after:rounded-full after:bg-[var(--vex-accent)]",
      )}
    >
      <button
        type="button"
        draggable
        onDragStart={(event) => reorder.onHandleDragStart(id, event)}
        onDragEnd={reorder.onDragEnd}
        onKeyDown={(event) => reorder.onHandleKeyDown(id, index, event)}
        aria-label={`Reorder ${BOOK_SECTION_LABEL[id]} — position ${index + 1} of ${count}`}
        className="absolute right-2 top-2 z-10 cursor-grab rounded p-1 text-[var(--vex-text-3)] opacity-0 transition-opacity hover:text-[var(--vex-text)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] group-hover:opacity-100"
      >
        <VexIcon icon={DragHandleIcon} size={12} aria-hidden />
      </button>
      {children}
    </motion.li>
  );
}
