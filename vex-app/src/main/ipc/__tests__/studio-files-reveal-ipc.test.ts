/**
 * THE REVEAL CHANNEL AT THE IPC BOUNDARY.
 *
 * `files-real-fs.test.ts` proves what a reveal DOES against a real temporary
 * project - which paths resolve, which are refused, and that the desktop is
 * only ever handed a path this process derived. This proves what the BOUNDARY
 * does around it, which is the half that carries the trust decision: an
 * untrusted sender is refused before the domain is reached, an off-contract
 * payload never becomes a resolution, no caller can smuggle a path through a
 * field, and the outcome that comes back is the one the schema promised.
 *
 * The domain is faked here ON PURPOSE, exactly as the write-channel suite fakes
 * it: what is under test is the wrapper, and a test that drove a real
 * filesystem through it could not tell a refusal made at the boundary from one
 * made inside the domain.
 *
 * CANCELLATION IS NOT APPLICABLE HERE, and the suite says so with an assertion
 * rather than with silence: the handler passes no signal, because the work is
 * one resolution followed by a synchronous platform call with no cancellable
 * window. A signal on this input would advertise a cancellation that could
 * never be honoured. The generic abort contract still applies through
 * `registerHandler` and is asserted below.
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

/** Everything the faked domain was asked to reveal, in order. */
const calls: unknown[] = [];
/** What the faked domain answers next. */
let answer: unknown = { ok: true, value: null };

