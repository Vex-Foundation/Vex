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
import type { HighlightHandle, HighlighterPort } from "./highlight/highlighter-port.js";
import {
  HIGHLIGHT_MAX_TOKENS,
  type TokenLine,
} from "./highlight/highlight-protocol.js";
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
 * The most tokens a file may produce before the viewer shows it plain.
 *
 * THE VALUE LIVES ON THE WIRE ({@link HIGHLIGHT_MAX_TOKENS}), because the
 * WORKER is what enforces it: it stops projecting the moment the bound is
 * crossed, so an oversized token graph is never finished and never structured-
 * cloned into this process. The session states the same number on its request
 * and re-checks the answer, and one constant is what keeps those three uses
 * from drifting into a highlighter that refuses a file it elsewhere colours.
 *
 * Re-exported under the viewer's own name because this is where a reader of the
 * viewer's bounds looks for it, and because the tests that drive the at-bound
 * behaviour are the viewer's.
 *
 * AT THE BOUND the file is shown in full as plain text and the chip names the
 * reason (`too_many_tokens`). Nothing is truncated and no line is dropped; the
 * user loses colour, which is all a highlighter provides.
 */
export const VIEWER_MAX_TOKENS = HIGHLIGHT_MAX_TOKENS;

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
  /**
   * The outstanding worker request, so it can be ABANDONED.
   *
   * A tab that is hidden, whose bytes changed, or that is closing is not
   * waiting for its tokens any more, and a tokenization nobody will publish is
   * a CPU-bound job competing with the tab the user is actually looking at.
   * At most one exists: `#startHighlight` cancels the previous before issuing
   * the next, and the port enforces the same bound under this tab's id.
   */
  #highlightRequest: HighlightHandle | null = null;
  /** Set when a highlight was wanted but the tab is hidden. */
  #highlightDeferred = false;

  /**
   * Set by `releaseContent`, cleared the moment a read is issued again.
   *
   * It is the difference between "never read" and "read, then released to hold
   * the warm-tab bound", which the `idle` state alone cannot express: showing a
   * never-read tab is `activate`'s job, showing an evicted one has to issue the
   * read itself because `activate` is idempotent and has already run.
   */
  #evicted = false;

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

  /**
   * The last contents successfully read, kept for the ORPHAN answer.
   *
   * Captured the moment a delete is OBSERVED rather than when its confirming
   * read returns, because those are different moments and a read can land in
   * between: a reload queued ahead of the re-check can answer `not_found`
   * first, drop the content to a bare refusal, and leave the orphan with
   * nothing to show. The snapshot makes "the last bytes the user saw" a fact
   * this session holds rather than a state it hopes to still be in.
   */
  #orphanSnapshot: FileContent | null = null;

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
  activate(): Promise<void> {
    if (this.#state.kind === "disposed" || this.#activated) return Promise.resolve();
    this.#activated = true;

    const generation = this.#generation;
    const explorer = this.#explorers.acquire(this.projectId);
    // The listener is installed BEFORE the watch is awaited, so no event can
    // arrive with nobody to hear it once the watch goes live.
    this.#unsubscribePath = explorer.subscribePath(this.relativePath, (event) => {
      this.#onPathEvent(event.kind);
    });

    // READ ONLY AFTER THE WATCH. The explorer session lists only after it
    // listens for exactly this reason, and a restored tab has the same gap:
    // read first and a change landing before the watch is live is a change
    // nobody hears, leaving the viewer on contents that are silently wrong
    // with no event left to correct them.
    const read = (): void => {
      if (generation !== this.#generation) return;
      if (this.#state.kind === "disposed") return;
      this.#requestRead();
    };
    return this.#explorers.activate(this.projectId).then(read, (cause: unknown) => {
      // The watch could not be brought up. The tab still shows the file it was
      // opened on - degraded to "will not follow the disk", which the explorer
      // states in its own notice - rather than sitting empty forever.
      console.warn(`studio viewer: the watch for ${this.tabId} could not start`, cause);
      read();
    });
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
    if (active) {
      // EVICTED WHILE HIDDEN: the content was released to hold the warm-tab
      // bound, so showing the tab reads the file again. Checked before the
      // deferred highlight because an eviction cancelled that request too, and
      // the read's own completion is what re-issues it.
      if (this.#evicted) {
        this.#highlightDeferred = false;
        this.#requestRead();
        return;
      }
      if (this.#highlightDeferred) {
        this.#highlightDeferred = false;
        this.#startHighlight();
      }
      return;
    }
    // HIDDEN. A hidden tab holds no worker request, on the way out as well as
    // on the way in: the want is remembered so showing the tab asks again.
    if (this.#highlightingHash === null) return;
    this.#highlightDeferred = true;
    this.#cancelHighlight();
  }

  /**
   * Whether this session is holding a file's TEXT and TOKENS right now.
   *
   * The registry's warm-tab bound is enforced against this rather than against
   * "has a session": an idle, refused or failed tab costs a few fields, and
   * evicting one would be work that frees nothing.
   *
   * `orphaned` deliberately answers FALSE even though it holds content. Its
   * bytes are the LAST ONES THE USER SAW of a file that is gone from disk, so
   * they cannot be re-read: releasing them would turn the orphan notice into a
   * bare `not_found` refusal on the next show and silently lose the only copy
   * this process has. An orphan is therefore never evicted, and the bound is
   * held by the tabs that can honestly get their content back.
   */
  holdsEvictableContent(): boolean {
    return this.#state.kind === "ready";
  }

  /**
   * INACTIVE-CONTENT EVICTION: drop the text and tokens, keep the tab.
   *
   * Called only by `FileViewerRegistry`, only for a HIDDEN tab, and only past
   * the warm-tab bound. The session returns to `idle` - which is exactly the
   * state a not-yet-read tab is in, so every consumer already renders it - and
   * the identity that makes a re-read possible (`projectId`, `tabId`,
   * `relativePath`, `nodeId`, `language`) is `readonly` and untouched.
   *
   * THE WATCH IS KEPT. `#unsubscribePath` and the explorer reference stay,
   * because dropping them would release the project's watcher refcount and
   * make an evicted tab stop following its file - the user would return to a
   * tab that re-read stale-looking bytes with no event left to correct them.
   * A path event on an evicted tab requests a read, which is the correct
   * behaviour and simply un-evicts it.
   *
   * A no-op unless there is content to release, so a double call costs
   * nothing.
   */
  releaseContent(): void {
    if (!this.holdsEvictableContent()) return;
    this.#evicted = true;
    this.#cancelHighlight();
    this.#highlightDeferred = false;
    this.#plainLines = null;
    this.#setState({ kind: "idle" });
    this.#setHighlight({ kind: "plain", reason: "plain_language" });
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
    this.#cancelHighlight();
    this.#highlightDeferred = false;
    this.#orphanSnapshot = null;
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
    // THE SNAPSHOT, taken at OBSERVATION. See `#orphanSnapshot`.
    const state = this.#state;
    if (state.kind === "ready" || state.kind === "orphaned") {
      this.#orphanSnapshot = state.content;
    }
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
    // ANY read un-evicts. `setActive` is not the only path back: a watcher
    // event on an evicted tab requests a read too, and a flag only the show
    // path cleared would make the next show issue a second, redundant read.
    this.#evicted = false;
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
    // The file answered with bytes, so the doubt a delete raised is settled and
    // the snapshot it left behind describes an older read.
    this.#orphanSnapshot = null;
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
    const content =
      this.#orphanSnapshot ??
      (previous.kind === "ready" || previous.kind === "orphaned" ? previous.content : null);
    if (content === null) {
      // Nothing was ever read, so there is nothing to keep. This is an
      // ordinary not-found answer.
      this.#publishRefusal("not_found", undefined);
      return;
    }
    this.#setState({ kind: "orphaned", content });
  }

  #publishRefusal(code: FilesErrorCode, size: number | undefined): void {
    this.#setState({ kind: "refused", code, size });
    this.#setHighlight({ kind: "plain", reason: "plain_language" });
    this.#cancelHighlight();
    this.#highlightDeferred = false;
  }

  #publishFailure(): void {
    this.#setState({ kind: "failed" });
    this.#setHighlight({ kind: "plain", reason: "plain_language" });
    this.#cancelHighlight();
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
    // New bytes supersede whatever was being tokenized for the old ones.
    this.#cancelHighlight();

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

    this.#cancelHighlight();
    const generation = this.#generation;
    const hash = content.hash;
    this.#highlightingHash = hash;
    this.#setHighlight({ kind: "highlighting" });

    const request = this.#highlighter.highlight({
      language: this.language,
      text: content.text,
      maxLineLength: VIEWER_MAX_TOKENIZE_LINE_LENGTH,
      // The worker enforces this while it projects, so a file over the bound
      // never becomes a token graph and never crosses the boundary.
      maxTokens: VIEWER_MAX_TOKENS,
      // The tab id, so the port holds at most one request for this tab and a
      // burst of saves costs one tokenization rather than one per save.
      caller: this.tabId,
    });
    this.#highlightRequest = request;

    void request.outcome.then((outcome) => {
      // THE FENCE, all three parts. The generation says this session still
      // exists; the REQUEST says this is still the one outstanding, which is
      // what a cancelled or superseded predecessor fails even when it asked
      // about the same bytes; the hash says the tokens describe the text on
      // screen. Checked at publication, never only at issue: everything
      // interesting happens during the await (rule 05).
      if (generation !== this.#generation) return;
      if (this.#highlightRequest !== request) return;
      if (this.#highlightingHash !== hash) return;
      this.#highlightingHash = null;
      this.#highlightRequest = null;

      if (outcome.ok) {
        this.#publishTokens(outcome.lines, outcome.longLines);
        return;
      }
      // A request WE abandoned is not a failure and says nothing to the user.
      // Whoever cancelled it already set the state it wanted.
      if (outcome.reason === "cancelled") return;
      this.#setHighlight({ kind: "plain-after-failure", reason: outcome.reason });
    });
  }

  /**
   * Publish tokens, or decline them for being too many.
   *
   * A CHEAP DEFENSE, not the enforcement. The bound is enforced in the worker,
   * during projection, which is the only place that can stop the oversized
   * graph from being built and cloned - a count here happens after every cost it
   * was meant to avoid has been paid. It stays because a malformed or oversized
   * answer must still fail CLOSED: a future worker, a bad chunk or a
   * half-applied protocol change must not be able to put a quarter-million
   * objects per tab into renderer state just because it did not honour the
   * request's bound.
   *
   * At the bound the file is shown in full as plain text with `too_many_tokens`
   * on the chip.
   */
  #publishTokens(lines: readonly TokenLine[], longLines: number): void {
    let tokens = 0;
    for (const line of lines) {
      tokens += line.length;
      if (tokens > VIEWER_MAX_TOKENS) {
        this.#setHighlight({ kind: "plain-after-failure", reason: "too_many_tokens" });
        return;
      }
    }
    this.#setHighlight({ kind: "highlighted", lines, longLines });
  }

  /**
   * Abandon the outstanding worker request, if there is one. Idempotent.
   *
   * It does NOT touch the highlight sub-state: every caller has its own answer
   * for what the user should see (a hidden tab keeps what it had, a refusal
   * shows the refusal, a reload shows the new bytes), and deciding that here
   * would overwrite it.
   */
  #cancelHighlight(): void {
    this.#highlightingHash = null;
    const request = this.#highlightRequest;
    this.#highlightRequest = null;
    if (request !== null) request.cancel();
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
