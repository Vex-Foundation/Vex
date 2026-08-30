/**
 * THE FILE VIEWER SESSION - the lifecycle owner for ONE open file tab.
 *
 * A non-React class, for the reason `explorer-session.ts` is one: it owns a
 * read in flight, a subscription to another session, a timer, and a worker
 * request, and if React owned those then every tab switch would cancel and
 * redo them. The component subscribes to a revision counter and renders; every
 * rule below is testable without a DOM.
 *
 * ## The state machine
 *
 * | state    | entered by                                  | shows                          | content held |
 * |----------|---------------------------------------------|--------------------------------|--------------|
 * | idle     | construction                                | nothing                        | no           |
 * | reading  | `activate`, reload, retry                   | previous content, or a spinner | maybe        |
 * | ready    | a read answered with contents               | the file                       | yes          |
 * | refused  | a read answered with a CODE                 | the refusal, by name           | no           |
 * | failed   | a read never got an answer (transport)      | the failure plus Retry         | no           |
 * | orphaned | `deleted`, re-checked, still `not_found`    | last contents plus a notice    | yes (stale)  |
 * | disposed | `dispose`                                   | nothing                        | no           |
 *
 * A reload keeps whatever it had on screen while it runs: replacing a rendered
 * file with a spinner because a build touched it would make the viewer flicker
 * on every save. `refused` and `failed` DROP the content, because both are
 * statements that the thing on screen is no longer what is on disk.
 *
 * ## The highlight sub-state, and why it is separate
 *
 * | sub-state            | means                                                   |
 * |----------------------|---------------------------------------------------------|
 * | plain                | never attempted, and the reason says why                |
 * | highlighting         | a worker request is outstanding                         |
 * | highlighted          | tokens for the CURRENT content                          |
 * | plain-after-failure  | attempted, failed, and the reason says how              |
 *
 * Two axes, because they fail independently: a file can be perfectly readable
 * with a dead highlighter, and the user needs both facts. Collapsing them would
 * mean either hiding a readable file behind a highlighter error or hiding the
 * highlighter error entirely.
 *
 * ## Publication is fenced by CONTENT identity, not just by generation
 *
 * A highlight result is published only when the hash it was issued for is still
 * the hash on screen AND the session's generation still matches. The hash is
 * what makes the fence correct across a reload: a file saved twice in a second
 * produces two highlight requests, and the first one's tokens describe text
 * nobody is looking at. `dispose` bumps the generation, so a result that lands
 * after teardown publishes nothing at all.
 *
 * ## Following the file is the EXPLORER's subscription, not a second one
 *
 * The session `acquire`s the project's `ExplorerSession` and subscribes its
 * path there. Opening a file starts no new watcher: main already refcounts one
 * native watch per project, and a second `watchFile` per tab would be a second
 * event stream to keep consistent with the first.
 *
 * ## Delete waits before it believes
 *
 * VS Code's `textFileEditorModel.ts:149-190` waits 100 ms on a DELETED event
 * and re-checks existence before declaring a file orphaned, for issue #13665:
 * "users seeing delete events even though the file still exists". Every atomic
 * save - write temp, rename over - produces exactly that event, and a viewer
 * that believed it would flash an orphan banner on every save.
 *
 * ## Epoch: a deleted-and-recreated file is a NEW file to main
 *
 * A node token binds the project's node EPOCH, and a re-read after a
 * delete-and-recreate uses the token this tab was opened with. If main answers
 * `invalid_node`, the viewer shows that answer and the recovery is the
 * explorer's: re-opening the file from the tree adopts the fresh token through
 * `addFileTab`, which is already how the workspace model dedupes by path. This
 * is stated rather than papered over, because the alternative - minting or
 * guessing a token in the renderer - is exactly what the opaque-token design
 * exists to prevent.
 */

import type { FileContent, FilesErrorCode } from "@shared/schemas/files.js";
import { readProjectFile } from "../../../../lib/api/files.js";
import {
  explorerRegistry as sharedExplorerRegistry,
  type ExplorerRegistry,
} from "../explorer/index.js";
import type { WorkspaceFileTab } from "../workspace/types.js";
import type { HighlighterPort } from "./highlight/highlighter-port.js";
import type { TokenLine } from "./highlight/highlight-protocol.js";
import { plainTokenize } from "./highlight/shiki-tokenizer.js";
import {
  languageOfPath,
  PLAIN_LANGUAGE,
  type ViewerLanguageId,
} from "./highlight/language-of-path.js";
import type { PlainReason } from "./viewer-copy.js";

