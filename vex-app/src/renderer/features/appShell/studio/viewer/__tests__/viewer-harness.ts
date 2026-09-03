/**
 * Shared scaffolding for the file-viewer suites.
 *
 * Two pieces, and each exists because the thing it stands in for cannot run
 * under the test runtime OR cannot be driven finely enough to observe a fence:
 *
 *  - {@link FakeHighlighterPort} HOLDS every request until the test answers it.
 *    A port that resolved immediately could never show a stale result being
 *    dropped, because the result would land before anything could go stale.
 *  - {@link FileApiFake} answers `readProjectFile` and can hold a read open for
 *    the same reason, plus reject one, which is the transport failure a
 *    `FilesOutcome` cannot express.
 */

import type { FileContent, FilesErrorCode, FilesOutcome } from "@shared/schemas/files.js";
import type { Result } from "@shared/ipc/result.js";
import { settledHandle } from "../highlight/highlighter-port.js";
import type {
  HighlightAsk,
  HighlighterPort,
  HighlightHandle,
  HighlightOutcome,
  HighlightUnavailableReason,
} from "../highlight/highlighter-port.js";
import type { TokenLine } from "../highlight/highlight-protocol.js";

/* ------------------------------------------------------------------ *
 * The highlighter
 * ------------------------------------------------------------------ */

interface HeldHighlight {
  readonly ask: HighlightAsk;
  readonly settle: (outcome: HighlightOutcome) => void;
  cancelled: boolean;
}

/** What a test says about the per-line highlighting clock, if anything. */
export interface BudgetReport {
  /** 1-based line numbers that stopped early, ascending. */
  readonly lines?: readonly number[];
  /** The exact count. Defaults to `lines.length`; pass it to exceed the list. */
  readonly total?: number;
}

function resolveBudget(budget: BudgetReport): {
  readonly budgetExceededLines: readonly number[];
  readonly budgetExceededTotal: number;
} {
  const lines = budget.lines ?? [];
  return {
    budgetExceededLines: lines,
    budgetExceededTotal: budget.total ?? lines.length,
  };
}

export class FakeHighlighterPort implements HighlighterPort {
  readonly asks: HighlightAsk[] = [];
  readonly held: HeldHighlight[] = [];
  /** The asks whose handle was cancelled, oldest first. The observable half. */
  readonly cancelledAsks: HighlightAsk[] = [];
  disposals = 0;

  /** When false, every request resolves at once with {@link autoOutcome}. */
  manual = true;
  autoOutcome: HighlightOutcome = {
    ok: true,
    lines: [],
    longLines: 0,
    budgetExceededLines: [],
    budgetExceededTotal: 0,
  };

  highlight(ask: HighlightAsk): HighlightHandle {
    this.asks.push(ask);
    if (!this.manual) return settledHandle(this.autoOutcome);

    let settle: (outcome: HighlightOutcome) => void = () => undefined;
    const outcome = new Promise<HighlightOutcome>((resolve) => {
      settle = resolve;
    });
    const entry: HeldHighlight = { ask, settle, cancelled: false };
    this.held.push(entry);
    return {
      outcome,
      cancel: () => {
        if (entry.cancelled) return;
        entry.cancelled = true;
        this.cancelledAsks.push(ask);
        const at = this.held.indexOf(entry);
        if (at !== -1) this.held.splice(at, 1);
        // The real port settles a cancelled request rather than leaving its
        // promise pending forever; a fake that did not would hide a leak.
        settle({ ok: false, reason: "cancelled" });
      },
    };
  }

  dispose(): void {
    this.disposals += 1;
  }

  /**
   * Answer the OLDEST outstanding request with tokens.
   *
   * `budget` carries the per-line clock's verdict, defaulting to "no line ran
   * out" so the many callers that are not about that bound stay unchanged. Its
   * `total` defaults to the length of its `lines`, which is the shape the real
   * worker produces below the fifty-number list bound; a caller proving the
   * bound passes both and makes them differ on purpose.
   */
  settleOldest(lines: readonly TokenLine[] = [], longLines = 0, budget: BudgetReport = {}): void {
    this.#take().settle({ ok: true, lines, longLines, ...resolveBudget(budget) });
  }

