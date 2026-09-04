/**
 * THE FILE VIEWER - one open file tab, read-only.
 *
 * ## The component renders; the session decides
 *
 * Every rule worth getting right - when to read, what a delete means, which
 * highlight result is still current - lives in `file-viewer-session.ts` and is
 * tested without a DOM. This file subscribes to that session's revision counter
 * through `useSyncExternalStore` and turns its two state axes into a header, a
 * notice, and either an answer or the code.
 *
 * ## Refusals are ANSWERS ABOUT THE FILE, and there is no way around them
 *
 * `too_large`, `binary`, `symlinked_path` and `not_a_file` are decided in the
 * privileged main process against the bytes it actually read. There is no "Open
 * anyway" here and there must never be one: the renderer cannot grant itself a
 * capability main declined, so a button that appeared to would be a lie about
 * who decides. The copy explains and offers nothing else.
 *
 * ## Every bound the user can see says so
 *
 * A file with no colour always carries a chip naming the reason - no grammar,
 * over the highlighting limit, a dead worker - and a file with long lines
 * carries their count. Uncoloured code with no explanation is indistinguishable
 * from a broken highlighter, and the user would be right to stop trusting it.
 *
 * ## Actions are SIBLINGS of the content
 *
 * The header strip's controls sit beside the code area, never inside it, so the
 * region a screen reader reads as the file contains only the file.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from "react";
import { IconCopy, IconFolderOpen } from "../../../../components/icons/index.js";
import { Menu } from "../../../../components/ui/menu.js";
import { revealProjectNodeInFileManager } from "../../../../lib/api/files.js";
import { notify } from "../../../../lib/notifications/index.js";
import { cn } from "../../../../lib/utils.js";
import type { WorkspaceFileTab } from "../workspace/types.js";
import { FileViewerLines, type ViewerViewportObservers } from "./FileViewerLines.js";
import type { TokenLine } from "./highlight/highlight-protocol.js";
import type { ViewerLanguageId } from "./highlight/language-of-path.js";
import { fileViewerRegistry, type FileViewerRegistry } from "./file-viewer-registry.js";
import {
  VIEWER_HIGHLIGHT_MAX_BYTES,
  VIEWER_LINE_TIME_BUDGET_MS,
  VIEWER_MAX_TOKENIZE_LINE_LENGTH,
  type FileViewerSession,
} from "./file-viewer-session.js";
import {
  COPY_FILE_DONE,
  COPY_FILE_LABEL,
  KIND_MENU_LABEL,
  ORPHANED_NOTICE,
  REVEAL_IN_FILE_MANAGER_LABEL,
  REVEAL_TRANSPORT_FAILED_TITLE,
  RETRY_LABEL,
  TRANSPORT_FAILED,
  VIEWER_LOADING,
  formatBytes,
  highlightBudgetNote,
  languageHasNoGrammar,
  longLinesText,
  partlyHighlightedText,
  plainReasonText,
  refusalText,
  revealRefusalText,
  revealTransportFailedText,
  viewerKindLabel,
} from "./viewer-copy.js";

/** How long the Copy button says "Copied" before returning to its label. */
export const COPY_FEEDBACK_MS = 1_500;

export interface FileViewerProps {
  readonly projectId: string;
  readonly tab: WorkspaceFileTab;
  /** Whether this tab is the one on screen. A hidden tab defers its highlight. */
  readonly active: boolean;
  /**
   * The session registry. A test constructs its own - with a fake highlighter
   * and its own explorer registry - rather than sharing the window's.
   *
   * There is deliberately no separate `highlighter` prop: the registry OWNS the
   * shared port's lifetime, and a second injection path would be a second owner
   * of the same worker.
   */
  readonly registry?: FileViewerRegistry;
  readonly viewport?: ViewerViewportObservers;
  readonly className?: string;
}