/* ------------------------------------------------------------------ *
 * Bounds, each with its at-bound behaviour
 * ------------------------------------------------------------------ */

/**
 * The largest file this viewer will HIGHLIGHT, in bytes.
 *
 * 512 KiB, a quarter of what main will READ. The two bounds are deliberately
 * different because they protect different things: main's 2 MiB protects the
 * IPC channel and the renderer's memory, this one protects a synchronous
 * tokenization that cannot be interrupted once it starts.
 *
 * AT THE BOUND the file is shown in full, as plain text, and the chip names
 * both the size and the limit. Nothing is truncated and nothing is hidden -
 * the user loses colour, which is the only thing a highlighter provides.
 */
export const VIEWER_HIGHLIGHT_MAX_BYTES = 512 * 1024;

/**
 * The longest line that gets tokenized.
 *
 * VS Code's `editor.maxTokenizationLineLength` default
 * (`editorConfigurationSchema.ts:94-98`), value included: "Lines above this
 * length will not be tokenized for performance reasons". A minified bundle is
 * one line of 400 KB, and a TextMate grammar over it is the pathological case.
 *
 * AT THE BOUND the line is emitted as one unhighlighted token and COUNTED, and
 * the count is on the chip. A bound nobody is told about is a bug.
 */
export const VIEWER_MAX_TOKENIZE_LINE_LENGTH = 20_000;

/**
 * How deep the reload queue goes: one running, one queued.
 *
 * VS Code's model manager caps its reload queue at exactly this
 * (`textFileEditorModelManager.ts:170-186`), and the reasoning transfers
 * directly. A build touching a file fifty times in a second should produce two
 * reads, not fifty: the first is already in flight and every later event asks
 * the same question, so they COALESCE into the one queued read that will run
 * after it. The queued read sees the final state, which is the only state
 * anyone wanted.
 */
export const VIEWER_RELOAD_QUEUE_DEPTH = 2;

/**
 * How long a DELETED event is doubted before the file is called orphaned.
 *
 * VS Code's value and VS Code's reason (see the module note, issue #13665).
 */
export const VIEWER_DELETE_RECHECK_MS = 100;

/**
 * No long-line accounting on the uncoloured split.
 *
 * `plainTokenize` disables its bound at zero or less. Reporting a long-line
 * count for text nobody tried to tokenize would be a bound announcing itself
 * where no bound was applied.
 */
const PLAIN_LINE_BOUND_DISABLED = 0;

/** Stable identity, so a component with nothing to show does not re-render. */
const EMPTY_LINES: readonly TokenLine[] = [];

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

export type FileViewerState =
  | { readonly kind: "idle" }
  | { readonly kind: "reading" }
  | { readonly kind: "ready"; readonly content: FileContent }
  | {
      readonly kind: "refused";
      readonly code: FilesErrorCode;
      /** Present on `too_large`: the file's REAL size, so the UI can say it. */
      readonly size: number | undefined;
    }
  | { readonly kind: "failed" }
  | { readonly kind: "orphaned"; readonly content: FileContent }
  | { readonly kind: "disposed" };

export type HighlightState =
  | { readonly kind: "plain"; readonly reason: PlainReason }
  | { readonly kind: "highlighting" }
  | {
      readonly kind: "highlighted";
      readonly lines: readonly TokenLine[];
      readonly longLines: number;
    }
  | { readonly kind: "plain-after-failure"; readonly reason: PlainReason };

export interface FileViewerSessionOptions {
  readonly projectId: string;
  readonly tab: WorkspaceFileTab;
  /** The shared worker port. Injected so tests need no worker runtime. */
  readonly highlighter: HighlighterPort;
  /** Injected so a suite never touches the window-wide explorer registry. */
  readonly explorers?: ExplorerRegistry;
}

export class FileViewerSession {
  readonly projectId: string;
  readonly tabId: string;
  readonly relativePath: string;
  readonly language: ViewerLanguageId;

  /**
   * The main-minted token this tab reads through. PUBLIC because the registry
   * compares it: a file re-opened from the tree after a delete-and-recreate is
   * the same tab id with a NEW token, and a session still holding the old one
   * would answer `invalid_node` forever. See `file-viewer-registry.ts`.
   */
  readonly nodeId: string;
  readonly #highlighter: HighlighterPort;
  readonly #explorers: ExplorerRegistry;

  #state: FileViewerState = { kind: "idle" };
  #highlight: HighlightState = { kind: "plain", reason: "plain_language" };

  /** Bumped by `dispose`. The publication fence for reads and highlights. */
  #generation = 0;

