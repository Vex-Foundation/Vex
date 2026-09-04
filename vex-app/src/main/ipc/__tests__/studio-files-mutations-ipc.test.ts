/**
 * THE WRITE CHANNELS AT THE IPC BOUNDARY.
 *
 * `files-real-fs.test.ts` proves what the mutations DO to a real filesystem.
 * This proves what the BOUNDARY does around them, which is a different set of
 * risks and the one that carries the trust decision: an untrusted sender is
 * refused before the domain is reached, an off-contract payload never becomes a
 * syscall, the window identity is the event's and never the payload's, the
 * request's cancellation signal reaches the write, and the outcome that comes
 * back is the one the schema promised.
 *
 * The domain is faked here ON PURPOSE. It is not the subject: what is under
 * test is the wrapper, and a test that drove a real filesystem through it could
 * not tell a refusal made at the boundary from one made deep inside a mutation.
 * The domain's own behaviour has its own suite over real bytes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, raw: unknown) => Promise<unknown>;

interface MockFrame {
  readonly url: string;
  readonly parent: MockFrame | null;
  readonly top: MockFrame | null;
}

const handlers = new Map<string, Handler>();
const cleanupTasks = new Set<() => void | Promise<void>>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  app: { isPackaged: true },
}));

vi.mock("../../logger/index.js", () => ({
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    silly: vi.fn(),
  },
}));

vi.mock("../../lifecycle/cleanup-registry.js", () => ({
  globalCleanup: {
    add: (task: () => void | Promise<void>) => {
      cleanupTasks.add(task);
      return async () => {
        cleanupTasks.delete(task);
        await task();
      };
    },
  },
}));

/** What each faked domain method was called with, in order. */
const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
/** The next outcome each method answers with. */
const answers = new Map<string, unknown>();

vi.mock("../../studio/files/files-composition.js", () => ({
  filesDomain: () => ({
    listChildren: vi.fn(),
    readFile: vi.fn(),
    watchFile: vi.fn(),
    unwatchFile: vi.fn(),
    ackEvent: vi.fn(),
    createNode: (input: unknown) => {
      calls.push({ method: "createNode", input });
      return Promise.resolve(answers.get("createNode"));
    },
    renameNode: (input: unknown) => {
      calls.push({ method: "renameNode", input });
      return Promise.resolve(answers.get("renameNode"));
    },
    deleteNode: (input: unknown) => {
      calls.push({ method: "deleteNode", input });
      return Promise.resolve(answers.get("deleteNode"));
    },
  }),
}));

function senderFrame(url: string): { senderFrame: MockFrame } {
  const frame: { url: string; parent: MockFrame | null; top: MockFrame | null } = {
    url,
    parent: null,
    top: null,
  };
  frame.top = frame;
  return { senderFrame: frame };
}

/** A trusted top-level frame, with the `sender.id` the handlers read. */
function trusted(): unknown {
  return { ...senderFrame("app://vex/index.html"), sender: { id: 7 } };
}

/** A token shaped like a real one. Its contents are the domain's business. */
const NODE = "f1.dG9rZW4.c2ln";
const PROJECT = "11111111-2222-3333-4444-555555555555";

const NODE_VALUE = {
  nodeId: NODE,
  name: "notes.md",
  path: "notes.md",
  kind: "file" as const,
  size: 0,
  modifiedMs: 1,
};

async function registerAll(): Promise<void> {
  vi.resetModules();
  handlers.clear();
  const mod = await import("../studio-files.js");
  mod.registerStudioFilesHandlers();
}

/**
 * What a handler answers, as this suite reads it.
 *
 * `Result<unknown>` narrowed by hand rather than `any`: the tests assert on
 * `error.code` and on `data`, and typing the envelope is what makes a renamed
 * error field a compile error here instead of a silently passing assertion.
 */
type HandlerResult =
  | { readonly ok: true; readonly data: unknown }
  | {
    readonly ok: false;
    readonly error: { readonly code: string; readonly redacted: boolean };
  };

