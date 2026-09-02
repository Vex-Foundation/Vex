/**
 * THE EXPLORER TREE MODEL - pure, synchronous, no React, no I/O.
 *
 * Ported from the stage-B3 spike, which measured this shape 10-13x faster per
 * splice than @headless-tree at 10k visible rows and thereby ratified the port.
 * The mechanics that produced that number are kept exactly:
 *
 *  - ONE flattened array of rendered rows, mutated with a single `Array#splice`
 *    per operation rather than rebuilt (VS Code's `IndexTreeModel`,
 *    `src/vs/base/browser/ui/tree/indexTreeModel.ts`);
 *  - a per-node `renderNodeCount` (self + rendered descendants) maintained up
 *    the parent chain, so a change knows its rendered offset without walking
 *    the subtree;
 *  - `indexInParent` maintained on every child-list mutation, so `aria-posinset`
 *    is O(1) instead of an `indexOf` per rendered row;
 *  - `getRowId(index)` is an array read. @tanstack/virtual-core calls it inside
 *    an O(count) loop whenever the measurements array is rebuilt, so anything
 *    worse than O(1) there is O(n^2) per commit;
 *  - a collapsed directory is NEVER resolved: nothing here loads, and an
 *    unresolved directory contributes exactly one row.
 *
 * ## What the port FIXED, because the spike had it wrong
 *
 *  1. `getIndexOf` was `rows.indexOf(node)`, an O(n) scan run inside expand,
 *     collapse, insert and remove. It is now a map maintained by the splice.
 *     The map costs one pass over the spliced SUFFIX, which is the same pass
 *     `Array#splice` already performs to move that suffix, so the asymptotics
 *     are unchanged and only the constant grows.
 *  2. `removeChild` deleted the removed node from `byId` but not its
 *     descendants, so every subtree the watcher ever removed leaked. Removal
 *     now purges the whole subtree and {@link ExplorerModel.nodeCount} exists
 *     to prove it.
 *  3. `resolve` silently RE-PARENTED a node whose id already existed elsewhere
 *     in the tree, quietly corrupting `renderNodeCount` up two chains. A
 *     `nodeId` under a second parent is a main-side defect; see
 *     {@link ExplorerModelOptions.onDuplicateNode}.
 *
 * ## Order is main's, never ours
 *
 * Listings arrive in the total order main's comparator defines (directories
 * first, numeric-aware collation, byte tiebreak) and the cursor encodes a
 * position in THAT order. This model appends and merges in the order received
 * and never sorts. A renderer that re-sorted would make every page boundary
 * meaningless.
 */

import type { FileListing, FileNode, FilesErrorCode } from "@shared/schemas/files.js";
import type {
  ExplorerLoadState,
  ExplorerRow,
  LoadMoreDescriptor,
  NoticeDescriptor,
  SetChildrenMode,
} from "./explorer-rows.js";

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

interface ModelNode {
  readonly id: string;
  /** `null` only for the synthetic root, which is never a rendered row. */
  node: FileNode | null;
  parent: ModelNode | null;
  /** `null` means NEVER LISTED. An empty array means "listed, and empty". */
  children: ModelNode[] | null;
  expanded: boolean;
  level: number;
  indexInParent: number;
  /** Self plus every rendered descendant, tail rows included. VS Code's count. */
  renderNodeCount: number;
  loadState: ExplorerLoadState;
  errorCode: FilesErrorCode | null;
  loadedCount: number;
  totalCount: number | null;
  excludedCount: number | null;
  /**
   * Set when a session deactivates: this listing predates events nobody was
   * listening for, so reactivation must re-list rather than trust it.
   */
  stale: boolean;
  loadMore: LoadMoreDescriptor | null;
  notice: NoticeDescriptor | null;
}

type RenderedEntry =
  | { readonly kind: "node"; readonly owner: ModelNode }
  | { readonly kind: "loadMore"; readonly owner: ModelNode }
  | { readonly kind: "notice"; readonly owner: ModelNode };

