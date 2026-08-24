/**
 * Markdown-to-plain-text projection for copy-message and compact labels.
 * Tokenizes with the SAME `marked` lexer the renderer uses, so the projection
 * strips exactly the markup the renderer would draw: links keep their labels,
 * images keep alt text, code keeps its source text, raw HTML stays literal.
 *
 * DISPLAY ONLY (owner decree): this projection feeds the clipboard and UI
 * labels — it must NEVER touch content going TO the model.
 */

import { lexer, type Token, type Tokens } from "marked";

function inlineText(token: Token): string {
  switch (token.type) {
    case "text":
      return token.tokens !== undefined
        ? token.tokens.map(inlineText).join("")
        : token.text;
    case "escape":
    case "codespan":
      return token.text;
    case "strong":
    case "em":
    case "del":
    case "link":
      return (token.tokens ?? []).map(inlineText).join("");
    case "image":
      return token.text ?? "";
    case "br":
      return "\n";
    default:
      return "text" in token && typeof token.text === "string"
        ? token.text
        : token.raw;
  }
}

function compactInline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** marked's union widens "list"/"table" to `| Generic`; prove the fields. */
function isList(token: Token): token is Tokens.List {
  return token.type === "list" && Array.isArray((token as Partial<Tokens.List>).items);
}

function isTable(token: Token): token is Tokens.Table {
  return token.type === "table" && Array.isArray((token as Partial<Tokens.Table>).rows);
}

function listText(token: Tokens.List): string {
  return token.items
    .map((item: Tokens.ListItem) =>
      item.tokens
        .filter((t: Token) => t.type !== "checkbox")
        .map(blockText)
        .filter((t) => t !== "")
        .join(" "),
    )
    .filter((t) => t !== "")
    .join("\n");
}

function tableText(token: Tokens.Table): string {
  const row = (cells: readonly Tokens.TableCell[]): string =>
    cells.map((cell) => compactInline(cell.tokens.map(inlineText).join(""))).join("\t");
  return [row(token.header), ...token.rows.map(row)].join("\n");
}

function blockText(token: Token): string {
  switch (token.type) {
    case "space":
    case "hr":
      return "";
    case "paragraph":
    case "heading":
      return compactInline((token.tokens ?? []).map(inlineText).join(""));
    case "code":
      return token.text.trim();
    case "blockquote":
      return (token.tokens ?? [])
        .map(blockText)
        .filter((t) => t !== "")
        .join("\n\n");
    case "list":
      return isList(token) ? listText(token) : token.raw;
    case "table":
      return isTable(token) ? tableText(token) : token.raw;
    case "text":
      return compactInline(
        token.tokens !== undefined
          ? token.tokens.map(inlineText).join("")
          : token.text,
      );
    default:
      return "text" in token && typeof token.text === "string"
        ? token.text
        : token.raw;
  }
}

/**
 * Parse the markdown, drop its presentation markup, and return readable plain
 * text: blocks separated by blank lines, runs of blank lines collapsed. A
 * lexer failure degrades to the original text verbatim, never to nothing.
 */
export function extractMarkdownPlainText(markdown: string): string {
  let tokens: readonly Token[];
  try {
    tokens = lexer(markdown);
  } catch {
    return markdown;
  }
  return tokens
    .map(blockText)
    .filter((t) => t !== "")
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