  /** True while a read is in flight. The first half of the depth-2 queue. */
  #reading = false;
  /**
   * A reload asked for while one was running. A BOOLEAN, not a counter: the
   * second half of the queue holds "read again when this one lands", and a
   * third request asks for exactly the same thing.
   */
  #queuedRead = false;

  /**
   * Set while a delete re-check is the reason the next read is happening.
   *
   * It rides the QUEUE, not just the running read: a re-check coalesced behind
   * an in-flight read still has to have its `not_found` read as "orphaned"
   * rather than as a plain refusal.
   */
  #pendingDelete = false;

  /** The hash the outstanding highlight request was issued for. */
  #highlightingHash: string | null = null;
  /** Set when a highlight was wanted but the tab is hidden. */
  #highlightDeferred = false;

  #active = false;
  #activated = false;
  #deleteTimer: ReturnType<typeof setTimeout> | null = null;
  #unsubscribePath: (() => void) | null = null;

  /**
   * The UNCOLOURED line split, memoized by content hash.
   *
   * A file shown without colour still has to become lines, and splitting half a
   * megabyte on every React commit would make scrolling cost more than
   * highlighting did. Keyed by hash so a reload that changed the bytes
   * invalidates it and one that did not reuses it.
   */
  #plainLines: { hash: string; lines: readonly TokenLine[] } | null = null;

  #revision = 0;
  readonly #revisionListeners = new Set<() => void>();

  constructor(options: FileViewerSessionOptions) {
    this.projectId = options.projectId;
    this.tabId = options.tab.tabId;
    this.relativePath = options.tab.relativePath;
    this.nodeId = options.tab.nodeId;
    this.#highlighter = options.highlighter;
    this.#explorers = options.explorers ?? sharedExplorerRegistry;
    this.language = languageOfPath(this.relativePath);
  }

  /* ----------------------- observable state ----------------------- */

  getState(): FileViewerState {
    return this.#state;
  }

  getHighlight(): HighlightState {
    return this.#highlight;
  }

  getRevision(): number {
    return this.#revision;
  }

  subscribeRevision(listener: () => void): () => void {
    this.#revisionListeners.add(listener);
    return () => {
      this.#revisionListeners.delete(listener);
    };
  }

  /**
   * The RAW text, for the clipboard. `null` when there is none to copy.
   *
   * The raw text and not the rendered tokens: what the user asked to copy is
   * the file, and reassembling it from spans would silently normalise line
   * endings that the file actually contains.
   */
  copyAll(): string | null {
    const state = this.#state;
    if (state.kind === "ready" || state.kind === "orphaned") return state.content.text;
    return null;
  }

  /**
   * EVERY line of the file the viewer is showing, in order.
   *
   * ONE shape for the component whether the lines were tokenized or not, so the
   * code area has no branch: `highlighted` hands over the worker's tokens, and
   * every other highlight state hands over the plain split of the same text.
   * Empty when there is no content to show at all - a refusal, a failure, or a
   * first read still in flight.
   */
  getLines(): readonly TokenLine[] {
    const highlight = this.#highlight;
    if (highlight.kind === "highlighted") return highlight.lines;

    const state = this.#state;
    if (state.kind !== "ready" && state.kind !== "orphaned") return EMPTY_LINES;

    const cached = this.#plainLines;
    if (cached !== null && cached.hash === state.content.hash) return cached.lines;
    const { lines } = plainTokenize(state.content.text, PLAIN_LINE_BOUND_DISABLED);
    this.#plainLines = { hash: state.content.hash, lines };
    return lines;
  }

  /** How many bytes the viewer holds. For the header, and for the byte bound. */
  size(): number | null {
    const state = this.#state;
    if (state.kind === "ready" || state.kind === "orphaned") return state.content.size;
    if (state.kind === "refused") return state.size ?? null;
    return null;
  }

  /* ----------------------- lifecycle ----------------------- */

  /**
   * Bring the tab live: read the file and start following it. Idempotent.
   *
   * The explorer session is ACQUIRED here rather than merely borrowed. A file
   * tab is a consumer of the project's watcher for as long as it is open, and
   * without the reference a user who collapses the sidebar would unmount the
   * tree, drop the session to zero consumers, and silently stop the open file
   * from following the disk.
   *
   * `activate` on that session is idempotent and single-flight, so calling it
   * here costs nothing when the tree already did.
   */
  activate(): void {
    if (this.#state.kind === "disposed" || this.#activated) return;
    this.#activated = true;

    const explorer = this.#explorers.acquire(this.projectId);
    void this.#explorers.activate(this.projectId);
    this.#unsubscribePath = explorer.subscribePath(this.relativePath, (event) => {
      this.#onPathEvent(event.kind);
    });

