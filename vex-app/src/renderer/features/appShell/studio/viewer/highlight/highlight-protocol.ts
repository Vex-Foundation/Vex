/**
 * THE HIGHLIGHT WORKER WIRE.
 *
 * Both ends of this channel are ours and ride in the same bundle, so there is
 * no Zod here: a schema at this seam would validate our own compiler's output
 * against itself. It is not a trust boundary. It IS a process boundary, so the
 * shapes below are the contract that keeps the two halves honest, and the
 * module is deliberately LIB-NEUTRAL - it imports nothing, references no DOM
 * type and no WebWorker type, which is what lets it compile under
 * `tsconfig.renderer.json` (DOM) and `tsconfig.renderer-worker.json`
 * (WebWorker) alike. That double compilation is the proof, not a comment.
 *
 * ## A reason is a CODE
 *
 * A tokenizer failure carries a member of {@link HighlightFailureReason} and
 * never shiki's own error text. That text names grammar scopes, regex source
 * and sometimes a file path, and the renderer's remedy is identical for every
 * member of a class: show the file as plain text and say why. The worker logs
 * the sentence with `console.warn`; the wire carries the code. Same doctrine as
 * `@shared/schemas/files.ts` applies to its refusals.
 *
 * ## Nothing here is a silent cut
 *
 * A successful result carries EVERY line of the file. Two bounds exist and
 * each REPORTS itself rather than trimming anything.
 *
 * `longLines` counts the lines that were emitted as a single unhighlighted
 * token because they exceeded `maxLineLength`, so the viewer can say "3 long
 * lines are not highlighted" instead of leaving the user to wonder why one row
 * looks different.
 *
 * `maxTokens` is the whole-file bound, and it is REFUSED rather than trimmed: a
 * file over it comes back as `{ ok: false, reason: "too_many_tokens" }` and the
 * viewer shows every byte of it as plain text. It is enforced inside the
 * WORKER, while the tokens are being projected, which is the only place that
 * can stop an oversized token graph from being finished and structured-cloned
 * across this boundary at all. A renderer-side count after the clone has
 * already paid for everything the bound exists to prevent.
 *
 * No line is ever dropped and no line is ever shortened.
 */

/**
 * The most tokens a file may produce before the highlighter refuses it.
 *
 * 250,000, and the number is MEASURED rather than chosen. Against the installed
 * shiki 4.4.3 with this repo's hot grammars, ordinary TypeScript source runs at
 * about 122 tokens per KiB, so a file at the viewer's 512 KiB highlight bound
 * produces roughly 62,000 tokens; densely punctuated JSON runs at about 645
 * tokens per KiB, which at the same byte bound is roughly 330,000. The bound
 * therefore sits four times above anything real source can reach and below the
 * pathological shape, which is exactly the file it exists to decline.
 *
 * It is a bound on the ARRAY, not on the DOM: the viewer virtualizes, so only
 * the visible rows are ever mounted. What a quarter of a million tokens costs
 * is the structured clone out of the worker and the objects the session then
 * retains for as long as the tab is open, per tab.
 *
 * It lives HERE, on the wire, because both ends need the same number: the
 * worker enforces it while projecting, the session states it on the request,
 * and the port re-checks the answer. Two copies would eventually disagree, and
 * the disagreement would look like a highlighter that sometimes refuses a file
 * it sometimes colours.
 *
 * AT THE BOUND the file is shown in full as plain text and the chip names the
 * reason. Nothing is truncated and no line is dropped; the user loses colour,
 * which is all a highlighter provides.
 */
export const HIGHLIGHT_MAX_TOKENS = 250_000;

/**
 * How many lines a text has, by the ONE definition this folder uses.
 *
 * CRLF and LF both terminate a line and a lone CR does not, which is shiki's
 * own `RE_NEWLINE` and therefore what `plainTokenize` and `projectLines` split
 * on. It lives on the wire module because BOTH ends need it and neither may
 * import the other: the worker projects that many lines, and the port checks
 * that the answer carries exactly as many as the text it sent.
 */
export function countLines(text: string): number {
  return text.split(/\r?\n/).length;
}

/**
 * One styled run inside a line.
 *
 * `color` is a CSS colour string produced by the css-variables theme - in
 * practice `var(--vex-alias-code-token-keyword)` and friends - or `null` when
 * the token carries no colour of its own and must inherit the code area's
 * foreground. Shiki spells "no colour" two different ways (an absent property
 * for plain-text lines, an empty string for over-length lines); the tokenizer
 * normalises both to `null` so a consumer has one case to handle.
 */
export interface HighlightToken {
  readonly text: string;
  readonly color: string | null;
  readonly italic: boolean;
  readonly bold: boolean;
  readonly underline: boolean;
}

/**
 * One line of the file, in order. An EMPTY array is a genuinely empty line and
 * renders as a blank row; it is not a missing line.
 */
export type TokenLine = readonly HighlightToken[];