/**
 * The synthetic root's internal id.
 *
 * A leading space cannot appear in a main-minted `FileNodeId` (they are
 * base64url-ish tokens), so this can never collide with a real node.
 */
const ROOT_ID = " root";

/** Tail-row ids, namespaced so they can never collide with a `nodeId`. */
function loadMoreRowId(ownerId: string): string {
  return `${ownerId}::more`;
}

function noticeRowId(ownerId: string): string {
  return `${ownerId === ROOT_ID ? "root" : ownerId}::notice`;
}

function entryId(entry: RenderedEntry): string {
  if (entry.kind === "node") return entry.owner.id;
  if (entry.kind === "loadMore") return loadMoreRowId(entry.owner.id);
  return noticeRowId(entry.owner.id);
}

export interface ExplorerModelOptions {
  /**
   * A `nodeId` arrived as a child of a second parent.
   *
   * Main mints a node token deterministically from (project, path, epoch), so
   * one id under two parents means two paths minted the same token: a main-side
   * defect that would corrupt `renderNodeCount` up two ancestor chains if
   * accepted. The default THROWS, which is what a development build should do.
   * A production owner passes a reporter here and the duplicate is dropped from
   * the listing instead, because a tree missing one row is still usable and a
   * corrupted one is not.
   */
  readonly onDuplicateNode?: (nodeId: string) => void;
}

/* ------------------------------------------------------------------ *
 * The model
 * ------------------------------------------------------------------ */

export class ExplorerModel {
  readonly #root: ModelNode;
  readonly #byId = new Map<string, ModelNode>();
  /**
   * Project-relative path -> node.
   *
   * A change event names a PATH; the tree is keyed by `nodeId`. Without this
   * index every `added` and `deleted` would need a scan to find the parent it
   * affects, which is exactly the O(n) per change the flat-index model exists
   * to avoid. Path and id are equally unique within a watcher epoch - main
   * mints the token FROM the path - so the two indexes cannot disagree.
   */
  readonly #byPath = new Map<string, ModelNode>();
  #rows: RenderedEntry[] = [];
  /** Row id -> index in `#rows`. Maintained by `#splice`; never scanned. */
  readonly #indexById = new Map<string, number>();
  readonly #listeners = new Set<() => void>();
  readonly #onDuplicateNode: ((nodeId: string) => void) | null;
  #version = 0;

