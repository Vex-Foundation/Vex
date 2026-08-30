/**
 * SPIKE ONLY (Stage B3 measurement). Not production code.
 *
 * Candidate A: @headless-tree/core 1.7.0 + @headless-tree/react 1.7.0 with the
 * async data loader, virtualized by @tanstack/react-virtual 3.14.8.
 *
 * The loader uses `getChildrenWithData`, not `getChildren`: with the plain
 * `getChildren` variant an item's data is still unloaded when its row first
 * renders, `isItemFolder` therefore returns false, and `item.expand()` is a
 * SILENT NO-OP (core 1.7.0 `expand()` returns early on `!item.isFolder()`).
 * That was observed in the first run of this spike, where six chained deep
 * expands changed nothing. `getChildrenWithData` delivers ids and data in one
 * round trip and is the only variant that makes expand deterministic.
 *
 * The row receives PRIMITIVE props (id, name, level, expanded, selected), not
 * the item instance: headless-tree caches item instances forever in
 * `itemInstancesMap`, so an instance is reference-stable even when its content
 * changes and `React.memo` over it would never re-render. Primitives make the
 * "did an unchanged row re-render" question answerable.
 */
import {
  asyncDataLoaderFeature,
  hotkeysCoreFeature,
  propMemoizationFeature,
  selectionFeature,
  type TreeInstance,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import React, { memo, useMemo, useRef } from "react";

import { countRow, type RenderCounters } from "./renderCounters";
import {
  OVERSCAN,
  ROW_HEIGHT,
  observeElementOffset,
  observeElementRect,
} from "./virtualWindow";

export interface SpikeItemData {
  readonly name: string;
  readonly isFolder: boolean;
}

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

export interface HeadlessTreeHarnessProps {
  readonly rootId: string;
  readonly getItem: (id: string) => Promise<SpikeItemData>;
  readonly getChildrenWithData: (
    id: string,
  ) => Promise<Array<{ id: string; data: SpikeItemData }>>;
  readonly counters: RenderCounters;
  readonly onTree: (tree: TreeInstance<SpikeItemData>) => void;
}

export const HeadlessTreeHarness = (
  props: HeadlessTreeHarnessProps,
): React.JSX.Element => {
  props.counters.listRenders++;
  const scrollRef = useRef<HTMLDivElement>(null);

  const tree = useTree<SpikeItemData>({
    rootItemId: props.rootId,
    getItemName: (item) => item.getItemData()?.name ?? item.getId(),
    isItemFolder: (item) => item.getItemData()?.isFolder ?? false,
    createLoadingItemData: () => ({ name: "…", isFolder: false }),
    dataLoader: {
      getItem: props.getItem,
      getChildrenWithData: props.getChildrenWithData,
    },
    initialState: { expandedItems: [] },
    features: [
      asyncDataLoaderFeature,
      selectionFeature,
      hotkeysCoreFeature,
      propMemoizationFeature,
    ],
  });
  props.onTree(tree);

  const items = tree.getItems();
  /**
   * WRAPPER under test: @tanstack/virtual-core calls `getItemKey(i)` inside an
   * O(count) loop per measurements rebuild, and each `item.getId()` on a
   * headless-tree PROXIED instance measured 1.8us here vs 0.02us for a plain
   * array read. `getItems()` returns a NEW array identity per rebuild, so this
   * memo collapses that to one proxy pass per structural change.
   */
  const ids = useMemo(() => items.map((item) => item.getId()), [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    observeElementRect,
    observeElementOffset,
    getItemKey: (index) => ids[index] ?? index,
  });

  return (
    <div ref={scrollRef} data-testid="scroller">
      <div {...tree.getContainerProps("Explorer")} data-testid="tree">
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index];
          if (!item) return null;
          const meta = item.getItemMeta();
          return (
            <Row
              key={virtualRow.key}
              id={item.getId()}
              name={item.getItemName()}
              level={meta.level}
              expanded={item.isExpanded()}
              selected={item.isSelected()}
              posInSet={meta.posInSet + 1}
              setSize={meta.setSize}
              counters={props.counters}
            />
          );
        })}
      </div>
    </div>
  );
};