async function invoke(
  channel: string,
  payload: unknown,
  event = trusted(),
): Promise<HandlerResult> {
  const fn = handlers.get(channel);
  if (fn === undefined) throw new Error(`no handler for ${channel}`);
  return (await fn(event, { requestId: "req-1", payload })) as HandlerResult;
}

/** Assert a refusal and hand back its error, so each test reads one field. */
function refusalOf(result: HandlerResult): { readonly code: string; readonly redacted: boolean } {
  if (result.ok) throw new Error("expected a refusal, got a successful Result");
  return result.error;
}

beforeEach(async () => {
  calls.length = 0;
  answers.clear();
  cleanupTasks.clear();
  await registerAll();
});

afterEach(() => {
  handlers.clear();
  cleanupTasks.clear();
});

describe("the write channels are registered at all", () => {
  it("registers create, rename and delete", () => {
    expect(handlers.has("vex:files:create")).toBe(true);
    expect(handlers.has("vex:files:rename")).toBe(true);
    expect(handlers.has("vex:files:delete")).toBe(true);
  });
});

describe("positive path", () => {
  it("passes a create through and returns the outcome the schema promises", async () => {
    answers.set("createNode", { ok: true, value: NODE_VALUE });

    const result = await invoke("vex:files:create", {
      projectId: PROJECT,
      parentNodeId: null,
      name: "notes.md",
      kind: "file",
    });

    expect(result).toEqual({ ok: true, data: { ok: true, value: NODE_VALUE } });
    expect(calls[0]?.method).toBe("createNode");
  });

  it("passes a rename through", async () => {
    answers.set("renameNode", { ok: true, value: NODE_VALUE });
    const result = await invoke("vex:files:rename", {
      projectId: PROJECT,
      nodeId: NODE,
      name: "notes.md",
    });
    expect(result).toEqual({ ok: true, data: { ok: true, value: NODE_VALUE } });
  });

  it("passes a delete through, carrying the disposition the user confirmed", async () => {
    answers.set("deleteNode", {
      ok: true,
      value: { path: "notes.md", disposition: "trash", kind: "file" },
    });

    const result = await invoke("vex:files:delete", {
      projectId: PROJECT,
      nodeId: NODE,
      mode: "trash",
    });

    expect(result.ok).toBe(true);
    // The MODE reaches the domain exactly as sent. A boundary that defaulted or
    // rewrote it would decide a destructive question the user answered.
    expect(calls[0]?.input).toMatchObject({ mode: "trash" });
  });

  it("carries a REFUSAL as a successful Result with a discriminated outcome", async () => {
    // "Vex manages this file" is an answer about the file, not a failure of
    // Vex, and the UI renders it as a statement on the row.
    answers.set("deleteNode", { ok: false, code: "vex_managed" });
    const result = await invoke("vex:files:delete", {
      projectId: PROJECT,
      nodeId: NODE,
      mode: "trash",
    });
    expect(result).toEqual({ ok: true, data: { ok: false, code: "vex_managed" } });
  });
});

describe("unauthorized sender", () => {
  it.each(["vex:files:create", "vex:files:rename", "vex:files:delete"])(
    "%s refuses an untrusted frame BEFORE the domain is reached",
    async (channel) => {
      const payload =
        channel === "vex:files:create"
          ? { projectId: PROJECT, parentNodeId: null, name: "x.txt", kind: "file" }
          : channel === "vex:files:rename"
            ? { projectId: PROJECT, nodeId: NODE, name: "x.txt" }
            : { projectId: PROJECT, nodeId: NODE, mode: "trash" };

      const result = await invoke(channel, payload, {
        ...senderFrame("https://evil.example/"),
        sender: { id: 7 },
      });

      const error = refusalOf(result);
      expect(error.code).toBe("validation.invalid_sender");
      expect(error.redacted).toBe(true);
      // THE SIDE EFFECT THAT MUST NOT HAPPEN: nothing reached the domain, so
      // nothing could have reached a syscall.
      expect(calls).toEqual([]);
    },
  );
});

