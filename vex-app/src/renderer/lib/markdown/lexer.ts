/**
 * The one markdown lexer the renderer uses: the settled body, the streaming
 * preview and the plain-text projection all tokenize through it, so they
 * always agree on what is markup.
 *
 * It is `marked`'s GFM lexer with one change: strikethrough needs a DOUBLE
 * tilde. `marked` also strikes `~text~`, and assistant replies use a single
 * `~` for "approximately" ("within ~$3 ... (~$45M combined)"), which crossed
 * out everything between two such amounts. `~~text~~` still strikes; a single
 * `~` is literal text.
 */

import { Marked, type Token } from "marked";

const markdown = new Marked({
  tokenizer: {
    del(src) {
      // false hands `~~` to marked's own rule; undefined means "not a
      // strikethrough here", so the tilde stays text.
      return src.startsWith("~~") ? false : undefined;
    },
  },
});

/** Tokenize markdown. Throws when `marked` does; callers degrade to the raw text. */
export function lexMarkdown(text: string): Token[] {
  return markdown.lexer(text);
}
