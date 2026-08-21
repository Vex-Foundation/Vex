/**
 * Token tree → React nodes. Every text leaf becomes an auto-escaped React
 * node — there is no HTML sink anywhere in this walk. Raw-HTML and
 * unsupported tokens render as escaped text.
 */

import type { Token, Tokens } from "marked";
import { useState } from "react";
import type { JSX, ReactNode } from "react";
import { CodeBlock } from "./CodeBlock.js";
import { safeArticleImgSrc, safeHref, safeImgSrc } from "./url-safety.js";

/**
 * Render options threaded through the token walk. `chat` (default) is the
 * hardened assistant-output path. `article` restyles headings for long-form
 * static docs and allows local bundled images via `safeArticleImgSrc`.
 */
export interface RenderOptions {
  readonly variant: "chat" | "article";
}

function tokenText(token: Token): string {
  if ("text" in token && typeof token.text === "string") return token.text;
  return token.raw;
}

export function renderInline(
  tokens: readonly Token[] | undefined,
  opts: RenderOptions,
): ReactNode[] {
  if (tokens === undefined) return [];
  return tokens.map((token, i) => {
    switch (token.type) {
      case "text":
        return token.tokens !== undefined ? (
          <span key={i}>{renderInline(token.tokens, opts)}</span>
        ) : (
          token.text
        );
      case "escape":
        return token.text;
      case "strong":
        return (
          <strong key={i} className="font-semibold">
            {renderInline(token.tokens, opts)}
          </strong>
        );
      case "em":
        return (
          <em key={i} className="italic">
            {renderInline(token.tokens, opts)}
          </em>
        );
      case "del":
        return <del key={i}>{renderInline(token.tokens, opts)}</del>;
      case "codespan":
        return (
          <code
            key={i}
            className="rounded-[3px] bg-interactive-hover px-1.5 py-0.5 font-mono text-[13px]"
          >
            {token.text}
          </code>
        );
      case "br":
        return <br key={i} />;
      case "link": {
        const href = safeHref(token.href);
        const children = renderInline(token.tokens, opts);
        return href !== null ? (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--vex-accent-text)] underline underline-offset-2"
          >
            {children}
          </a>
        ) : (
          <span key={i}>{children}</span>
        );
      }
      case "image": {
        // Remote images are DISABLED for launch: `safeImgSrc` returns null for
        // every source, so chat always takes the alt-text branch below (CSP
        // img-src exfiltration channel closed). The `MarkdownImage` branch is
        // intentionally DORMANT (kept for the post-launch tool-sourced-URL
        // allowlist restore), not dead code. The `article` variant (static
        // repo docs only, never model output) renders local bundled assets
        // through `safeArticleImgSrc`.
        const safe =
          opts.variant === "article"
            ? safeArticleImgSrc(token.href)
            : safeImgSrc(token.href);
        const alt = token.text ?? "";
        return safe !== null ? (
          <MarkdownImage key={i} src={safe} alt={alt} />
        ) : (
          // Source rejected → keep the original alt-text-only behavior.
          <span key={i}>{token.text}</span>
        );
      }
      default:
        // Raw HTML + anything unsupported → escaped text node.
        return <span key={i}>{tokenText(token)}</span>;
    }
  });
}