  constructor(options: ExplorerModelOptions = {}) {
    this.#onDuplicateNode = options.onDuplicateNode ?? null;
    this.#root = {
      id: ROOT_ID,
      node: null,
      parent: null,
      children: null,
      expanded: true,
      level: -1,
      indexInParent: 0,
      renderNodeCount: 0,
      loadState: "idle",
      errorCode: null,
      loadedCount: 0,
      totalCount: null,
      excludedCount: null,
      stale: false,
      loadMore: null,
      notice: null,
    };
  }

  /* ----------------------- reading ----------------------- */

  /** Monotonic; changes once per mutation. The `useSyncExternalStore` snapshot. */
  getVersion(): number {
    return this.#version;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getRowCount(): number {
    return this.#rows.length;
  }

  /** O(1) array read; see the module note on why that matters. */
  getRowId(index: number): string {
    const entry = this.#rows[index];
    if (entry === undefined) throw new Error(`explorer: no row at index ${String(index)}`);
    return entryId(entry);
  }

  /** O(1). The index map is the whole reason this is not a scan. */
  getIndexOf(rowId: string): number {
    return this.#indexById.get(rowId) ?? -1;
  }

  getRow(index: number): ExplorerRow {
    const entry = this.#rows[index];
    if (entry === undefined) throw new Error(`explorer: no row at index ${String(index)}`);
    return this.#toRow(entry);
  }

  /**
   * Every rendered row, materialised.
   *
   * O(n) allocation, so it is a TEST seam and a naive-recomputation
   * cross-check, never the render path: the component reads `getRow(index)`
   * for the ~30 rows the virtualizer actually mounts.
   */
  getRows(): readonly ExplorerRow[] {
    return this.#rows.map((entry) => this.#toRow(entry));
  }

  /**
   * Live nodes held by the model.
   *
   * Exposed so a test can prove a removed subtree left nothing behind; the
   * spike leaked every descendant of every node the watcher removed.
   */
  nodeCount(): number {
    return this.#byId.size;
  }

  /**
   * Every node the model currently holds, bounded, WITH whether the bound bit.
   *
   * The rail's search reads this: it is the honest extent of what a client-side
   * file search can answer over, because a folder the user never expanded was
   * never listed and is not in here. Reads the PATH index rather than the
   * rendered rows, so a loaded-but-collapsed folder's children stay searchable
   * and nothing is materialised per row.
   *
   * `truncated` is returned rather than left for the caller to infer: a caller
   * holding only a capped array cannot tell a tree of exactly `limit` nodes from
   * one of ten thousand, and the difference is whether a matching file may be
   * missing from the user's answer entirely (rule 05, bounds are reported).
   *
   * @param limit hard cap on the returned array; a non-positive limit reads
   *   nothing and reports truncation iff anything was there to read.
   * @returns the bounded nodes and whether the walk stopped early.
   */
  loadedNodes(limit: number): { readonly nodes: readonly FileNode[]; readonly truncated: boolean } {
    const nodes: FileNode[] = [];
    for (const entry of this.#byPath.values()) {
      if (entry.node === null) continue;
      if (nodes.length >= limit) return { nodes, truncated: true };
      nodes.push(entry.node);
    }
    return { nodes, truncated: false };
  }

  hasNode(nodeId: string): boolean {
    return this.#byId.has(nodeId);
  }

  isExpanded(nodeId: string): boolean {
    return this.#byId.get(nodeId)?.expanded ?? false;
  }

  isResolved(nodeId: string | null): boolean {
    return this.#nodeOrRoot(nodeId)?.children != null;
  }

  isStale(nodeId: string | null): boolean {
    return this.#nodeOrRoot(nodeId)?.stale ?? false;
  }

  loadedCountOf(nodeId: string | null): number {
    return this.#nodeOrRoot(nodeId)?.loadedCount ?? 0;
  }

  /** What the exclude rules hid in one directory, or null before its listing. */
  excludedCountOf(nodeId: string | null): number | null {
    return this.#nodeOrRoot(nodeId)?.excludedCount ?? null;
  }

  /** The next-page cursor a directory holds, or null when it has none. */
  cursorOf(nodeId: string | null): string | null {
    return this.#nodeOrRoot(nodeId)?.loadMore?.cursor ?? null;
  }

  /**
   * A directory's load-more descriptor, or null when it has no tail row.
   *
   * A read of the node's own field, not a row lookup: the tail row's id scheme
   * is this file's private business, and a caller that had to spell
   * `${nodeId}::more` to ask this question would be a second home for it.
   */
  loadMoreOf(nodeId: string | null): LoadMoreDescriptor | null {
    return this.#nodeOrRoot(nodeId)?.loadMore ?? null;
  }

  /** The owning directory of a node, or `null` when it sits at the root. */
  parentOf(nodeId: string): string | null {
    const parent = this.#byId.get(nodeId)?.parent ?? null;
    if (parent === null || parent === this.#root) return null;
    return parent.id;
  }

  nodeOf(nodeId: string): FileNode | null {
    return this.#byId.get(nodeId)?.node ?? null;
  }

  /**
   * Resolve a project-relative path to the row that holds it.
   *
   * Three answers, all distinct and none collapsible: `null` is THE ROOT (whose
   * project-relative path is the empty string), a string is that node's id, and
   * `undefined` means the tree does not hold this path - which is the normal
   * answer for a change under a folder the user has never opened, and the
   * signal that there is nothing to refresh.
   */
  nodeIdOfPath(path: string): string | null | undefined {
    if (path === "") return null;
    return this.#byPath.get(path)?.id;
  }

  /**
   * Every directory that is expanded AND resolved, in TREE ORDER, root first.
   *
   * Tree order is the contract, not a convenience: a resync re-lists this list
   * sequentially, and refreshing a parent before its children is what lets the
   * merge preserve a child the parent's own re-list would otherwise rediscover.
   */
  expandedResolvedDirectories(): readonly (string | null)[] {
    const out: (string | null)[] = [];
    if (this.#root.children !== null) out.push(null);
    const walk = (node: ModelNode): void => {
      for (const child of node.children ?? []) {
        if (child.expanded && child.children !== null) {
          out.push(child.id);
          walk(child);
        }
      }
    };
    walk(this.#root);
    return out;
  }

  /** Every directory that is resolved but collapsed. A resync forgets these. */
  collapsedResolvedDirectories(): readonly string[] {
    const out: string[] = [];
    const walk = (node: ModelNode): void => {
      for (const child of node.children ?? []) {
        if (child.children === null) continue;
        if (child.expanded) walk(child);
        else out.push(child.id);
      }
    };
    walk(this.#root);
    return out;
  }

  /* ----------------------- mutation ----------------------- */

  /**
   * Expand a directory. Renders whatever is already resolved and NOTHING else:
   * loading is the session's job, and a model that fetched would be a model
   * with I/O in it.
   */
  expand(nodeId: string): boolean {
    const node = this.#byId.get(nodeId);
    if (node === undefined || node.node?.kind !== "directory" || node.expanded) return false;
    node.expanded = true;
    this.#renderChildrenOf(node);
    return true;
  }

  collapse(nodeId: string): boolean {
    const node = this.#byId.get(nodeId);
    if (node === undefined || !node.expanded) return false;
    node.expanded = false;
    this.#renderChildrenOf(node);
    return true;
  }

  /** Collapse every directory. One splice: the rendered list becomes the root's. */
  collapseAll(): void {
    const walk = (node: ModelNode): void => {
      for (const child of node.children ?? []) {
        walk(child);
        child.expanded = false;
        child.renderNodeCount = 1;
      }
    };
    walk(this.#root);
    this.#renderChildrenOf(this.#root);
  }

  /**
   * A directory becomes unresolved and drops its children.
   *
   * VS Code's `ExplorerItem.forgetChildren` (`explorerModel.ts:408-413`): the
   * memory a collapsed directory holds is not worth the staleness it hides, and
   * the next expand re-lists it anyway.
   */
  forget(nodeId: string | null): void {
    const node = this.#nodeOrRoot(nodeId);
    if (node === undefined || node.children === null) return;
    for (const child of node.children) this.#purge(child);
    node.children = null;
    node.expanded = node === this.#root;
    node.loadState = "idle";
    node.errorCode = null;
    node.loadedCount = 0;
    node.totalCount = null;
    node.excludedCount = null;
    node.stale = false;
    node.loadMore = null;
    this.#renderChildrenOf(node);
  }

  /** Mark a resolved directory as needing a re-list before it can be trusted. */
  markStale(nodeId: string | null): void {
    const node = this.#nodeOrRoot(nodeId);
    if (node === undefined || node.children === null) return;
    node.stale = true;
  }

  /** Mark every resolved directory stale. The deactivate path. */
  markAllStale(): void {
    if (this.#root.children !== null) this.#root.stale = true;
    for (const node of this.#byId.values()) {
      if (node.children !== null) node.stale = true;
    }
  }

  /**
   * Join a listing page to a directory.
   *
   * `"replace"` is VS Code's `mergeLocalWithDisk` (`explorerModel.ts:247-292`):
   * a child that survives the re-list KEEPS its expansion, its resolution and
   * its whole subtree, a child that is gone is removed WITH its descendants,
   * and a new child is inserted at the position the listing gives it. Local
   * expansion is user state; a refresh must not spend it.
   *
   * `"append"` is the load-more path: the page is concatenated in the order
   * received. A row already present is skipped rather than duplicated, which
   * is what ranking drift between two live pages produces.
   */
  setChildren(parentId: string | null, listing: FileListing, mode: SetChildrenMode): void {
    const parent = this.#nodeOrRoot(parentId);
    if (parent === undefined) return;

    const previous = parent.children ?? [];
    const survivors = new Map<string, ModelNode>();
    for (const child of previous) survivors.set(child.id, child);

    const next: ModelNode[] = mode === "append" ? [...previous] : [];
    const present = new Set<string>(next.map((child) => child.id));

    for (const incoming of listing.children) {
      const existing = this.#byId.get(incoming.nodeId);
      if (existing !== undefined && existing.parent !== parent) {
        if (this.#onDuplicateNode === null) {
          throw new Error(
            `explorer: node ${incoming.nodeId} already exists under another parent`,
          );
        }
        this.#onDuplicateNode(incoming.nodeId);
        continue;
      }
      if (present.has(incoming.nodeId)) continue;
      present.add(incoming.nodeId);

      const reused = survivors.get(incoming.nodeId);
      if (reused === undefined) {
        next.push(this.#createNode(incoming, parent));
        continue;
      }
      reused.node = incoming;
      this.#byPath.set(incoming.path, reused);
      survivors.delete(incoming.nodeId);
      next.push(reused);
    }

    if (mode === "replace") {
      for (const gone of survivors.values()) this.#purge(gone);
    }

    parent.children = next;
    parent.loadState = "loaded";
    parent.errorCode = null;
    parent.stale = false;
    // A directory's own notice is always a LISTING FAILURE, and the listing that
    // succeeded is its answer - including after a retry, which passes through
    // `loading` first and so cannot be recognised by the previous load state.
    // The ROOT's notice is the WATCHER's, owned by the session, and survives.
    if (parent !== this.#root) parent.notice = null;
    parent.loadedCount = next.length;
    parent.totalCount = listing.totalCount;
    parent.excludedCount = listing.excludedCount;
    parent.loadMore =
      listing.hasMore && listing.nextCursor !== null
        ? {
            remaining: Math.max(0, listing.totalCount - next.length),
            cursor: listing.nextCursor,
            state: "idle",
          }
        : null;
    this.#reindex(parent);
    this.#renderChildrenOf(parent);
  }

  /**
   * Set a directory's own listing state.
   *
   * `"loaded"` is deliberately not settable here: it is a claim about children
   * this method does not carry, and only {@link ExplorerModel.setChildren} can
   * honestly make it.
   */
  setLoadState(
    nodeId: string | null,
    loadState: Exclude<ExplorerLoadState, "loaded">,
    errorCode?: FilesErrorCode,
  ): void {
    const node = this.#nodeOrRoot(nodeId);
    if (node === undefined) return;
    node.loadState = loadState;
    node.errorCode = errorCode ?? null;
    this.#bump();
  }

  /** Replace or clear a directory's load-more row. */
  setLoadMore(nodeId: string | null, descriptor: LoadMoreDescriptor | null): void {
    const node = this.#nodeOrRoot(nodeId);
    if (node === undefined) return;
    node.loadMore = descriptor;
    this.#renderChildrenOf(node);
  }

  /** Replace or clear a notice row. At the root this is the watcher's notice. */
  setNotice(nodeId: string | null, descriptor: NoticeDescriptor | null): void {
    const node = this.#nodeOrRoot(nodeId);
    if (node === undefined) return;
    node.notice = descriptor;
    this.#renderChildrenOf(node);
  }

  /**
   * Remove a node and its whole subtree.
   *
   * The `deleted` change kind takes this path: it is cheap, exact and
   * immediate, and it is what stops a deleted file staying on screen for the
   * 500 ms the refresh scheduler waits.
   */
  removeNode(nodeId: string): boolean {
    const node = this.#byId.get(nodeId);
    const parent = node?.parent;
    if (node === undefined || parent === undefined || parent === null) return false;
    const children = parent.children;
    if (children === null) return false;
    const at = children.indexOf(node);
    if (at === -1) return false;
    children.splice(at, 1);
    this.#purge(node);
    parent.loadedCount = children.length;
    if (parent.totalCount !== null) parent.totalCount = Math.max(0, parent.totalCount - 1);
    this.#reindex(parent);
    this.#renderChildrenOf(parent);
    return true;
  }

  /**
   * Drop every row and every node, keeping only the root's own notice.
   *
   * The `suspended` and `closed` paths: a project folder that vanished is not a
   * tree with a warning on it, it is no tree at all.
   */
  clear(): void {
    for (const child of this.#root.children ?? []) this.#purge(child);
    this.#root.children = null;
    this.#root.loadState = "idle";
    this.#root.errorCode = null;
    this.#root.loadedCount = 0;
    this.#root.totalCount = null;
    this.#root.excludedCount = null;
    this.#root.stale = false;
    this.#root.loadMore = null;
    this.#renderChildrenOf(this.#root);
  }

  /* ----------------------- internals ----------------------- */

  #nodeOrRoot(nodeId: string | null): ModelNode | undefined {
    return nodeId === null ? this.#root : this.#byId.get(nodeId);
  }

  #createNode(node: FileNode, parent: ModelNode): ModelNode {
    const created: ModelNode = {
      id: node.nodeId,
      node,
      parent,
      children: null,
      expanded: false,
      level: parent.level + 1,
      indexInParent: 0,
      renderNodeCount: 1,
      loadState: "idle",
      errorCode: null,
      loadedCount: 0,
      totalCount: null,
      excludedCount: null,
      stale: false,
      loadMore: null,
      notice: null,
    };
    this.#byId.set(created.id, created);
    this.#byPath.set(node.path, created);
    return created;
  }

  /** Drop a node and every descendant from both indexes. The spike's leak, closed. */
  #purge(node: ModelNode): void {
    for (const child of node.children ?? []) this.#purge(child);
    node.children = null;
    node.parent = null;
    this.#byId.delete(node.id);
    const path = node.node?.path;
    // Only when this node still OWNS the path entry: a re-list that replaced a
    // node at the same path must not have its survivor evicted by the corpse.
    if (path !== undefined && this.#byPath.get(path) === node) this.#byPath.delete(path);
  }

  #reindex(parent: ModelNode): void {
    const children = parent.children ?? [];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child === undefined) continue;
      child.indexInParent = index;
      child.level = parent.level + 1;
    }
  }

  /** Rows a directory contributes below itself, plus its own tail rows. */
  #collect(node: ModelNode, out: RenderedEntry[]): number {
    let count = 0;
    for (const child of node.children ?? []) {
      out.push({ kind: "node", owner: child });
      count += 1;
      child.renderNodeCount = 1;
      if (child.expanded) {
        const nested = this.#collect(child, out);
        child.renderNodeCount += nested;
        count += nested;
      }
    }
    if (node.loadMore !== null) {
      out.push({ kind: "loadMore", owner: node });
      count += 1;
    }
    if (node.notice !== null) {
      out.push({ kind: "notice", owner: node });
      count += 1;
    }
    return count;
  }

  /**
   * Re-render one directory's block in ONE splice.
   *
   * Every mutation above funnels through here, which is what keeps the promise
   * the spike measured: the cost of a change is the size of the block it
   * touches plus the memmove of the rows after it, never a walk of the tree.
   */
  #renderChildrenOf(node: ModelNode): void {
    const isRoot = node === this.#root;
    const selfRows = isRoot ? 0 : 1;
    const start = isRoot ? 0 : this.getIndexOf(node.id) + 1;
    if (!isRoot && start === 0) {
      // The directory itself is not rendered, so an ancestor is collapsed and
      // its block is not in the list. The COUNTS still have to be right for the
      // moment that ancestor expands, so recompute them and stop.
      const buffer: RenderedEntry[] = [];
      node.renderNodeCount = selfRows + (node.expanded ? this.#collect(node, buffer) : 0);
      this.#bump();
      return;
    }
    const previous = node.renderNodeCount - selfRows;
    const inserted: RenderedEntry[] = [];
    const count = node.expanded ? this.#collect(node, inserted) : 0;
    node.renderNodeCount = selfRows + count;
    this.#adjustAncestors(node.parent, count - previous);
    this.#splice(start, previous, inserted);
  }

  #adjustAncestors(from: ModelNode | null, delta: number): void {
    if (delta === 0) return;
    let cursor = from;
    while (cursor !== null) {
      cursor.renderNodeCount += delta;
      cursor = cursor.parent;
    }
  }

  /**
   * The one mutation of the rendered list.
   *
   * The index map is repaired for the SUFFIX only. `Array#splice` already moves
   * exactly that suffix, so this adds a constant factor rather than a term.
   */
  #splice(start: number, deleteCount: number, insert: readonly RenderedEntry[]): void {
    if (deleteCount === 0 && insert.length === 0) {
      this.#bump();
      return;
    }
    for (let index = start; index < start + deleteCount; index += 1) {
      const entry = this.#rows[index];
      if (entry !== undefined) this.#indexById.delete(entryId(entry));
    }
    this.#rows.splice(start, deleteCount, ...insert);
    for (let index = start; index < this.#rows.length; index += 1) {
      const entry = this.#rows[index];
      if (entry !== undefined) this.#indexById.set(entryId(entry), index);
    }
    this.#bump();
  }

  #bump(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }

  #toRow(entry: RenderedEntry): ExplorerRow {
    const owner = entry.owner;
    const parent = entry.kind === "node" ? owner.parent : owner;
    const siblings = parent === null ? 0 : (parent.children?.length ?? 0);
    const tailCount =
      parent === null
        ? 0
        : (parent.loadMore === null ? 0 : 1) + (parent.notice === null ? 0 : 1);
    const setSize = siblings + tailCount;
    const parentId = parent === null || parent === this.#root ? null : parent.id;

    if (entry.kind === "node") {
      const node = owner.node;
      if (node === null) throw new Error("explorer: the root is not a rendered row");
      return {
        kind: "node",
        id: owner.id,
        level: owner.level,
        parentId,
        posInSet: owner.indexInParent + 1,
        setSize,
        node,
        expanded: owner.expanded,
        resolved: owner.children !== null,
        loadState: owner.loadState,
        errorCode: owner.errorCode,
        loadedCount: owner.loadedCount,
        totalCount: owner.totalCount,
        excludedCount: owner.excludedCount,
      };
    }

    const level = owner.level + 1;
    if (entry.kind === "loadMore") {
      const descriptor = owner.loadMore;
      if (descriptor === null) throw new Error("explorer: load-more row without a descriptor");
      return {
        kind: "loadMore",
        id: loadMoreRowId(owner.id),
        level,
        parentId,
        posInSet: siblings + 1,
        setSize,
        remaining: descriptor.remaining,
        cursor: descriptor.cursor,
        state: descriptor.state,
        errorCode: descriptor.errorCode ?? null,
      };
    }

    const descriptor = owner.notice;
    if (descriptor === null) throw new Error("explorer: notice row without a descriptor");
    return {
      kind: "notice",
      id: noticeRowId(owner.id),
      level,
      parentId,
      posInSet: siblings + (owner.loadMore === null ? 0 : 1) + 1,
      setSize,
      text: descriptor.text,
      action: descriptor.action,
      code: descriptor.code ?? null,
      tone: descriptor.tone,
    };
  }
}