export function FileViewer({
  projectId,
  tab,
  active,
  registry,
  viewport,
  className,
}: FileViewerProps): JSX.Element {
  const activeRegistry = registry ?? fileViewerRegistry;
  const [session, setSession] = useState<FileViewerSession | null>(null);
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /**
   * What to say about the last reveal, or `null` when there is nothing to say.
   *
   * A reveal that WORKED says nothing: the user watched a file manager appear,
   * and a bar confirming it would be the panel narrating the desktop.
   */
  const [revealNote, setRevealNote] = useState<string | null>(null);

  /**
   * The latest tab, for the acquire below.
   *
   * `acquire` reads the tab's token, and the identity of the `tab` OBJECT
   * changes on every parent render while the values that matter do not. Keying
   * the effect on the object would re-acquire on every commit; keying it on the
   * two fields that decide a session's identity is the honest dependency.
   */
  const tabRef = useRef(tab);
  tabRef.current = tab;
  /**
   * The latest project, for the reveal fence below.
   *
   * `projectId` is a prop, so a reveal in flight when the shell swaps projects
   * holds the OLD one in its closure. The fence needs the current value to
   * decide whether the answer is still about what is on screen, and only a ref
   * carries that into a promise created before the change.
   */
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  /**
   * WHICH REVEAL THE ANSWER ON SCREEN BELONGS TO.
   *
   * Bumped on every ask; the settle publishes only if it is still the newest.
   * Without it two reveals answered out of order leave the OLDER sentence on
   * screen, which is the same publication-fence bug `file-viewer-session.ts`
   * carries a generation for (rule 05: guard publication with operation
   * identity, checked at publication and not only at start).
   */
  const revealGenerationRef = useRef(0);

  useEffect(() => {
    // Acquired in an effect, never in render: StrictMode renders twice but runs
    // setup/cleanup/setup, and the registry's deferred teardown is what makes
    // that remount free. Acquiring in render would double-count.
    const acquired = activeRegistry.acquire(projectId, tabRef.current);
    setSession(acquired);
    // Fire and forget: `activate` awaits the project's watch before its first
    // read and the session owns every state it can reach, so there is nothing
    // for this effect to do with the promise.
    void acquired.activate();
    // A new file is a new subject: whatever the previous one's reveal said is
    // no longer about anything on screen.
    setMenuOpen(false);
    setRevealNote(null);
    return () => {
      activeRegistry.release(tabRef.current.tabId);
    };
  }, [activeRegistry, projectId, tab.tabId, tab.nodeId]);

  // Reported to the REGISTRY, not to the session: the registry is what holds
  // the warm-tab bound across every open file, and a component telling its own
  // session would be a second place that bound is decided. See
  // `file-viewer-registry.ts`.
  useEffect(() => {
    if (session === null) return;
    activeRegistry.setActive(tabRef.current.tabId, active);
  }, [activeRegistry, session, active]);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (session === null) return () => undefined;
      return session.subscribeRevision(onChange);
    },
    [session],
  );
  useSyncExternalStore(
    subscribe,
    () => session?.getRevision() ?? 0,
    () => 0,
  );

  // The feedback timer is owned here and cleared on unmount, so a tab closed
  // right after a copy leaves no timer behind.
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => {
      setCopied(false);
    }, COPY_FEEDBACK_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  const handleCopy = useCallback(() => {
    const text = session?.copyAll();
    if (text === null || text === undefined) return;
    // The RAW text: what the user asked to copy is the file, and reassembling
    // it from the rendered spans would normalise line endings the file has.
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
      },
      () => {
        // A clipboard the platform refused. Saying nothing is right here: the
        // user pressed a button and nothing was copied, which the unchanged
        // label already reports.
      },
    );
  }, [session]);

  /**
   * ASK MAIN TO SHOW THIS FILE IN THE DESKTOP'S FILE MANAGER.
   *
   * The renderer sends the tab's node token and nothing else - it has no path
   * to send - and main re-resolves it through the same authority chain a read
   * uses before the desktop is touched. Adopted from VS Code's `revealFileInOS`
   * (`files/electron-browser/fileActions.contribution.ts:39-42`), which also
   * resolves the resource in the renderer and hands the reveal to a privileged
   * service rather than performing it where the command was invoked.
   *
   * ## PUBLICATION IS FENCED BY THE ASK, ALL FOUR PARTS
   *
   * The inline sentence is a statement about the file ON SCREEN, so it is
   * published only if the ask it answers is still what the screen shows:
   *
   *  - the GENERATION still matches, so of two reveals answered out of order
   *    the older one cannot land on top of the newer;
   *  - the PROJECT is still the one that asked;
   *  - the TAB is still the one that asked;
   *  - the tab's NODE is still the one that asked. A rename keeps the tab and
   *    replaces its node token, and the tab id alone would let an answer about
   *    the old node stand as an answer about the new one.
   *
   * ## A REFUSAL IS CONTEXTUAL, A TRANSPORT FAILURE IS APP-WIDE
   *
   * `not_found`, `symlinked_path`, `outside_project` are durable ANSWERS ABOUT
   * THIS FILE that main decided against the node it resolved; they belong
   * beside the file, and they go stale with it.
   *
   * A call that never reached main is a statement about the FILE SERVICE - the
   * explorer and the terminal reach it too - and the user must be able to
   * re-read it after this tab is gone. So it is raised into the project-scoped
   * notification model instead, UNFENCED and naming its own file, because it
   * was never about the tab on screen. VS Code does the same split: its file
   * commands route the thrown failure to `INotificationService`
   * (`files/browser/fileActions.ts:596,1086,1112`) while a resolution's own
   * answer stays with the resource.
   *
   * The id is per project AND node, so hammering one file replaces its own
   * notification while two failing files still report twice; the correlation
   * id from the envelope travels with it so the row can be traced to main's
   * log. No Retry action: the reveal has no state to resume, the button would
   * outlive this component and have to be detached on unmount, and a notice
   * the user re-triggers from the file itself is the smaller contract.
   */
  const handleReveal = useCallback(() => {
    const askedFor = tabRef.current;
    const askedProjectId = projectId;
    const generation = revealGenerationRef.current + 1;
    revealGenerationRef.current = generation;
    setMenuOpen(false);
    setRevealNote(null);
    const settle = (note: string | null): void => {
      if (generation !== revealGenerationRef.current) return;
      if (projectIdRef.current !== askedProjectId) return;
      if (tabRef.current.tabId !== askedFor.tabId) return;
      if (tabRef.current.nodeId !== askedFor.nodeId) return;
      setRevealNote(note);
    };
    const unreachable = (correlationId: string | null): void => {
      notify({
        id: `studio.viewer-reveal:${askedProjectId}:${askedFor.nodeId}`,
        severity: "error",
        scope: { kind: "project", projectId: askedProjectId },
        source: "studio.viewer",
        title: REVEAL_TRANSPORT_FAILED_TITLE,
        message: revealTransportFailedText(askedFor.relativePath),
        ...(correlationId === null ? {} : { correlationId }),
      });
      // Nothing inline: the notification IS the report, and a second copy over
      // the file would say it twice in a place it does not belong.
      settle(null);
    };
    void revealProjectNodeInFileManager({
      projectId: askedProjectId,
      nodeId: askedFor.nodeId,
    }).then(
      (result) => {
        if (!result.ok) {
          unreachable(result.error.correlationId);
          return;
        }
        settle(result.data.ok ? null : revealRefusalText(result.data.code));
      },
      () => {
        // A rejected bridge carries no envelope, so there is no correlation id
        // to pass on rather than one to invent.
        unreachable(null);
      },
    );
  }, [projectId]);

  const state = session?.getState() ?? { kind: "idle" as const };
  const highlight = session?.getHighlight() ?? null;
  const lines = session?.getLines() ?? [];
  const size = session?.size() ?? null;
  const language = session?.language ?? "text";
  const hasContent = state.kind === "ready" || state.kind === "orphaned";

  return (
    <div
      data-testid="file-viewer"
      // The marker the Studio keyboard table resolves its `when` context
      // against (`useStudioKeybindings.ts`): a shortcut scoped to the viewer
      // has to be able to tell that focus is inside one, and a `data-testid`
      // is not a contract a feature may build on.
      data-vex-key-surface="viewer"
      className={cn("flex h-full min-h-0 flex-col bg-surface-base", className)}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line-3 px-3 text-[12px] leading-4">
        <span className="truncate font-mono text-ink-secondary" title={tab.relativePath}>
          {tab.relativePath}
        </span>
        <KindMenu
          label={viewerKindLabel(language, state.kind === "refused" ? state.code : null)}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onReveal={handleReveal}
        />
        {size === null ? null : (
          <span className="shrink-0 text-ink-tertiary">{formatBytes(size)}</span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={handleCopy}
          disabled={!hasContent}
          aria-label={COPY_FILE_LABEL}
          className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40"
        >
          <IconCopy size={12} />
          {copied ? <span>{COPY_FILE_DONE}</span> : null}
        </button>
      </div>

      {state.kind === "orphaned" ? (
        <Notice tone="status">{ORPHANED_NOTICE}</Notice>
      ) : null}

      {revealNote === null ? null : (
        <Notice tone="alert" testId="file-viewer-reveal-note">
          {revealNote}
        </Notice>
      )}

      <Chip highlight={highlight} language={language} size={size} visible={hasContent} />

      <Body
        state={state}
        lines={lines}
        onRetry={() => {
          session?.retry();
        }}
        {...(viewport === undefined ? {} : { viewport })}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

function Body({
  state,
  lines,
  onRetry,
  viewport,
}: {
  readonly state: ReturnType<FileViewerSession["getState"]>;
  readonly lines: readonly TokenLine[];
  readonly onRetry: () => void;
  readonly viewport?: ViewerViewportObservers;
}): JSX.Element {
  switch (state.kind) {
    case "idle":
    case "disposed":
      return <Centered />;
    case "reading":
      return <Centered>{VIEWER_LOADING}</Centered>;
    case "refused":
      return (
        <Centered testId="file-viewer-refusal">
          {refusalText(state.code, state.size)}
        </Centered>
      );
    case "failed":
      return (
        <Centered testId="file-viewer-failure">
          <span>{TRANSPORT_FAILED}</span>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 rounded px-2 py-1 font-medium text-accent-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {RETRY_LABEL}
          </button>
        </Centered>
      );
    case "ready":
    case "orphaned":
      return <FileViewerLines lines={lines} {...(viewport === undefined ? {} : { viewport })} />;
  }
}

/**
 * The state chip: why the code has no colour, and how many lines are too long.
 *
 * Shown ONLY when there is content, because a refusal already explains itself
 * and stacking "not highlighted" under "this file is binary" would say the same
 * thing twice in a weaker way.
 *
 * A GRAMMARLESS KIND REPORTS NOTHING AT ALL (audit A11). A file whose language
 * resolves to `text` - a `.txt`, a `.env`, a Makefile - was never going to be
 * highlighted: no grammar exists, nothing ran, nothing was bounded and nothing
 * was cut. There is no state to report, and the header already says `Plain
 * text`, which is the whole answer. The first attempt at this demoted the
 * sentence to quiet copy and the audit measured it again, because a grammar
 * sentence on a file with no grammar is noise in either register. The predicate
 * therefore reads the LANGUAGE RESOLUTION (`languageHasNoGrammar`), not the
 * highlighter's reason.
 *
 * Every other reason IS a bound Vex hit or a failure it had, keeps its chip and
 * keeps its announcement - which is what the chip was losing.
 *
 * BOTH REGISTERS CAN APPEAR AT ONCE, and the partly-highlighted state is why.
 * A file whose lines ran out of highlighting time is not plain and not
 * finished: which lines it happened to is a fact worth announcing, and what the
 * budget IS is background. So the chip names the lines and the quiet note under
 * it explains the budget, rather than one long announcement or a fact with no
 * explanation.
 */
function Chip({
  highlight,
  language,
  size,
  visible,
}: {
  readonly highlight: ReturnType<FileViewerSession["getHighlight"]> | null;
  readonly language: ViewerLanguageId;
  readonly size: number | null;
  readonly visible: boolean;
}): JSX.Element | null {
  if (!visible || highlight === null) return null;

  const isPlain =
    highlight.kind === "plain" || highlight.kind === "plain-after-failure";
  // SILENT, not quiet: this kind has no grammar, so there is no grammar state.
  // The reason is required to be `plain_language` as well, because any other
  // reason arriving on a grammarless file would mean the highlighter ran on
  // something it was never asked to run on - and that is worth saying.
  const silent =
    isPlain && highlight.reason === "plain_language" && languageHasNoGrammar(language);

  // The LOUD register: a bound Vex hit or a failure it had, announced.
  const notes: string[] = [];
  // The QUIET register: statements that need no action and would cost the chip
  // its meaning if every file announced them.
  const secondary: string[] = [];

  if (isPlain && !silent) {
    notes.push(plainReasonText(highlight.reason, size ?? 0, VIEWER_HIGHLIGHT_MAX_BYTES));
  }
  if (highlight.kind === "highlighted" && highlight.longLines > 0) {
    notes.push(longLinesText(highlight.longLines, VIEWER_MAX_TOKENIZE_LINE_LENGTH));
  }
  // PARTLY HIGHLIGHTED. A file that is highlighted and has lines the clock ran
  // out on is neither of the two registers above: it is not plain and it is not
  // finished. The first number is what makes it actionable, so an empty list
  // with a non-zero total says nothing rather than pointing at line zero - the
  // port refuses that combination, and this is the render side of the same
  // refusal.
  const firstBudgetLine =
    highlight.kind === "highlighted" ? highlight.budgetExceededLines[0] : undefined;
  if (
    highlight.kind === "highlighted" &&
    highlight.budgetExceededTotal > 0 &&
    firstBudgetLine !== undefined
  ) {
    notes.push(partlyHighlightedText(highlight.budgetExceededTotal, firstBudgetLine));
    // The definition of the budget goes QUIET, under the chip that just named
    // the lines. The fact is the announcement; what half a second means is
    // background the reader consults, not something to interrupt them with.
    secondary.push(highlightBudgetNote(VIEWER_LINE_TIME_BUDGET_MS));
  }
  if (notes.length === 0 && secondary.length === 0) return null;

  return (
    <>
      {notes.length === 0 ? null : (
        <div
          data-testid="file-viewer-chip"
          role="status"
          className="shrink-0 border-b border-line-3 bg-surface-2 px-3 py-1 text-[11px] leading-4 text-ink-tertiary"
        >
          {notes.join(" ")}
        </div>
      )}
      {secondary.length === 0 ? null : (
        <div
          data-testid="file-viewer-secondary-note"
          className="shrink-0 px-3 py-1 text-[11px] leading-4 text-ink-dimmed"
        >
          {secondary.join(" ")}
        </div>
      )}
    </>
  );
}

/**
 * THE KIND, AND WHAT CAN BE DONE WITH THIS FILE.
 *
 * The header's kind word doubles as the menu trigger, so the one action the
 * viewer offers hangs off the thing it is about instead of adding a second
 * control to a strip that already has one. VS Code puts the same command on the
 * editor's title context menu (`appendEditorTitleContextMenuItem`,
 * `files/electron-browser/fileActions.contribution.ts:61`) - an action on the
 * open file, reached from the file's own chrome - and this is that placement
 * with a visible affordance, because a Studio tab strip has no title context
 * menu a user would think to try.
 *
 * ALWAYS ENABLED, including on a refusal. `too_large` and `binary` are exactly
 * the files a person wants to open somewhere else, and disabling the row on the
 * states where it is most useful would be the panel deciding for them. A node
 * that has genuinely gone answers `not_found`, and the viewer says so.
 */
function KindMenu({
  label,
  open,
  onOpenChange,
  onReveal,
}: {
  readonly label: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onReveal: () => void;
}): JSX.Element {
  return (
    <Menu
      open={open}
      onClose={() => {
        onOpenChange(false);
      }}
      items={[
        {
          id: "reveal",
          label: REVEAL_IN_FILE_MANAGER_LABEL,
          icon: <IconFolderOpen size={14} />,
        },
      ]}
      onSelect={(id) => {
        // An unknown id leaves before the dispatch, so a row added later cannot
        // inherit this one's effect.
        if (id !== "reveal") return;
        onReveal();
      }}
      dense
      align="start"
      side="bottom"
      anchor={
        <button
          type="button"
          data-testid="file-viewer-kind"
          aria-label={KIND_MENU_LABEL}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            onOpenChange(!open);
          }}
          className="shrink-0 rounded px-1 py-0.5 text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {label}
        </button>
      }
    />
  );
}

function Notice({
  tone,
  testId,
  children,
}: {
  readonly tone: "status" | "alert";
  readonly testId?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      role={tone}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      className="shrink-0 border-b border-line-3 bg-warning-wash px-3 py-2 text-[12px] leading-4 text-ink-primary"
    >
      {children}
    </div>
  );
}

function Centered({
  children,
  testId,
}: {
  readonly children?: ReactNode;
  readonly testId?: string;
}): JSX.Element {
  return (
    <div
      {...(testId === undefined ? {} : { "data-testid": testId })}
      className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center text-[12px] leading-5 text-ink-tertiary"
    >
      {children}
    </div>
  );
}