export function renderBlock(
  token: Token,
  key: number,
  opts: RenderOptions,
): ReactNode {
  switch (token.type) {
    case "space":
      return null;
    case "paragraph":
      return <p key={key}>{renderInline(token.tokens, opts)}</p>;
    case "heading": {
      // Article variant: long-form static docs earn REAL heading elements in
      // the serif editorial voice. Chat keeps its original semantic decision
      // (no h-tags in chat prose).
      if (opts.variant === "article") {
        if (token.depth <= 2) {
          return (
            <h2 key={key} className="mt-8 font-serif text-[22px] font-normal text-foreground">
              {renderInline(token.tokens, opts)}
            </h2>
          );
        }
        // Protocol-entry heading — "### ![Name](/protocols/x.png) Name":
        // a leading LOCAL bundled logo renders as a trustworthy card head
        // (44px rounded-lg mark + serif name beside it), never a raw inline
        // image dump (owner correction 2026-07-20). The logo stays behind
        // `safeArticleImgSrc`; a rejected source falls through to the plain
        // text heading below.
        const inline = token.tokens ?? [];
        const lead = inline[0];
        if (lead !== undefined && lead.type === "image") {
          const logoSrc = safeArticleImgSrc(lead.href);
          if (logoSrc !== null) {
            return (
              <h3
                key={key}
                className="mt-9 flex items-center gap-3.5 text-foreground"
              >
                {/* aria-hidden: the name text beside the mark carries the
                 * accessible heading; alt would duplicate it. */}
                <img
                  src={logoSrc}
                  alt=""
                  aria-hidden
                  draggable={false}
                  loading="lazy"
                  decoding="async"
                  className="h-11 w-11 shrink-0 rounded-lg border border-[var(--vex-line)] object-cover"
                />
                <span className="font-serif text-[21px] font-normal leading-tight">
                  {renderInline(inline.slice(1), opts)}
                </span>
              </h3>
            );
          }
        }
        return (
          <h3 key={key} className="mt-5 text-[15.5px] font-semibold text-foreground">
            {renderInline(token.tokens, opts)}
          </h3>
        );
      }
      // Chat headings keep their original semantic decision (no h-tags in
      // chat prose); the Inter Tight document scale carries the hierarchy
      // (h1 700 24/34, h2 600 20/28, h3+ 600 17/24 — design-language §4).
      return (
        <p
          key={key}
          className={
            token.depth === 1
              ? "mt-5 text-[24px] font-bold leading-[34px] text-foreground"
              : token.depth === 2
                ? "mt-5 text-[20px] font-semibold leading-[28px] text-foreground"
                : "mt-4 text-[17px] font-semibold leading-[24px] text-foreground"
          }
        >
          {renderInline(token.tokens, opts)}
        </p>
      );
    }
    case "code":
      return (
        <CodeBlock key={key} lang={codeLang(token.lang)} code={token.text} />
      );
    case "blockquote":
      return (
        <blockquote
          key={key}
          className="border-l-2 border-[var(--vex-line-strong)] pl-3 text-[var(--vex-text-2)]"
        >
          {renderBlocks(token.tokens ?? [], opts)}
        </blockquote>
      );
    case "list": {
      const items = token.items.map((item: Tokens.ListItem, i: number) =>
        item.task ? (
          // GFM task list item — a non-interactive (disabled, non-focusable)
          // checkbox reflecting `[x]`/`[ ]`, plus the item content. marked emits
          // a separate `checkbox` token at the head of `item.tokens`; drop it so
          // the literal marker isn't rendered alongside the visual checkbox.
          <li key={i} className="flex list-none items-start gap-2">
            <input
              type="checkbox"
              checked={item.checked === true}
              disabled
              aria-hidden
              className="mt-1.5 accent-[var(--vex-accent)]"
            />
            <span className="min-w-0">
              {renderBlocks(
                item.tokens.filter((t: Token) => t.type !== "checkbox"),
                opts,
              )}
            </span>
          </li>
        ) : (
          <li key={i}>{renderBlocks(item.tokens, opts)}</li>
        ),
      );
      const hasTask = token.items.some((item: Tokens.ListItem) => item.task);
      return token.ordered ? (
        <ol
          key={key}
          start={typeof token.start === "number" ? token.start : undefined}
          className="list-decimal pl-5"
        >
          {items}
        </ol>
      ) : (
        <ul key={key} className={hasTask ? "flex flex-col gap-1" : "list-disc pl-5"}>
          {items}
        </ul>
      );
    }
    case "hr":
      return <hr key={key} className="border-[var(--vex-line)]" />;
    case "text":
      return (
        <p key={key}>
          {token.tokens !== undefined
            ? renderInline(token.tokens, opts)
            : tokenText(token)}
        </p>
      );
    case "table": {
      // GFM table → semantic <table>. Cells render through renderInline, so
      // their content stays escaped React text (same no-HTML-sink guarantee).
      const align = token.align ?? [];
      const alignClass = (i: number): string =>
        align[i] === "center"
          ? "text-center"
          : align[i] === "right"
            ? "text-right"
            : "text-left";
      return (
        <div key={key} className="overflow-x-auto">
          <table className="w-full border-collapse text-[0.95em]">
            <thead>
              <tr>
                {token.header.map((cell: Tokens.TableCell, i: number) => (
                  <th
                    key={i}
                    className={`border-b border-[var(--vex-line-strong)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-2)] ${alignClass(i)}`}
                  >
                    {renderInline(cell.tokens, opts)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {token.rows.map((cells: Tokens.TableCell[], r: number) => (
                <tr key={r}>
                  {cells.map((cell: Tokens.TableCell, c: number) => (
                    <td
                      key={c}
                      className={`border-b border-[var(--vex-line)] px-2 py-1 align-top ${alignClass(c)}`}
                    >
                      {renderInline(cell.tokens, opts)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default:
      // raw HTML + anything still unsupported → escaped text, never elements.
      return (
        <p key={key} className="whitespace-pre-wrap break-words">
          {tokenText(token)}
        </p>
      );
  }
}

export function renderBlocks(
  tokens: readonly Token[],
  opts: RenderOptions,
): ReactNode[] {
  return tokens.map((token, i) => renderBlock(token, i, opts));
}

/** First word of the fence info string ("ts foo" → "ts"); "code" when absent. */
function codeLang(raw: string | undefined): string {
  const first = raw?.trim().split(/\s+/)[0];
  return first !== undefined && first.length > 0 ? first : "code";
}

/**
 * Hardened token-logo image. INTENTIONALLY DORMANT for launch: `safeImgSrc`
 * returns null for every source, so this component is never rendered right now.
 * It is kept (NOT dead code) for the post-launch remote-logo restore via a
 * tool-sourced-URL allowlist. When live, the src is pre-validated by
 * `safeImgSrc`; `referrerPolicy="no-referrer"` suppresses the referrer (this
 * document's URL), NOT the image request URL itself; size is CSS-bounded so a
 * hostile dimension can't blow out the layout; on a load error we drop back to
 * the alt text rather than showing a broken glyph.
 */
function MarkdownImage({
  src,
  alt,
}: {
  readonly src: string;
  readonly alt: string;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed) return <span>{alt}</span>;
  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="inline-block max-h-[5rem] max-w-[5rem] rounded-[4px] align-text-bottom"
    />
  );
}
