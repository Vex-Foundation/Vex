/**
 * Incremental block-level markdown lexing for an append-only text stream.
 *
 * Re-lexing the whole accumulated document on every streamed delta is
 * quadratic in the final reply length. Block lexing is line-based and
 * appended text can only reshape the parse frontier — the last top-level
 * block (a paragraph becoming a setext heading or a table, a list continuing
 * after a blank line, an unclosed fence swallowing lines) — so earlier blocks
 * are final. This lexer therefore freezes all but the trailing
 * {@link UNSTABLE_TAIL_BLOCKS} blocks and re-lexes only the source tail
 * behind them: each source region is lexed O(1) times over the stream
 * instead of once per delta.
 *
 * marked's tokens carry no position offsets; each token's `raw` is its exact
 * source slice, so offsets are the cumulative raw lengths. The freeze
 * boundary sits at the END offset of the last frozen block, which keeps the
 * inter-block blank lines in the tail so the sliced source stays verbatim.
 * When the raw concatenation does not reconstruct the lexed slice (a grammar
 * deviation), nothing is frozen that update — soundness over speed.
 *
 * DISPLAY ONLY: this feeds the live preview renderer and never touches
 * content going to the model.
 */

import type { Token } from "marked";

/**
 * Trailing blocks kept unstable. Appended text reshapes at most the last
 * block; the second-to-last is retained as safety margin so a freeze decision
 * never has to reason about the parse frontier.
 */
export const UNSTABLE_TAIL_BLOCKS = 2;

/** A top-level token plus a render key that is stable across deltas. */
export interface PositionedToken {
  readonly token: Token;
  /**
   * The block's start offset in the full source text. Stable from the frame
   * a block first appears through freezing, so React reconciles rather than
   * remounts when a block crosses the freeze boundary.
   */
  readonly key: number;
}

/** One {@link IncrementalMarkdownLexer.update} result. */
export interface IncrementalTokens {
  /** Blocks that can no longer change; grows monotonically per generation. */
  readonly frozen: readonly PositionedToken[];
  /** The re-lexed unstable tail. */
  readonly tail: readonly PositionedToken[];
  /** Bumped whenever non-append input discards the frozen prefix; callers drop caches keyed on it. */
  readonly generation: number;
}

/**
 * Append-only incremental lexer over a caller-supplied grammar. One instance
 * accumulates one streaming document; non-append input resets it.
 */
export class IncrementalMarkdownLexer {
  private prevText = "";
  private tailStart = 0;
  private frozen: PositionedToken[] = [];
  private generation = 0;
  private cached: IncrementalTokens | null = null;

  /** @param lex - grammar shared with whatever renders the tokens, so boundaries agree. */
  constructor(private readonly lex: (text: string) => readonly Token[]) {}

  /**
   * Fold the current accumulated text and return the frozen/tail split.
   * Idempotent for identical input, so render paths may re-invoke it.
   */
  update(text: string): IncrementalTokens {
    if (this.cached !== null && text === this.prevText) return this.cached;
    // Deliberate O(prefix) comparison per update: sound divergence detection
    // has to verify the whole retained prefix, and startsWith compares bytes
    // orders of magnitude faster than lexing them.
    if (!text.startsWith(this.prevText)) {
      this.prevText = "";
      this.tailStart = 0;
      this.frozen = [];
      this.generation += 1;
    }
    this.prevText = text;
    const base = this.tailStart;
    const tokens = this.lex(text.substring(base));
    // Offsets from cumulative raw lengths; bail out of freezing entirely if
    // the raws do not reconstruct the slice (offset math would be wrong).
    const starts: number[] = [];
    let cursor = 0;
    for (const token of tokens) {
      starts.push(base + cursor);
      cursor += token.raw.length;
    }
    const reconstructs = cursor === text.length - base;
    // marked interleaves "space" tokens between blocks; the unstable margin
    // counts CONTENT blocks (an all-space margin would defend nothing), so
    // walk back until UNSTABLE_TAIL_BLOCKS content tokens are inside the tail.
    let firstUnstable = tokens.length;
    let contentInTail = 0;
    while (firstUnstable > 0 && contentInTail < UNSTABLE_TAIL_BLOCKS) {
      const candidate = tokens[firstUnstable - 1];
      if (candidate === undefined) break;
      firstUnstable -= 1;
      if (candidate.type !== "space") contentInTail += 1;
    }
    if (contentInTail < UNSTABLE_TAIL_BLOCKS || !reconstructs) firstUnstable = 0;
    if (firstUnstable > 0) {
      for (let i = 0; i < firstUnstable; i += 1) {
        const token = tokens[i];
        const start = starts[i];
        if (token === undefined || start === undefined) break;
        this.frozen.push({ token, key: start });
      }
      const lastFrozenStart = starts[firstUnstable - 1];
      const lastFrozen = tokens[firstUnstable - 1];
      if (lastFrozenStart !== undefined && lastFrozen !== undefined) {
        this.tailStart = lastFrozenStart + lastFrozen.raw.length;
      }
    }
    const tail: PositionedToken[] = [];
    for (let i = firstUnstable; i < tokens.length; i += 1) {
      const token = tokens[i];
      const start = starts[i];
      if (token === undefined || start === undefined) continue;
      tail.push({ token, key: start });
    }
    this.cached = { frozen: [...this.frozen], tail, generation: this.generation };
    return this.cached;
  }
}