/**
 * Why a file is being shown as plain text instead of highlighted.
 *
 * `grammar_unavailable` - the language has no loader in the hot set, or its
 * grammar module failed to import. A statement about our bounded table.
 *
 * `too_many_tokens` - the file would produce more than the request's
 * `maxTokens`. Refused DURING projection, so the oversized graph is never
 * finished and never crosses the boundary.
 *
 * `tokenize_failed` - a grammar was loaded and tokenizing threw. Measured
 * against shiki 4.4.3 with `forgiving: false`, this is also where an
 * unconvertible Oniguruma pattern surfaces: vscode-textmate compiles a rule
 * lazily on first use, so the JavaScript regex engine raises the conversion
 * error during tokenization and never during `loadLanguage`. See the note on
 * `createTokenizer` in `shiki-tokenizer.ts`.
 */
export type HighlightFailureReason =
  | "grammar_unavailable"
  | "tokenize_failed"
  | "too_many_tokens";

/** What the port sends. `requestId` correlates the answer. */
export interface HighlightRequest {
  readonly kind: "highlight";
  readonly requestId: number;
  /** A shiki language id from the hot set, or `"text"`. */
  readonly language: string;
  /** The WHOLE file. Never a prefix. */
  readonly text: string;
  /** Lines at or above this length are emitted as one unhighlighted token. */
  readonly maxLineLength: number;
  /**
   * The whole-file token bound. Zero or less disables it.
   *
   * Carried on the REQUEST so the worker enforces exactly the number the caller
   * will check the answer against. See {@link HIGHLIGHT_MAX_TOKENS}.
   */
  readonly maxTokens: number;
}

/** A tokenized file: every line, in order, plus the reported long-line count. */
export interface HighlightSuccess {
  readonly kind: "result";
  readonly requestId: number;
  readonly ok: true;
  readonly lines: readonly TokenLine[];
  /** How many lines were too long to tokenize. The bound reporting itself. */
  readonly longLines: number;
}

export interface HighlightFailure {
  readonly kind: "result";
  readonly requestId: number;
  readonly ok: false;
  readonly reason: HighlightFailureReason;
}

/**
 * Abandon a request the caller no longer wants an answer to.
 *
 * A request that has NOT started is removed from the worker's queue and never
 * runs at all; the one already running is dropped at the next await point
 * rather than interrupted, because `codeToTokensBase` has no yield point inside
 * it. Either way the worker posts nothing for a cancelled id, and the port has
 * already stopped holding it.
 */
export interface HighlightCancel {
  readonly kind: "cancel";
  readonly requestId: number;
}

/** Everything the worker can receive. */
export type HighlightMessage = HighlightRequest | HighlightCancel;

/**
 * Posted once when the worker's module graph has evaluated.
 *
 * The port does not wait for it - a request posted before it arrives is queued
 * by the structured-clone channel and answered normally - but it is what makes
 * "the worker started at all" observable rather than inferred from a timeout.
 */
export interface HighlightReady {
  readonly kind: "ready";
}

export type HighlightResponse = HighlightReady | HighlightSuccess | HighlightFailure;

/* ------------------------------------------------------------------ *
 * The shape guard
 * ------------------------------------------------------------------ */

/**
 * Is this really one of the responses above?
 *
 * Both ends are ours, so this is not a trust boundary and there is no Zod here
 * for the reason the module header gives. It is still a PROCESS boundary, and
 * the worker runs our own evolving code behind a separate build: a bad chunk,
 * a half-applied edit or a future protocol change would otherwise put a shape
 * nothing checked straight into renderer state and render `undefined` as a line
 * of the user's file. This fails CLOSED instead - the port reports
 * `malformed_result` and the viewer shows honest plain text.
 *
 * Deliberately NARROW: it proves the discriminants, the array-ness of `lines`
 * and the field types of every token, which is exactly what the renderer reads.
 */
export function isHighlightResponse(value: unknown): value is HighlightResponse {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { readonly kind?: unknown };
  if (message.kind === "ready") return true;
  if (message.kind !== "result") return false;
  const result = value as {
    readonly requestId?: unknown;
    readonly ok?: unknown;
    readonly lines?: unknown;
    readonly longLines?: unknown;
    readonly reason?: unknown;
  };
  if (typeof result.requestId !== "number") return false;
  if (result.ok === false) {
    return (
      result.reason === "grammar_unavailable" ||
      result.reason === "tokenize_failed" ||
      result.reason === "too_many_tokens"
    );
  }
  if (result.ok !== true) return false;
  if (typeof result.longLines !== "number") return false;
  if (!Array.isArray(result.lines)) return false;
  return result.lines.every(isTokenLine);
}

function isTokenLine(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every(isHighlightToken);
}

function isHighlightToken(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const token = value as {
    readonly text?: unknown;
    readonly color?: unknown;
    readonly italic?: unknown;
    readonly bold?: unknown;
    readonly underline?: unknown;
  };
  if (typeof token.text !== "string") return false;
  if (token.color !== null && typeof token.color !== "string") return false;
  if (typeof token.italic !== "boolean") return false;
  if (typeof token.bold !== "boolean") return false;
  return typeof token.underline === "boolean";
}

/** What the tokenizer returns and the worker forwards. */
export interface TokenizeResult {
  readonly lines: readonly TokenLine[];
  readonly longLines: number;
}
