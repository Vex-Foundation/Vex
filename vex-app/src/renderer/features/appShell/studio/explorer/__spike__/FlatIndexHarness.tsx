/**
 * SPIKE ONLY (Stage B3 measurement). Not production code.
 *
 * Candidate B: the owned flat-index model (VS Code IndexTreeModel shape) over
 * @tanstack/react-virtual, with the identical Row component contract and the
 * identical virtual-window overrides, so the two candidates are counted the
 * same way.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import React, { memo, useRef, useSyncExternalStore } from "react";

import type { FlatIndexModel } from "./flatIndexModel";
import { countRow, type RenderCounters } from "./renderCounters";
import {
  OVERSCAN,
  ROW_HEIGHT,
  observeElementOffset,
  observeElementRect,
} from "./virtualWindow";

interface RowProps {
  readonly id: string;
  readonly name: string;
  readonly level: number;
  readonly expanded: boolean;
  readonly selected: boolean;
  readonly posInSet: number;
  readonly setSize: number;
  readonly counters: RenderCounters;
}

const Row = memo(function Row(props: RowProps) {
  countRow(props.counters, props.id);
  return (
    <div
      role="treeitem"
      data-id={props.id}
      aria-level={props.level + 1}
      aria-posinset={props.posInSet}
      aria-setsize={props.setSize}
      aria-expanded={props.expanded ? "true" : undefined}
      aria-selected={props.selected}
    >
      {props.name}
    </div>
  );
});

export interface FlatIndexHarnessProps {
  readonly model: FlatIndexModel;
  readonly subscribe: (onChange: () => void) => () => void;
  readonly counters: RenderCounters;
  readonly selectedId: string | null;
}

export const FlatIndexHarness = (
  props: FlatIndexHarnessProps,
): React.JSX.Element => {
  props.counters.listRenders++;
  const scrollRef = useRef<HTMLDivElement>(null);
  // The model is the external store; the version token is the snapshot, so a
  // splice produces exactly one commit.
  useSyncExternalStore(props.subscribe, () => props.model.getVersion());

  const count = props.model.getRowCount();
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    observeElementRect,
    observeElementOffset,
    // O(1): virtual-core calls this in an O(count) loop per measurements
    // rebuild, so a derived-object lookup here would be O(n^2) per commit.
    getItemKey: (index) =>
      index < props.model.getRowCount() ? props.model.getRowId(index) : index,
  });

  return (
    <div ref={scrollRef} data-testid="scroller">
      <div role="tree" aria-label="Explorer" data-testid="tree">
        {virtualizer.getVirtualItems().map((virtualRow) => {
          if (virtualRow.index >= count) return null;
          const row = props.model.getRow(virtualRow.index);
          return (
            <Row
              key={row.id}
              id={row.id}
              name={row.name}
              level={row.level}
              expanded={row.expanded}
              selected={props.selectedId === row.id}
              posInSet={row.posInSet}
              setSize={row.setSize}
              counters={props.counters}
            />
          );
        })}
      </div>
    </div>
  );
};