vi.mock("../../studio/files/files-composition.js", () => ({
  filesDomain: () => ({
    listChildren: vi.fn(),
    readFile: vi.fn(),
    watchFile: vi.fn(),
    unwatchFile: vi.fn(),
    ackEvent: vi.fn(),
    createNode: vi.fn(),
    renameNode: vi.fn(),
    deleteNode: vi.fn(),
    revealInFileManager: (input: unknown) => {
      calls.push(input);
      return answer instanceof Promise ? answer : Promise.resolve(answer);
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

/** A trusted top-level frame. */
function trusted(): unknown {
  return { ...senderFrame("app://vex/index.html"), sender: { id: 7 } };
}

const CHANNEL = "vex:files:revealInFileManager";
/** A token shaped like a real one. Its contents are the domain's business. */
const NODE = "f1.dG9rZW4.c2ln";
const PROJECT = "11111111-2222-3333-4444-555555555555";

type HandlerResult =
  | { readonly ok: true; readonly data: unknown }
  | {
    readonly ok: false;
    readonly error: { readonly code: string; readonly redacted: boolean };
  };

async function invoke(
  payload: unknown,
  event = trusted(),
): Promise<HandlerResult> {
  const fn = handlers.get(CHANNEL);
  if (fn === undefined) throw new Error(`no handler for ${CHANNEL}`);
  return (await fn(event, { requestId: "req-1", payload })) as HandlerResult;
}

function refusalOf(result: HandlerResult): {
  readonly code: string;
  readonly redacted: boolean;
} {
  if (result.ok) throw new Error("expected a refusal, got a successful Result");
  return result.error;
}

beforeEach(async () => {
  calls.length = 0;
  answer = { ok: true, value: null };
  cleanupTasks.clear();
  handlers.clear();
  vi.resetModules();
  const mod = await import("../studio-files.js");
  mod.registerStudioFilesHandlers();
});

afterEach(() => {
  handlers.clear();
  cleanupTasks.clear();
});

describe("registration", () => {
  it("registers the reveal channel alongside the rest of the surface", () => {
    expect(handlers.has(CHANNEL)).toBe(true);
  });
});

describe("positive path", () => {
  it("passes the project and node through and answers the outcome the schema promises", async () => {
    const result = await invoke({ projectId: PROJECT, nodeId: NODE });

    expect(result).toEqual({ ok: true, data: { ok: true, value: null } });
    // EXACTLY the two fields, and nothing this handler invented.
    expect(calls).toEqual([{ projectId: PROJECT, nodeId: NODE }]);
  });

  it("carries a REFUSAL as a successful Result with a discriminated outcome", async () => {
    // "That file is gone" is an answer about the file, not a failure of Vex,
    // and the viewer renders it as a sentence.
    answer = { ok: false, code: "not_found" };
    const result = await invoke({ projectId: PROJECT, nodeId: NODE });
    expect(result).toEqual({ ok: true, data: { ok: false, code: "not_found" } });
  });
});

describe("unauthorized sender", () => {
  it("refuses an untrusted frame BEFORE the domain is reached", async () => {
    const result = await invoke(
      { projectId: PROJECT, nodeId: NODE },
      { ...senderFrame("https://evil.example/"), sender: { id: 7 } },
    );

    const error = refusalOf(result);
    expect(error.code).toBe("validation.invalid_sender");
    expect(error.redacted).toBe(true);
    // THE SIDE EFFECT THAT MUST NOT HAPPEN: nothing reached the domain, so
    // nothing could have reached the desktop.
    expect(calls).toEqual([]);
  });

  it("refuses a subframe, which is the other half of sender validation", async () => {
    const top: MockFrame = { url: "app://vex/index.html", parent: null, top: null };
    const child: MockFrame = { url: "app://vex/index.html", parent: top, top };
    const result = await invoke(
      { projectId: PROJECT, nodeId: NODE },
      { senderFrame: child, sender: { id: 7 } },
    );
    expect(refusalOf(result).code).toBe("validation.invalid_sender");
    expect(calls).toEqual([]);
  });
});

describe("invalid input", () => {
  it("refuses a request with no node, so nothing defaults to the project root", async () => {
    const result = await invoke({ projectId: PROJECT });
    expect(refusalOf(result).code).toBe("validation.invalid_input");
    expect(calls).toEqual([]);
  });

  it("refuses a null node, which no other read on this surface accepts either", async () => {
    const result = await invoke({ projectId: PROJECT, nodeId: null });
    expect(refusalOf(result).code).toBe("validation.invalid_input");
    expect(calls).toEqual([]);
  });

  it("refuses an empty project id, which addresses nothing", async () => {
    const result = await invoke({ projectId: "", nodeId: NODE });
    expect(refusalOf(result).code).toBe("validation.invalid_input");
    expect(calls).toEqual([]);
  });

  /**
   * VALIDATION IS NOT AUTHORIZATION, and this pins which layer owns which.
   *
   * A project id on this surface is an OPAQUE key, not a path fragment:
   * `filesProjectIdSchema` bounds its length and says nothing about its shape,
   * so a path-looking id is well-formed input and reaches the domain intact.
   * It is refused THERE, by the active-row lookup that no string check could
   * stand in for - `files-real-fs.test.ts` proves that refusal against a real
   * filesystem. A boundary that rejected this string instead would look like
   * containment while providing none: the id never becomes a path component.
   */
  it("hands a path-SHAPED project id to the domain unchanged, because shape is not authority", async () => {
    answer = { ok: false, code: "project_closed" };
    const result = await invoke({ projectId: "../../etc", nodeId: NODE });
    expect(result).toEqual({ ok: true, data: { ok: false, code: "project_closed" } });
    expect(calls).toEqual([{ projectId: "../../etc", nodeId: NODE }]);
  });

  it("REFUSES A PATH BY NAME rather than dropping it", async () => {
    // The whole design of this surface is that no request carries a path.
    // `.strict()` is what stops a caller smuggling one past a later version
    // that starts reading the field.
    const result = await invoke({
      projectId: PROJECT,
      nodeId: NODE,
      absolutePath: "/etc/passwd",
    });
    expect(refusalOf(result).code).toBe("validation.invalid_input");
    expect(calls).toEqual([]);
  });
});

describe("invalid output", () => {
  it("refuses to forward an outcome the schema does not describe", async () => {
    // Defence in depth: a domain bug that produced a wrong shape must not reach
    // the renderer as though it were a contract-shaped answer.
    answer = { ok: true, value: { absolutePath: "/home/someone/project/a.ts" } };
    const result = await invoke({ projectId: PROJECT, nodeId: NODE });
    expect(refusalOf(result).code).toBe("internal.contract_violation");
  });
});

describe("cancellation", () => {
  it("hands the domain NO signal, because there is no cancellable window", async () => {
    await invoke({ projectId: PROJECT, nodeId: NODE });
    expect(calls[0]).not.toHaveProperty("signal");
  });

  it("still normalises an abort into the one cancellation contract", async () => {
    // Nothing in the reveal path raises this today; the assertion pins that the
    // channel is wrapped by the same handler contract as every other, so a
    // future abort cannot become a second cancellation vocabulary.
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    answer = Promise.reject(aborted);
    const result = await invoke({ projectId: PROJECT, nodeId: NODE });
    expect(refusalOf(result).code).toBe("internal.cancelled");
  });
});
