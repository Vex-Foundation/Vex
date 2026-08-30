/**
 * SPIKE ONLY (Stage B3 measurement). Not production code.
 *
 * Owned flat-index tree model, modelled on VS Code's IndexTreeModel
 * (`src/vs/base/browser/ui/tree/indexTreeModel.ts`): a single flattened array
 * of rendered rows, a per-node `renderNodeCount` maintained up the parent
 * chain, and `spliceSimple`-style incremental mutation that touches only the
 * affected slice of the rendered list instead of re-walking the tree.
 *
 * Collapsed nodes are never resolved: children are requested from the loader
 * exactly once per folder, on expand, and cached until invalidated.
 */

export interface FlatRow {
  readonly id: string;
  readonly name: string;
  readonly isFolder: boolean;
  readonly level: number;
  readonly expanded: boolean;
  /** 1-based aria posinset within the parent's child list */
  readonly posInSet: number;
  readonly setSize: number;
}

interface ModelNode {
  id: string;
  name: string;
  isFolder: boolean;
  level: number;
  parent: ModelNode | null;
  children: ModelNode[] | null; // null = never resolved
  expanded: boolean;
  /** self + all rendered descendants, VS Code's renderNodeCount */
  renderNodeCount: number;
  /** maintained on every child-list mutation so aria posinset is O(1) */
  indexInParent: number;
}

export interface SpliceEvent {
  readonly start: number;
  readonly deleteCount: number;
  readonly insertCount: number;
}

export interface FlatIndexModelOptions {
  readonly rootId: string;
  readonly loadChildren: (
    folderId: string,
  ) => ReadonlyArray<{ id: string; name: string; isFolder: boolean }>;
  readonly onSplice?: (event: SpliceEvent) => void;
}

export class FlatIndexModel {
  private readonly root: ModelNode;
  private readonly byId = new Map<string, ModelNode>();
  /** the rendered list; index i is the i-th visible row */
  private rows: ModelNode[] = [];
  private readonly options: FlatIndexModelOptions;
  private version = 0;

  constructor(options: FlatIndexModelOptions) {
    this.options = options;
    this.root = {
      id: options.rootId,
      name: options.rootId,
      isFolder: true,
      level: -1,
      parent: null,
      children: null,
      expanded: false,
      renderNodeCount: 0,
      indexInParent: 0,
    };
    this.byId.set(options.rootId, this.root);
  }

  /** Monotonic token: changes exactly once per mutation, for React state. */
  getVersion(): number {
    return this.version;
  }

  getRowCount(): number {
    return this.rows.length;
  }

  /**
   * O(1) id lookup. @tanstack/virtual-core calls `getItemKey(i)` inside an
   * O(count) loop whenever the measurements array is rebuilt, so anything
   * worse than O(1) here becomes O(n^2) per commit.
   */
  getRowId(index: number): string {
    const node = this.rows[index];
    if (!node) throw new Error(`no row at index ${index}`);
    return node.id;
  }

  getRow(index: number): FlatRow {
    const node = this.rows[index];
    if (!node) throw new Error(`no row at index ${index}`);
    const siblings = node.parent?.children ?? [];
    const posInSet = node.indexInParent + 1;
    return {
      id: node.id,
      name: node.name,
      isFolder: node.isFolder,
      level: node.level,
      expanded: node.expanded,
      posInSet,
      setSize: siblings.length,
    };
  }

  getIndexOf(id: string): number {
    const node = this.byId.get(id);
    if (!node) return -1;
    return this.rows.indexOf(node);
  }

  private resolve(node: ModelNode): ModelNode[] {
    if (node.children) return node.children;
    const loaded = this.options.loadChildren(node.id);
    const children = loaded.map((child) => {
      const existing = this.byId.get(child.id);
      const modelNode: ModelNode = existing ?? {
        id: child.id,
        name: child.name,
        isFolder: child.isFolder,
        level: node.level + 1,
        parent: node,
        children: null,
        expanded: false,
        renderNodeCount: 1,
        indexInParent: 0,
      };
      modelNode.parent = node;
      modelNode.level = node.level + 1;
      this.byId.set(child.id, modelNode);
      return modelNode;
    });
    node.children = children;
    this.reindexChildren(node);
    return children;
  }

