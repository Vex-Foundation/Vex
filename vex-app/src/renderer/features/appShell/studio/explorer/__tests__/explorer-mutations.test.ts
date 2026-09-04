/**
 * THE WRITE PATH THROUGH THE MODEL AND THE SESSION.
 *
 * The state machine one row walks - idle, editing, pending, then committed or
 * failed - and the cross-product the brief named. The cases that are here
 * because they go quietly wrong:
 *
 *  - A REFUSAL MUST REOPEN THE ROW, not vanish into a toast. A user whose
 *    rename was refused needs the reason beside the name they typed, and needs
 *    the name still there to fix.
 *  - THE FENCE APPLIES TO WRITES TOO. A commit that resolves after the session
 *    deactivated, or after a `suspended` cleared the tree, must not reopen a
 *    name box over a tree that is gone.
 *  - A WATCHER EVENT THAT ARRIVES FIRST MUST NOT PRODUCE TWO ROWS. The
 *    optimistic apply and the authoritative refresh describe the same entry
 *    and merge by node id.
 *  - A PAGED DIRECTORY MUST REFUSE THE OPTIMISTIC INSERT. This model never
 *    sorts (order is main's), so appending into an incomplete listing would put
 *    a row on a page it does not belong to and desynchronise the cursor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileNode, FilesOutcome } from "@shared/schemas/files.js";
import type { Result } from "@shared/ipc/result.js";
import { ExplorerModel } from "../explorer-model.js";
import { ExplorerSession } from "../explorer-session.js";
import { useFileRenameSignalStore } from "../../workspace/file-rename-signal.js";
import {
  FilesApiFake,
  changedEvent,
  directoryNode,
  fileNode,
  listingOf,
} from "./explorer-harness.js";

let api: FilesApiFake;
let sessions: ExplorerSession[] = [];

/** What each mutation answers next, and what it was called with. */
interface MutationScript {
  create: Result<FilesOutcome<FileNode>>;
  rename: Result<FilesOutcome<FileNode>>;
  delete: Result<FilesOutcome<{ path: string; disposition: string; kind: string }>>;
  readonly calls: Array<{ readonly method: string; readonly input: unknown }>;
  /** When set, the next call parks until it is settled. */
  hold: { resolve: (value: unknown) => void } | null;
}

let script: MutationScript;

function freshScript(): MutationScript {
  return {
    create: { ok: true, data: { ok: true, value: fileNode("new.txt") } },
    rename: { ok: true, data: { ok: true, value: fileNode("renamed.txt") } },
    delete: {
      ok: true,
      data: { ok: true, value: { path: "gone.txt", disposition: "trash", kind: "file" } },
    },
    calls: [],
    hold: null,
  };
}

function record(method: "create" | "rename" | "delete", input: unknown): Promise<unknown> {
  script.calls.push({ method, input });
  if (script.hold !== null) {
    const held = script.hold;
    script.hold = null;
    return new Promise((resolve) => {
      held.resolve = resolve;
      parked = held;
    });
  }
  return Promise.resolve(script[method]);
}

/** The parked mutation, so a test can settle it after moving the world. */
let parked: { resolve: (value: unknown) => void } | null = null;

vi.mock("../../../../../lib/api/files.js", () => ({
  listProjectChildren: (input: Parameters<FilesApiFake["listChildren"]>[0]) =>
    api.listChildren(input),
  readProjectFile: () => {
    throw new Error("the tree never reads a file");
  },
  watchProjectFiles: (input: Parameters<FilesApiFake["watchFile"]>[0]) => api.watchFile(input),
  unwatchProjectFiles: (subscriptionId: string) => api.unwatchFile({ subscriptionId }),
  onProjectFilesEvent: (
    subscriptionId: string,
    cb: Parameters<FilesApiFake["onFilesEvent"]>[1],
  ) => api.onFilesEvent(subscriptionId, cb),
  createProjectNode: (input: unknown) => record("create", input),
  renameProjectNode: (input: unknown) => record("rename", input),
  deleteProjectNode: (input: unknown) => record("delete", input),
}));

function makeSession(projectId = "p1"): ExplorerSession {
  const session = new ExplorerSession({ projectId });
  sessions.push(session);
  return session;
}

/** Let every queued microtask settle. */
async function flush(): Promise<void> {
  for (let step = 0; step < 20; step += 1) await Promise.resolve();
}