  /** Answer the NEWEST outstanding request, so a stale one can be left behind. */
  settleNewest(lines: readonly TokenLine[] = [], longLines = 0, budget: BudgetReport = {}): void {
    const held = this.held.pop();
    if (held === undefined) throw new Error("no highlight is in flight");
    held.settle({ ok: true, lines, longLines, ...resolveBudget(budget) });
  }

  failOldest(reason: HighlightUnavailableReason): void {
    this.#take().settle({ ok: false, reason });
  }

  #take(): HeldHighlight {
    const held = this.held.shift();
    if (held === undefined) throw new Error("no highlight is in flight");
    return held;
  }
}

/* ------------------------------------------------------------------ *
 * The files API
 * ------------------------------------------------------------------ */

interface HeldRead {
  readonly settle: (result: Result<FilesOutcome<FileContent>>) => void;
  readonly fail: (error: unknown) => void;
}

export class FileApiFake {
  readonly readCalls: { projectId: string; nodeId: string }[] = [];
  readonly held: HeldRead[] = [];

  /** When true, a read does not resolve until the test settles it. */
  manual = false;
  responder: () => Result<FilesOutcome<FileContent>> = () => ok(contentOf("hello\n"));

  get readCount(): number {
    return this.readCalls.length;
  }

  readFile(projectId: string, nodeId: string): Promise<Result<FilesOutcome<FileContent>>> {
    this.readCalls.push({ projectId, nodeId });
    if (!this.manual) return Promise.resolve(this.responder());
    return new Promise((resolve, reject) => {
      this.held.push({ settle: resolve, fail: reject });
    });
  }

  settleNextRead(result?: Result<FilesOutcome<FileContent>>): void {
    this.#take().settle(result ?? this.responder());
  }

  rejectNextRead(error: Error = new Error("the bridge rejected")): void {
    this.#take().fail(error);
  }

  reset(): void {
    this.readCalls.length = 0;
    this.held.length = 0;
    this.manual = false;
  }

  #take(): HeldRead {
    const held = this.held.shift();
    if (held === undefined) throw new Error("no read is in flight");
    return held;
  }
}

/* ------------------------------------------------------------------ *
 * Builders
 * ------------------------------------------------------------------ */

/**
 * A `FileContent`.
 *
 * The hash DEFAULTS to a function of the text, because the session's
 * same-bytes rule is a hash comparison: a fixture with a constant hash would
 * make every reload look unchanged and the rule would pass while doing nothing.
 */
export function contentOf(
  text: string,
  overrides: Partial<FileContent> = {},
): FileContent {
  return {
    nodeId: "node-1",
    path: "src/a.ts",
    text,
    size: text.length,
    modifiedMs: 1,
    hash: `hash:${String(text.length)}:${text.slice(0, 8)}`,
    ...overrides,
  };
}

export function ok(content: FileContent): Result<FilesOutcome<FileContent>> {
  return { ok: true, data: { ok: true, value: content } };
}

/** A typed answer about the file. Never a failure. */
export function refused(
  code: FilesErrorCode,
  size?: number,
): Result<FilesOutcome<FileContent>> {
  return {
    ok: true,
    data: size === undefined ? { ok: false, code } : { ok: false, code, size },
  };
}

/**
 * A call that never got an answer. Distinct from a refusal: retry is real.
 *
 * GENERIC BECAUSE THE FAILURE BRANCH CARRIES NO PAYLOAD. `Result<T>` mentions
 * `T` only on its `ok: true` side, so one envelope is the honest answer for
 * every channel on this surface: the read channel takes the default, and the
 * reveal channel names `FilesOutcome<null>` at the call site. The alternative
 * was a cast at the second caller, which would have asserted a shape rather
 * than stating one.
 */
export function transportFailure<T = FilesOutcome<FileContent>>(): Result<T> {
  return {
    ok: false,
    error: {
      domain: "system",
      code: "internal.unexpected",
      message: "the file service could not be reached",
      retryable: true,
      userActionable: false,
      redacted: true,
      correlationId: "test-correlation",
    },
  };
}
