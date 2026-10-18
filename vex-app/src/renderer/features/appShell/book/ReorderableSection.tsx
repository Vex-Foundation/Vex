/**
 * DRAG-TO-REORDER for the Portfolio page's sections - native HTML5
 * drag-and-drop, zero new dependencies. The order persists on
 * `bookSectionOrder` (docs/design/R3-MINIMAL.md section 9.1: "Reordering stays
 * on `bookSectionOrder`").
 *
 * MECHANISM ONLY, generic over the id type. It knows no section ids: the page
 * passes its `SectionRegistry` (`section-registry.ts`), which supplies the
 * drop validator and the labels.
 *
 * Motion's `<Reorder>` is banned by `MOTION-POLICY.md`: `Reorder.Item` is a
 * `layout` component by construction, and `layout` is on the same Phase-1 ban
 * list under the CSP posture. A drag library for five static sections in one
 * list is not a trade the dependency rule supports either. The
 * platform already ships the whole gesture, so this file adds only the parts
 * the platform does not: validation and a keyboard path.
 *
 * DESIGN NOTES, in the order they matter:
 *  - the HANDLE carries `draggable`, not the row. Arming the row would let a
 *    text selection inside a section start a drag, and arming it asynchronously
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
 *  - the ONLY motion is the drop settle (the owner's "plum"): the single
 *    section that moved plays a one-shot transform-only keyframe from
 *    `motion-primitives.css`, which is the sanctioned route (MOTION-POLICY
 *    "Allowed": build-time keyframes). The list is not animated, and
 *    `key={id}` keeps React's reconciliation stable, so a reorder moves DOM
 *    nodes rather than rebuilding them and the focused drag handle survives a
 *    keyboard move.
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
import { prefersReducedMotion } from "./portfolio/portfolio-motion.js";
import { LineMenu } from "../../../components/icons/line/index.js";
import { cn } from "../../../lib/utils.js";
import {
  moveSection,
  moveSectionRelative,
  type DropEdge,
  type SectionRegistry,
} from "./section-registry.js";

/** Must match `.vex-section-settle`'s duration in `motion-primitives.css`. */
const SECTION_SETTLE_MS = 240;

interface DragState<Id extends string> {
  readonly draggedId: Id;
  readonly overId: Id | null;
  readonly edge: DropEdge | null;
}

export interface BookSectionReorder<Id extends string> {
  readonly drag: DragState<Id> | null;
  /** The section that just landed, and is playing its settle. Null when none. */
  readonly settlingId: Id | null;
  /** Live-region text for the last keyboard move, or "" when there was none. */
  readonly announcement: string;
  readonly onHandleDragStart: (id: Id, event: React.DragEvent) => void;
  readonly onRowDragOver: (id: Id, event: React.DragEvent) => void;
  readonly onRowDrop: (id: Id, event: React.DragEvent) => void;
  readonly onDragEnd: () => void;
  readonly onHandleKeyDown: (
    id: Id,
    index: number,
    event: React.KeyboardEvent,
  ) => void;
}

/**
 * The list-level drag state and every mutation the page can make to its own
 * order. `onOrderChange` receives a NEW array; it never mutates `order`.
 *
 * `registry` is the page's own id set: it supplies the drop validator and the
 * human labels. The mechanism below knows no ids of its own.
 */
export function useBookSectionReorder<Id extends string>(
  order: readonly Id[],
  onOrderChange: (next: readonly Id[]) => void,
  registry: SectionRegistry<Id>,
): BookSectionReorder<Id> {
  const [drag, setDrag] = useState<DragState<Id> | null>(null);
  // `nonce` is what lets the SAME card settle twice in a row: the class must
  // come fully off between moves or the keyframe cannot restart on a reused
  // DOM node (and the node IS reused - `key={id}` is what keeps the focused
  // drag handle alive across a keyboard move).
  const [settle, setSettle] = useState<{
    readonly id: Id;
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
  // Same reason as `orderRef`: the registry is stable in practice, but reading
  // it through a ref keeps every handler below referentially stable.
  const registryRef = useRef(registry);
  registryRef.current = registry;

  const applyMove = useCallback(
    (next: readonly Id[], id: Id): void => {
      const current = orderRef.current;
      if (next === current) return;
      onOrderChange(next);
      // The settle is a REACTION to a landing, so it is armed for the moved
      // card only, and identically for the pointer and keyboard paths - the
      // affordance must not depend on which one the user reached for.
      if (!reduced) {
        setSettle((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
      }
      setAnnouncement(
        `${registryRef.current.label[id]} moved to position ${next.indexOf(id) + 1} of ${next.length}`,
      );
    },
    [onOrderChange, reduced],
  );

  const onHandleDragStart = useCallback(
    (id: Id, event: React.DragEvent): void => {
      // The payload is a section id and nothing else - no user data ever
      // enters the drag channel.
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
      setDrag({ draggedId: id, overId: null, edge: null });
    },
    [],
  );

  const onRowDragOver = useCallback(
    (id: Id, event: React.DragEvent): void => {
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
    (id: Id, event: React.DragEvent): void => {
      event.preventDefault();
      const payload = event.dataTransfer.getData("text/plain");
      setDrag(null);
      if (!registryRef.current.isId(payload)) return;
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

  // One bounded timer per landing - not an `animationend` listener. That event
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
    (id: Id, index: number, event: React.KeyboardEvent): void => {
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
 * One section row: the drag affordance and nothing else. `children` renders
 * untouched, so no section learns that it can be dragged. The grip (the line
 * menu glyph in a 24px key) sits in the page's left margin beside the
 * section head and shows on hover or focus.
 *
 * `band` places the row in the page's two column band (Wallets beside
 * Balances, section 9.1): `start` takes the first column, `end` the second;
 * without it the row spans the page. The page decides; the row only carries
 * it as `data-vex-band` for the sheet.
 */
export function ReorderableSection<Id extends string>({
  id,
  label,
  index,
  count,
  reorder,
  band,
  children,
}: {
  readonly id: Id;
  /** The registry's human name for `id` - the row holds no id table. */
  readonly label: string;
  readonly index: number;
  readonly count: number;
  readonly reorder: BookSectionReorder<Id>;
  readonly band?: "start" | "end";
  readonly children: ReactNode;
}): JSX.Element {
  const { drag } = reorder;
  const dropEdge = drag !== null && drag.overId === id ? drag.edge : null;
  const settling = reorder.settlingId === id;

  return (
    <li
      data-vex-portfolio-section={id}
      data-vex-band={band}
      data-vex-drop-edge={dropEdge ?? undefined}
      data-vex-section-settling={settling ? "" : undefined}
      data-dragging={drag?.draggedId === id ? "" : undefined}
      onDragOver={(event) => reorder.onRowDragOver(id, event)}
      onDrop={(event) => reorder.onRowDrop(id, event)}
      className={cn(
        // The drop indicator is a CSS-only rule on the row's own edge
        // (`data-vex-drop-edge`, book.css): no JS positioning, no injected style.
        "vex-pf__item",
        settling && "vex-section-settle",
      )}
    >
      <button
        type="button"
        draggable
        onDragStart={(event) => reorder.onHandleDragStart(id, event)}
        onDragEnd={reorder.onDragEnd}
        onKeyDown={(event) => reorder.onHandleKeyDown(id, index, event)}
        aria-label={`Reorder ${label} - position ${index + 1} of ${count}`}
        className="vex-pf__grip"
      >
        <LineMenu size={14} />
      </button>
      {children}
    </li>
  );
}