    this.#requestRead();
  }

  /**
   * Whether this tab is the one on screen.
   *
   * A hidden tab never holds a worker request: the panels are CSS-hidden and
   * never unmounted, so without this a project with eight open files would put
   * eight tokenizations through one worker thread for seven files nobody is
   * looking at. The want is REMEMBERED, not dropped, and runs when the tab is
   * shown.
   */
  setActive(active: boolean): void {
    if (this.#state.kind === "disposed" || this.#active === active) return;
    this.#active = active;
    if (active && this.#highlightDeferred) {
      this.#highlightDeferred = false;
      this.#startHighlight();
    }
  }

  /** The Retry affordance on a transport failure. */
  retry(): void {
    if (this.#state.kind === "disposed") return;
    this.#requestRead();
  }

  /** Release everything. Idempotent. */
  dispose(): void {
    if (this.#state.kind === "disposed") return;
    // Bumped FIRST: a read or a highlight resolving during the teardown below
    // must find a generation that no longer matches.
    this.#generation += 1;
    this.#setState({ kind: "disposed" });

    this.#clearDeleteTimer();
    const unsubscribe = this.#unsubscribePath;
    this.#unsubscribePath = null;
    if (unsubscribe !== null) unsubscribe();
    if (this.#activated) this.#explorers.release(this.projectId);

    this.#queuedRead = false;
    this.#highlightingHash = null;
    this.#highlightDeferred = false;
    this.#revisionListeners.clear();
  }

  /* ----------------------- following the file ----------------------- */

  #onPathEvent(kind: "updated" | "deleted" | "resync"): void {
    if (this.#state.kind === "disposed") return;

    if (kind === "deleted") {
      this.#scheduleDeleteRecheck();
      return;
    }

    // An UPDATE while the delete re-check is pending means the file is back
    // before the timer fired. The re-read is the same work, so the timer is
    // dropped rather than left to fire a second read behind this one.
    this.#clearDeleteTimer();
    this.#requestRead();
  }

  /**
   * A DELETED event is doubted for 100 ms, then answered by a read.
   *
   * The timer is REPLACED, not stacked: a rename storm produces several delete
   * events and one re-check is the answer to all of them.
   */
  #scheduleDeleteRecheck(): void {
    this.#clearDeleteTimer();
    this.#deleteTimer = setTimeout(() => {
      this.#deleteTimer = null;
      if (this.#state.kind === "disposed") return;
      this.#requestRead({ afterDelete: true });
    }, VIEWER_DELETE_RECHECK_MS);
  }

  #clearDeleteTimer(): void {
    const timer = this.#deleteTimer;
    this.#deleteTimer = null;
    if (timer !== null) clearTimeout(timer);
  }

  /* ----------------------- the read queue ----------------------- */

  /**
   * Ask for a read, honouring the depth-2 queue.
   *
   * `afterDelete` rides on the QUEUED read as well as the running one: if a
   * delete re-check is coalesced behind an in-flight read, the answer it gets
   * still has to be interpreted as "we were told this file was deleted", or a
   * `not_found` would be reported as a plain refusal instead of as an orphan.
   */
  #requestRead(options: { afterDelete?: boolean } = {}): void {
    if (this.#state.kind === "disposed") return;
    if (options.afterDelete === true) this.#pendingDelete = true;

    if (this.#reading) {
      // At the bound. Every further request collapses into this one flag,
      // which is the coalescing the queue depth buys.
      this.#queuedRead = true;
      return;
    }
    void this.#performRead();
  }

  async #performRead(): Promise<void> {
    this.#reading = true;
    const generation = this.#generation;
    const afterDelete = this.#pendingDelete;
    this.#pendingDelete = false;

    // Only a FIRST read shows a spinner. A reload keeps the file on screen.
    if (this.#state.kind === "idle") this.#setState({ kind: "reading" });

    let result;
    try {
      result = await readProjectFile(this.projectId, this.nodeId);
    } catch (cause: unknown) {
      // The bridge rejected where a Result was expected. That is a transport
      // failure by every property that matters, and swallowing it would leave
      // the tab reading forever.
      console.warn(`studio viewer: read of ${this.tabId} rejected`, cause);
      result = null;
    }

    this.#reading = false;

    // THE FENCE. Everything interesting happens during the await.
    if (generation !== this.#generation) return;

    if (result === null || !result.ok) {
      this.#publishFailure();
    } else if (result.data.ok) {
      this.#publishContent(result.data.value);
    } else if (result.data.code === "not_found" && afterDelete) {
      // The re-check agreed with the delete: the file is gone. Keep what was
      // last read and say so, rather than replacing a readable file with a
      // refusal the user can do nothing about.
      this.#publishOrphaned();
    } else {
      this.#publishRefusal(result.data.code, result.data.size);
    }

    if (this.#queuedRead) {
      this.#queuedRead = false;
      void this.#performRead();
    }
  }

  /* ----------------------- publication ----------------------- */

  #publishContent(content: FileContent): void {
    const previous = this.#state;
    const unchanged =
      (previous.kind === "ready" || previous.kind === "orphaned") &&
      previous.content.hash === content.hash;

    this.#setState({ kind: "ready", content });

    // SAME BYTES: the file was touched but its contents did not change (a
    // `touch`, a formatter that made no edit, a rename back). Re-tokenizing
    // would burn a worker round trip to produce the tokens already on screen,
    // and would blink the code area through `highlighting` on the way.
    if (unchanged && this.#highlight.kind !== "plain") return;

    this.#decideHighlight(content);
  }

  #publishOrphaned(): void {
    const previous = this.#state;
    if (previous.kind !== "ready" && previous.kind !== "orphaned") {
      // Nothing was ever read, so there is nothing to keep. This is an
      // ordinary not-found answer.
      this.#publishRefusal("not_found", undefined);
      return;
    }
    this.#setState({ kind: "orphaned", content: previous.content });
  }

  #publishRefusal(code: FilesErrorCode, size: number | undefined): void {
    this.#setState({ kind: "refused", code, size });
    this.#setHighlight({ kind: "plain", reason: "plain_language" });
    this.#highlightingHash = null;
    this.#highlightDeferred = false;
  }

  #publishFailure(): void {
    this.#setState({ kind: "failed" });
    this.#setHighlight({ kind: "plain", reason: "plain_language" });
    this.#highlightingHash = null;
    this.#highlightDeferred = false;
  }

  /* ----------------------- highlighting ----------------------- */

  /**
   * Decide whether this content gets tokens, and start the work if it does.
   *
   * Both refusals are stated as REASONS rather than as silence, because a file
   * with no colour and no explanation looks like a broken highlighter.
   */
  #decideHighlight(content: FileContent): void {
    this.#highlightingHash = null;

    if (this.language === PLAIN_LANGUAGE) {
      this.#highlightDeferred = false;
      this.#setHighlight({ kind: "plain", reason: "plain_language" });
      return;
    }
    if (content.size > VIEWER_HIGHLIGHT_MAX_BYTES) {
      this.#highlightDeferred = false;
      this.#setHighlight({ kind: "plain", reason: "too_large_to_highlight" });
      return;
    }

    if (!this.#active) {
      // A hidden tab holds no worker request. The want survives; see setActive.
      this.#highlightDeferred = true;
      return;
    }
    this.#startHighlight();
  }

  #startHighlight(): void {
    const state = this.#state;
    if (state.kind !== "ready" && state.kind !== "orphaned") return;
    const content = state.content;

    const generation = this.#generation;
    const hash = content.hash;
    this.#highlightingHash = hash;
    this.#setHighlight({ kind: "highlighting" });

    void this.#highlighter
      .highlight({
        language: this.language,
        text: content.text,
        maxLineLength: VIEWER_MAX_TOKENIZE_LINE_LENGTH,
      })
      .then((outcome) => {
        // THE FENCE, both halves. The generation says this session still
        // exists; the hash says the tokens describe the text on screen. A
        // reload that landed during the await invalidates the second even
        // though the first still holds.
        if (generation !== this.#generation) return;
        if (this.#highlightingHash !== hash) return;
        this.#highlightingHash = null;

        if (outcome.ok) {
          this.#setHighlight({
            kind: "highlighted",
            lines: outcome.lines,
            longLines: outcome.longLines,
          });
          return;
        }
        this.#setHighlight({ kind: "plain-after-failure", reason: outcome.reason });
      });
  }

  /* ----------------------- plumbing ----------------------- */

  #setState(state: FileViewerState): void {
    this.#state = state;
    this.#bumpRevision();
  }

  #setHighlight(highlight: HighlightState): void {
    this.#highlight = highlight;
    this.#bumpRevision();
  }

  /**
   * ONE counter over everything the component renders from.
   *
   * `useSyncExternalStore` compares snapshots with `Object.is`, and the viewer
   * draws from two fields that change independently. One counter is one source
   * of truth for "something on screen changed", and it is what a component
   * subscribes to instead of two stores it would have to keep consistent.
   */
  #bumpRevision(): void {
    this.#revision += 1;
    for (const listener of [...this.#revisionListeners]) listener();
  }
}
