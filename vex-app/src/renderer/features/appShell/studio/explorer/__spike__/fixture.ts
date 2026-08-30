/**
 * SPIKE ONLY (Stage B3 measurement). Not production code.
 *
 * Deterministic synthetic workspace tree used by both candidate benchmarks so
 * the comparison is apples to apples: same node ids, same shape, same loader.
 */

export interface SpikeNode {
  readonly id: string;
  readonly name: string;
  readonly isFolder: boolean;
}

export interface SpikeTreeSource {
  /** id -> node */
  readonly nodes: Map<string, SpikeNode>;
  /** folder id -> ordered child ids (mutable: the splice scenarios edit it) */
  readonly children: Map<string, string[]>;
  readonly rootId: string;
  readonly totalNodes: number;
  /** a folder whose expanded subtree holds >= 10_000 descendants */
  readonly bigFolderId: string;
  /** a folder at depth >= 5, used for the deep-expand scenario */
  readonly deepFolderId: string;
}

/** Mulberry32: deterministic, so every run measures the same tree. */
const makeRandom = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Builds ~`targetNodes` nodes with depth 6-8 and a mixed directory/file ratio,
 * then guarantees one folder with >= 10_000 expanded descendants (the splice
 * subject) and one folder at depth >= 5 (the deep-expand subject).
 */
export const buildSpikeTree = (targetNodes = 50_000): SpikeTreeSource => {
  const random = makeRandom(0x5e1f00d);
  const nodes = new Map<string, SpikeNode>();
  const children = new Map<string, string[]>();
  const rootId = "root";
  nodes.set(rootId, { id: rootId, name: "workspace", isFolder: true });
  children.set(rootId, []);

  let created = 0;
  const nextId = () => `n${created}`;

  /** BFS-ish growth so the tree is wide at the top like a real workspace. */
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  while (created < targetNodes && queue.length > 0) {
    const parent = queue.shift();
    if (!parent) break;
    const maxDepth = 6 + Math.floor(random() * 3); // 6..8
    const count = 4 + Math.floor(random() * 9); // 4..12 children
    const list = children.get(parent.id) ?? [];
    for (let i = 0; i < count && created < targetNodes; i++) {
      const id = nextId();
      created++;
      const canRecurse = parent.depth + 1 < maxDepth;
      const isFolder = canRecurse && random() < 0.5;
      nodes.set(id, {
        id,
        name: isFolder ? `dir-${id}` : `file-${id}.ts`,
        isFolder,
      });
      list.push(id);
      if (isFolder) {
        children.set(id, []);
        queue.push({ id, depth: parent.depth + 1 });
      }
    }
    children.set(parent.id, list);
  }

  // A dedicated fat folder: 10_400 direct-and-nested descendants, all files
  // plus one nested folder level, so "expanded with 10k visible descendants"
  // is a fact of the fixture and not an accident of the random shape.
  const bigFolderId = "big";
  nodes.set(bigFolderId, { id: bigFolderId, name: "dir-big", isFolder: true });
  const bigChildren: string[] = [];
  children.set(bigFolderId, bigChildren);
  (children.get(rootId) as string[]).push(bigFolderId);
  for (let i = 0; i < 10_400; i++) {
    const id = `big-${i}`;
    nodes.set(id, { id, name: `file-${i}.ts`, isFolder: false });
    bigChildren.push(id);
  }

  // A guaranteed depth-6 chain for the deep-expand scenario.
  let parentId = rootId;
  for (let depth = 1; depth <= 6; depth++) {
    const id = `deep-${depth}`;
    nodes.set(id, { id, name: `dir-deep-${depth}`, isFolder: true });
    const kids: string[] = [];
    children.set(id, kids);
    (children.get(parentId) as string[]).push(id);
    for (let i = 0; i < 40; i++) {
      const fileId = `deep-${depth}-f${i}`;
      nodes.set(fileId, { id: fileId, name: `file-${i}.ts`, isFolder: false });
      kids.push(fileId);
    }
    parentId = id;
  }

  return {
    nodes,
    children,
    rootId,
    totalNodes: nodes.size,
    bigFolderId,
    deepFolderId: "deep-6",
  };
};

export interface LoaderProbe {
  /** child-id resolutions, one entry per folder id per call */
  readonly childrenCalls: string[];
  /** item-data resolutions */
  readonly dataCalls: string[];
  reset: () => void;
}

export const createLoaderProbe = (): LoaderProbe => {
  const childrenCalls: string[] = [];
  const dataCalls: string[] = [];
  return {
    childrenCalls,
    dataCalls,
    reset: () => {
      childrenCalls.length = 0;
      dataCalls.length = 0;
    },
  };
};