  /** Flattens a node's rendered subtree (excluding the node itself). */
  private collectRendered(node: ModelNode, out: ModelNode[]): number {
    let count = 0;
    for (const child of this.resolve(node)) {
      out.push(child);
      count++;
      child.renderNodeCount = 1;
      if (child.expanded) {
        const nested = this.collectRendered(child, out);
        child.renderNodeCount += nested;
        count += nested;
      }
    }
    return count;
  }

  private reindexChildren(node: ModelNode): void {
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child) child.indexInParent = i;
    }
  }

  private adjustAncestors(node: ModelNode | null, delta: number): void {
    let cursor: ModelNode | null = node;
    while (cursor) {
      cursor.renderNodeCount += delta;
      cursor = cursor.parent;
    }
  }

  private splice(start: number, deleteCount: number, insert: ModelNode[]): void {
    if (deleteCount === 0 && insert.length === 0) return;
    // Array#splice on the rendered list: this is the whole mutation cost.
    this.rows.splice(start, deleteCount, ...insert);
    this.version++;
    this.options.onSplice?.({
      start,
      deleteCount,
      insertCount: insert.length,
    });
  }

  expandRoot(): void {
    const children = this.resolve(this.root);
    const inserted: ModelNode[] = [];
    for (const child of children) {
      child.renderNodeCount = 1;
      inserted.push(child);
    }
    this.root.expanded = true;
    this.root.renderNodeCount = inserted.length;
    this.splice(0, this.rows.length, inserted);
  }

  expand(id: string): void {
    const node = this.byId.get(id);
    if (!node || !node.isFolder || node.expanded) return;
    node.expanded = true;
    const inserted: ModelNode[] = [];
    // resolve() inside collectRendered loads this folder's children exactly
    // once; already-cached folders are never re-requested.
    const count = this.collectRendered(node, inserted);
    node.renderNodeCount = 1 + count;
    this.adjustAncestors(node.parent, count);
    const index = this.rows.indexOf(node);
    this.splice(index + 1, 0, inserted);
  }

  collapse(id: string): void {
    const node = this.byId.get(id);
    if (!node || !node.expanded) return;
    const removed = node.renderNodeCount - 1;
    node.expanded = false;
    node.renderNodeCount = 1;
    this.adjustAncestors(node.parent, -removed);
    const index = this.rows.indexOf(node);
    this.splice(index + 1, removed, []);
  }

  /** Inserts one child at `childIndex` of an expanded folder. */
  insertChild(
    parentId: string,
    childIndex: number,
    child: { id: string; name: string; isFolder: boolean },
  ): void {
    const parent = this.byId.get(parentId);
    if (!parent || !parent.children) return;
    const node: ModelNode = {
      id: child.id,
      name: child.name,
      isFolder: child.isFolder,
      level: parent.level + 1,
      parent,
      children: null,
      expanded: false,
      renderNodeCount: 1,
      indexInParent: childIndex,
    };
    this.byId.set(child.id, node);
    parent.children.splice(childIndex, 0, node);
    this.reindexChildren(parent);
    if (!parent.expanded) return;
    // Rendered offset = parent row + rendered counts of preceding siblings.
    let offset = this.rows.indexOf(parent) + 1;
    for (let i = 0; i < childIndex; i++) {
      offset += parent.children[i]?.renderNodeCount ?? 0;
    }
    this.adjustAncestors(parent, 1);
    this.splice(offset, 0, [node]);
  }

  removeChild(id: string): void {
    const node = this.byId.get(id);
    const parent = node?.parent;
    if (!node || !parent || !parent.children) return;
    const childIndex = parent.children.indexOf(node);
    parent.children.splice(childIndex, 1);
    this.reindexChildren(parent);
    this.byId.delete(id);
    if (!parent.expanded) return;
    let offset = this.rows.indexOf(parent) + 1;
    for (let i = 0; i < childIndex; i++) {
      offset += parent.children[i]?.renderNodeCount ?? 0;
    }
    const removed = node.renderNodeCount;
    this.adjustAncestors(parent, -removed);
    this.splice(offset, removed, []);
  }

  /**
   * Rename in place. Identity is the id, so a case-only rename is a pure
   * row-content change with no re-sort and no re-resolution.
   */
  rename(id: string, name: string): void {
    const node = this.byId.get(id);
    if (!node) return;
    node.name = name;
    this.version++;
    const index = this.rows.indexOf(node);
    this.options.onSplice?.({ start: index, deleteCount: 1, insertCount: 1 });
  }

  isResolved(id: string): boolean {
    return this.byId.get(id)?.children != null;
  }
}