/** Activate a session whose root lists to the given nodes. */
async function liveSession(children: readonly FileNode[] = []): Promise<ExplorerSession> {
  api.listResponder = () => ({ ok: true, data: { ok: true, value: listingOf([...children]) } });
  const session = makeSession();
  await session.activate();
  await flush();
  return session;
}

function editRow(session: ExplorerSession): Extract<
  ReturnType<ExplorerSession["model"]["getRow"]>,
  { kind: "edit" }
> | null {
  for (const row of session.model.getRows()) {
    if (row.kind === "edit") return row;
  }
  return null;
}

beforeEach(() => {
  api = new FilesApiFake();
  script = freshScript();
  parked = null;
});

afterEach(async () => {
  const live = sessions;
  sessions = [];
  await Promise.all(live.map((session) => session.dispose()));
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ *
 * The model's own edit rows
 * ------------------------------------------------------------------ */

describe("the model's edit row", () => {
  function loadedModel(): ExplorerModel {
    const model = new ExplorerModel();
    model.setChildren(null, listingOf([fileNode("a.txt"), directoryNode("dir")]), "replace");
    return model;
  }

  it("a CREATE adds a row and counts itself into the set", () => {
    const model = loadedModel();
    expect(model.openEdit({ intent: "createFile", parentId: null, targetId: null, initialName: "" })).toBe(true);

    const rows = model.getRows();
    expect(rows).toHaveLength(3);
    const edit = rows[2];
    expect(edit?.kind).toBe("edit");
    // A screen reader hearing "2 of 2" while a third row is under the cursor
    // has been told something false about the list it is in.
    expect(edit?.setSize).toBe(3);
    expect(edit?.posInSet).toBe(3);
  });

  it("a RENAME replaces the row it names, so the tree does not grow", () => {
    const model = loadedModel();
    const target = model.getRows()[0];
    expect(target?.kind).toBe("node");
    if (target?.kind !== "node") return;

    model.openEdit({
      intent: "rename",
      parentId: null,
      targetId: target.id,
      initialName: target.node.name,
    });

    const rows = model.getRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe("edit");
    // It sits exactly where the row it replaced sat.
    expect(rows[0]?.posInSet).toBe(1);
    expect(rows[0]?.setSize).toBe(2);
  });

  it("keeps ONE edit: opening a second closes the first", () => {
    const model = loadedModel();
    model.openEdit({ intent: "createFile", parentId: null, targetId: null, initialName: "" });
    const dir = model.getRows()[1];
    if (dir?.kind !== "node") throw new Error("expected the directory row");
    model.expand(dir.id);
    model.setChildren(dir.id, listingOf([]), "replace");
    model.openEdit({ intent: "createFolder", parentId: dir.id, targetId: null, initialName: "" });

    expect(model.getRows().filter((row) => row.kind === "edit")).toHaveLength(1);
  });

  it("REFUSES to open a create inside a folder that has never been listed", () => {
    // An edit row would be the only row in it, which reads as "this folder is
    // empty" about a folder nobody has looked in.
    const model = loadedModel();
    const dir = model.getRows()[1];
    if (dir?.kind !== "node") throw new Error("expected the directory row");
    expect(
      model.openEdit({ intent: "createFile", parentId: dir.id, targetId: null, initialName: "" }),
    ).toBe(false);
  });

  it("CLOSES an edit whose target the tree removed underneath it", () => {
    // A rename box editing a node that is no longer in the tree would commit
    // against a row nothing can find.
    const model = loadedModel();
    const target = model.getRows()[0];
    if (target?.kind !== "node") throw new Error("expected a node row");
    model.openEdit({ intent: "rename", parentId: null, targetId: target.id, initialName: "a.txt" });
    expect(model.getEdit()).not.toBeNull();

    model.removeNode(target.id);
    expect(model.getEdit()).toBeNull();
    expect(model.getRows().some((row) => row.kind === "edit")).toBe(false);
  });

  it("REFUSES the optimistic insert into a PAGED directory", () => {
    // Order is main's: appending into an incomplete listing would put the row
    // on a page it may not belong to and desynchronise the cursor's arithmetic.
    const model = new ExplorerModel();
    model.setChildren(
      null,
      { ...listingOf([fileNode("a.txt")]), hasMore: true, nextCursor: "c1", totalCount: 40 },
      "replace",
    );
    expect(model.applyCreatedNode(null, fileNode("z.txt"))).toBe(false);
    expect(model.getRows().some((row) => row.kind === "node" && row.node.name === "z.txt")).toBe(
      false,
    );
  });

  it("MERGES rather than duplicating when the same node is applied twice", () => {
    const model = loadedModel();
    const created = fileNode("new.txt");
    expect(model.applyCreatedNode(null, created)).toBe(true);
    expect(model.applyCreatedNode(null, created)).toBe(true);
    expect(
      model.getRows().filter((row) => row.kind === "node" && row.node.name === "new.txt"),
    ).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Creating
 * ------------------------------------------------------------------ */

describe("creating through the session", () => {
  it("commits the typed name and applies main's own node", async () => {
    const session = await liveSession([fileNode("a.txt")]);
    await session.beginCreate(null, "file");
    expect(editRow(session)).not.toBeNull();

    script.create = { ok: true, data: { ok: true, value: fileNode("new.txt") } };
    await session.commitEdit("new.txt");
    await flush();

    expect(script.calls[0]).toEqual({
      method: "create",
      input: { projectId: "p1", parentNodeId: null, name: "new.txt", kind: "file" },
    });
    // The box is closed and the row is THERE, not in 500 ms.
    expect(editRow(session)).toBeNull();
    expect(
      session.model.getRows().some((row) => row.kind === "node" && row.node.name === "new.txt"),
    ).toBe(true);
  });

  it("sends kind directory for a folder", async () => {
    const session = await liveSession();
    await session.beginCreate(null, "directory");
    script.create = { ok: true, data: { ok: true, value: directoryNode("lib") } };
    await session.commitEdit("lib");
    await flush();
    expect(script.calls[0]?.input).toMatchObject({ kind: "directory", name: "lib" });
  });

  it("REFUSES an invalid name WITHOUT calling main, and keeps the box open", async () => {
    const session = await liveSession();
    await session.beginCreate(null, "file");

    await session.commitEdit("a/b.txt");

    expect(script.calls).toEqual([]);
    const row = editRow(session);
    expect(row).not.toBeNull();
    expect(row?.message).toContain("slash");
  });

  it("REOPENS the box with main's reason when the create is refused", async () => {
    const session = await liveSession();
    await session.beginCreate(null, "file");
    script.create = { ok: true, data: { ok: false, code: "name_exists" } };

    await session.commitEdit("taken.txt");
    await flush();

    const row = editRow(session);
    // The error is the ROW's own state: the sentence sits beside the name that
    // caused it, and the typed name is still there to fix.
    expect(row).not.toBeNull();
    expect(row?.submitting).toBe(false);
    expect(row?.message).toContain("already here");
  });

  it("reports a transport failure on the row rather than swallowing it", async () => {
    const session = await liveSession();
    await session.beginCreate(null, "file");
    script.create = {
      ok: false,
      error: {
        code: "internal.contract_violation",
        domain: "studio",
        message: "x",
        retryable: false,
        userActionable: false,
        redacted: true,
        correlationId: "req-1",
      },
    };

    await session.commitEdit("x.txt");
    await flush();
    expect(editRow(session)?.message).toContain("could not reach");
  });

  it("says so when the user CANCELLED, and does not claim a failure", async () => {
    const session = await liveSession();
    await session.beginCreate(null, "file");
    script.create = {
      ok: false,
      error: {
        code: "internal.cancelled",
        domain: "studio",
        message: "x",
        retryable: false,
        userActionable: false,
        redacted: true,
        correlationId: "req-1",
      },
    };

    await session.commitEdit("x.txt");
    await flush();
    expect(editRow(session)?.message).toContain("cancelled");
    expect(editRow(session)?.message).toContain("Nothing was written");
  });

  it("DROPS a commit whose session deactivated while it was in flight", async () => {
    const session = await liveSession();
    await session.beginCreate(null, "file");
    script.hold = { resolve: () => undefined };

    const committing = session.commitEdit("late.txt");
    await flush();
    await session.deactivate();
    parked?.resolve({ ok: true, data: { ok: true, value: fileNode("late.txt") } });
    await committing;
    await flush();

    // No name box reopened over a tree nobody is looking at, and no row applied
    // to a model the user has navigated away from.
    expect(editRow(session)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Renaming
 * ------------------------------------------------------------------ */

describe("renaming through the session", () => {
  async function sessionWithFile(): Promise<{
    readonly session: ExplorerSession;
    readonly nodeId: string;
  }> {
    const node = fileNode("old.txt");
    const session = await liveSession([node]);
    return { session, nodeId: node.nodeId };
  }

  it("seeds the box with the current name and commits a new one", async () => {
    const { session, nodeId } = await sessionWithFile();
    expect(session.beginRename(nodeId)).toBe(true);
    expect(editRow(session)?.initialName).toBe("old.txt");

    script.rename = { ok: true, data: { ok: true, value: fileNode("new.txt") } };
    await session.commitEdit("new.txt");
    await flush();

    expect(script.calls[0]).toEqual({
      method: "rename",
      input: { projectId: "p1", nodeId, name: "new.txt" },
    });
    const names = session.model
      .getRows()
      .flatMap((row) => (row.kind === "node" ? [row.node.name] : []));
    // The rename is a REMOVE plus an INSERT, because the token is derived from
    // the path: the old row is gone and the new one is there.
    expect(names).toEqual(["new.txt"]);
  });

  it("marks the row PENDING while the rename is in flight, and clears it on refusal", async () => {
    const { session, nodeId } = await sessionWithFile();
    session.beginRename(nodeId);
    script.hold = { resolve: () => undefined };

    const committing = session.commitEdit("new.txt");
    await flush();
    expect(session.model.nodeOf(nodeId)).not.toBeNull();
    expect(editRow(session)?.submitting).toBe(true);

    parked?.resolve({ ok: true, data: { ok: false, code: "write_denied" } });
    await committing;
    await flush();

    // The row keeps its name and its place; only the message is new.
    expect(session.model.nodeOf(nodeId)?.name).toBe("old.txt");
    expect(editRow(session)?.message).toContain("permissions");
  });

  /**
   * THE TAB FOLLOWS THE FILE, and the announcement is made from here because
   * this is the only scope that still holds the path the entry had BEFORE the
   * write. The workspace consumes it (`workspace/file-rename-signal.ts`); what
   * is proved here is that the session says the right thing at the right
   * moment, with main's own node on it.
   */
  it("announces a CONFIRMED rename with the old path and main's new node", async () => {
    useFileRenameSignalStore.getState().clearFileRenameSignal();
    const { session, nodeId } = await sessionWithFile();
    session.beginRename(nodeId);

    script.rename = { ok: true, data: { ok: true, value: fileNode("new.txt") } };
    await session.commitEdit("new.txt");
    await flush();

    const signal = useFileRenameSignalStore.getState().signal;
    expect(signal?.projectId).toBe("p1");
    expect(signal?.fromRelativePath).toBe("old.txt");
    expect(signal?.to).toEqual({
      title: "new.txt",
      relativePath: "new.txt",
      nodeId: fileNode("new.txt").nodeId,
    });
  });

  it("announces NOTHING when the rename was refused", async () => {
    useFileRenameSignalStore.getState().clearFileRenameSignal();
    const { session, nodeId } = await sessionWithFile();
    session.beginRename(nodeId);

    script.rename = { ok: true, data: { ok: false, code: "write_denied" } };
    await session.commitEdit("new.txt");
    await flush();

    // Nothing was renamed, so a tab retargeted on this would point at a path
    // that does not exist.
    expect(useFileRenameSignalStore.getState().signal).toBeNull();
  });

  it("announces nothing for a CREATE, which renames no tab", async () => {
    useFileRenameSignalStore.getState().clearFileRenameSignal();
    const session = await liveSession([]);
    await session.beginCreate(null, "file");

    script.create = { ok: true, data: { ok: true, value: fileNode("fresh.txt") } };
    await session.commitEdit("fresh.txt");
    await flush();

    expect(useFileRenameSignalStore.getState().signal).toBeNull();
  });

  it("CLOSES without a round trip when the name did not change", async () => {
    const { session, nodeId } = await sessionWithFile();
    session.beginRename(nodeId);

    await session.commitEdit("old.txt");
    await flush();

    // A write and an approval-shaped round trip to do nothing.
    expect(script.calls).toEqual([]);
    expect(editRow(session)).toBeNull();
  });

  it("validates against SIBLINGS before main is asked", async () => {
    const session = await liveSession([fileNode("a.txt"), fileNode("b.txt")]);
    const target = session.model.getRows()[0];
    if (target?.kind !== "node") throw new Error("expected a node row");
    session.beginRename(target.id);

    // The optimistic check: exact for a fully loaded directory, and never
    // stricter than main, which checks the disk.
    expect(session.validateEditName("b.txt")).toContain("already here");
    expect(session.validateEditName("a.txt")).toBeNull();
    expect(session.validateEditName("c.txt")).toBeNull();
  });

  it("a watcher event for the same path arriving FIRST leaves one row", async () => {
    const { session, nodeId } = await sessionWithFile();
    session.beginRename(nodeId);
    const renamed = fileNode("new.txt");
    script.hold = { resolve: () => undefined };
    const committing = session.commitEdit("new.txt");
    await flush();

    // The watcher saw the rename before the IPC answer came back, and the
    // refresh it triggers re-lists the folder with the new entry already in it.
    api.listResponder = () => ({
      ok: true,
      data: { ok: true, value: listingOf([renamed]) },
    });
    api.emit(changedEvent([{ path: "new.txt", kind: "added" }]));
    await flush();

    parked?.resolve({ ok: true, data: { ok: true, value: renamed } });
    await committing;
    await flush();

    const names = session.model
      .getRows()
      .flatMap((row) => (row.kind === "node" ? [row.node.name] : []));
    expect(names).toEqual(["new.txt"]);
  });
});

/* ------------------------------------------------------------------ *
 * Deleting
 * ------------------------------------------------------------------ */

describe("deleting through the session", () => {
  it("removes the row NOW and reports what happened", async () => {
    const node = fileNode("gone.txt");
    const session = await liveSession([node]);

    const outcome = await session.deleteNode(node.nodeId, "trash");
    await flush();

    expect(outcome).toEqual({
      ok: true,
      value: { path: "gone.txt", disposition: "trash", kind: "file" },
    });
    expect(script.calls[0]?.input).toMatchObject({ mode: "trash" });
    expect(session.model.getRows().some((row) => row.kind === "node")).toBe(false);
  });

  it("KEEPS the row when the delete is refused, and hands back the code", async () => {
    const node = fileNode("safe.txt");
    const session = await liveSession([node]);
    script.delete = { ok: true, data: { ok: false, code: "trash_unavailable" } };

    const outcome = await session.deleteNode(node.nodeId, "trash");
    await flush();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The CODE reaches the caller, because the dialog's whole second decision
    // depends on telling `trash_unavailable` from every other refusal.
    expect(outcome.code).toBe("trash_unavailable");
    expect(outcome.message).toContain("no trash");
    // The entry is still on screen, because it is still on disk.
    expect(session.model.nodeOf(node.nodeId)).not.toBeNull();
    expect(session.model.getRows().some((row) => row.kind === "node")).toBe(true);
  });

  it("marks the row pending while the delete is in flight", async () => {
    const node = fileNode("slow.txt");
    const session = await liveSession([node]);
    script.hold = { resolve: () => undefined };

    const deleting = session.deleteNode(node.nodeId, "permanent");
    await flush();
    const row = session.model.getRows().find((entry) => entry.kind === "node");
    expect(row?.kind === "node" ? row.pending : null).toBe("deleting");

    parked?.resolve(script.delete);
    await deleting;
    await flush();
  });

  it("deletes a DIRECTORY with its children, and the subtree goes with the row", async () => {
    const dir = directoryNode("tree");
    const session = await liveSession([dir]);
    // The responder is replaced BEFORE the expand: the listing is enqueued
    // synchronously, so a responder installed afterwards answers nothing.
    api.listResponder = (call) => ({
      ok: true,
      data: {
        ok: true,
        value: listingOf(
          call.nodeId === null ? [dir] : [fileNode("leaf.txt", "tree/leaf.txt")],
        ),
      },
    });
    session.expand(dir.nodeId);
    await flush();
    expect(session.model.nodeCount()).toBe(2);

    script.delete = {
      ok: true,
      data: { ok: true, value: { path: "tree", disposition: "permanent", kind: "directory" } },
    };
    await session.deleteNode(dir.nodeId, "permanent");
    await flush();

    // The whole subtree is purged, not just the row: a leaked descendant is
    // exactly the leak `nodeCount` exists to prove closed.
    expect(session.model.nodeCount()).toBe(0);
  });

  it("does not report onto a tree that was cleared while the delete was in flight", async () => {
    const node = fileNode("doomed.txt");
    const session = await liveSession([node]);
    script.hold = { resolve: () => undefined };

    const deleting = session.deleteNode(node.nodeId, "trash");
    await flush();
    await session.deactivate();
    parked?.resolve(script.delete);

    const outcome = await deleting;
    expect(outcome.ok).toBe(false);
  });
});