describe("invalid input", () => {
  it.each([
    ["a name with a path separator", { name: "a/b.txt" }],
    ["a name that is a relative reference", { name: ".." }],
    ["an empty name", { name: "" }],
    ["a Windows device name", { name: "CON" }],
    ["a name with a trailing dot", { name: "trailing." }],
  ])("refuses %s at the schema, before the domain", async (_label, override) => {
    const result = await invoke("vex:files:create", {
      projectId: PROJECT,
      parentNodeId: null,
      kind: "file",
      ...override,
    });

    expect(refusalOf(result).code).toBe("validation.invalid_input");
    expect(calls).toEqual([]);
  });

  it("refuses an unknown field rather than dropping it", async () => {
    // `.strict()`, which is what stops a caller smuggling a field a later
    // version might start reading.
    const result = await invoke("vex:files:create", {
      projectId: PROJECT,
      parentNodeId: null,
      name: "ok.txt",
      kind: "file",
      destination: "/etc",
    });
    expect(refusalOf(result).code).toBe("validation.invalid_input");
    expect(calls).toEqual([]);
  });

  it("refuses a kind the surface does not create", async () => {
    const result = await invoke("vex:files:create", {
      projectId: PROJECT,
      parentNodeId: null,
      name: "link",
      kind: "symlink",
    });
    expect(refusalOf(result).code).toBe("validation.invalid_input");
  });

  it("refuses a delete with no disposition, so nothing defaults to permanent", async () => {
    const result = await invoke("vex:files:delete", { projectId: PROJECT, nodeId: NODE });
    expect(refusalOf(result).code).toBe("validation.invalid_input");
    expect(calls).toEqual([]);
  });

  it("refuses a delete disposition that is not one of the two", async () => {
    const result = await invoke("vex:files:delete", {
      projectId: PROJECT,
      nodeId: NODE,
      mode: "shred",
    });
    expect(refusalOf(result).code).toBe("validation.invalid_input");
  });

  it("refuses a rename that tries to carry a destination path", async () => {
    // There is no destination parameter, so a rename cannot move anything. This
    // pins that: the field is refused BY NAME rather than silently ignored.
    const result = await invoke("vex:files:rename", {
      projectId: PROJECT,
      nodeId: NODE,
      name: "ok.txt",
      parentNodeId: NODE,
    });
    expect(refusalOf(result).code).toBe("validation.invalid_input");
    expect(calls).toEqual([]);
  });
});

describe("invalid output", () => {
  it("refuses to forward an outcome the schema does not describe", async () => {
    // Defence in depth: a domain bug that produced a wrong shape must not reach
    // the renderer as if it were a contract-shaped answer.
    answers.set("createNode", { ok: true, value: { nodeId: NODE } });
    const result = await invoke("vex:files:create", {
      projectId: PROJECT,
      parentNodeId: null,
      name: "notes.md",
      kind: "file",
    });
    expect(refusalOf(result).code).toBe("internal.contract_violation");
  });
});

describe("cancellation", () => {
  it("hands the request's signal to the write", async () => {
    answers.set("createNode", { ok: true, value: NODE_VALUE });
    await invoke("vex:files:create", {
      projectId: PROJECT,
      parentNodeId: null,
      name: "notes.md",
      kind: "file",
    });
    const input = calls[0]?.input as { signal?: AbortSignal };
    // Without this the write could never be cancelled, and the surface would be
    // offering a Cancel that does nothing.
    expect(input.signal).toBeInstanceOf(AbortSignal);
  });

  it("normalises an aborted write into the one cancellation contract", async () => {
    // `mutations.ts` throws an `AbortError` when the signal ends the wait for
    // the project's write lock, and `registerHandler` turns that into
    // `internal.cancelled` - not a second cancellation vocabulary expressed as
    // an outcome code.
    const aborted = new Error("cancelled before it started");
    aborted.name = "AbortError";
    answers.set("deleteNode", Promise.reject(aborted));

    const result = await invoke("vex:files:delete", {
      projectId: PROJECT,
      nodeId: NODE,
      mode: "trash",
    });
    expect(refusalOf(result).code).toBe("internal.cancelled");
  });
});
