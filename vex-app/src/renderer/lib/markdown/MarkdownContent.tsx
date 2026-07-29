/**
 * MarkdownContent (stage 8-2a) — render assistant markdown WITHOUT ever
 * producing an HTML string.
 *
 * The build pipeline bans `dangerouslySetInnerHTML`
 * (`scripts/check-build-artifacts.mjs`), so `marked` is used ONLY as a
 * tokenizer (`lexer`) and the token tree is rendered to React elements. Text
 * becomes auto-escaped React nodes — there is no HTML sink, so DOMPurify is
 * unnecessary. Hardening:
 *   - links: absolute `https:` only (`safeHref`); anything else renders as
 *     plain text. Allowed links get `target="_blank" rel="noopener noreferrer"`
 *     and main's `shell.openExternal` allowlist stays the final gate;
 *   - images: remote images are DISABLED for launch to close the CSP img-src
 *     exfiltration channel (see docs/audit/vexapp-prerelease-audit.md, finding
 *     W1). Token logos fall back to alt text. Restore remote logos post-launch
 *     via a tool-sourced-URL allowlist (render only image URLs that appeared in
 *     a validated tool response), NOT a host allowlist. `safeImgSrc` now returns
 *     null for every source, so every markdown image renders its alt text only;
 *   - GFM tables + task lists render as semantic elements (cells/items go
 *     through the same escaped-React-text path — no HTML sink);
 *   - raw-HTML and any still-unsupported tokens render as escaped text;
 *   - if `lexer` throws, the original text is shown verbatim, never blanked;
 *   - the code-block copy key (S3) writes the token's raw string straight to
 *     the clipboard API — no HTML sink is introduced.
 */

import { lexer, type Token } from "marked";
import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Copy01Icon, VexIcon } from "../../components/icons/index.js";

/** ASCII control chars (U+0000–U+001F) and DEL (U+007F) are never valid in a URL. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Allow only absolute https: URLs; everything else → render as plain text. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;
  if (hasControlChars(trimmed)) return null;
  if (trimmed.startsWith("//")) return null; // protocol-relative
  try {
    const url = new URL(trimmed); // throws on relative (no base)
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Image-source gate. Remote images are DISABLED for launch to close the CSP
 * img-src exfiltration channel (docs/audit/vexapp-prerelease-audit.md, finding
 * W1): a prompt-injected model could otherwise emit a markdown `<img>` whose URL
 * smuggles a wallet address / portfolio to an attacker host via a GET that
 * `connect-src 'self'` does not stop. So this gate rejects EVERY source and the
 * caller renders alt text via the existing fallback.
 *
 * Post-launch restore is NOT a re-widen of this old host check — it is a
 * tool-sourced-URL allowlist (render only image URLs that appeared verbatim in
 * a validated tool response). Build that instead of reintroducing arbitrary-host
 * loading; `MarkdownImage` (kept dormant below) is the hardened `<img>` it will
 * feed.
 */
export function safeImgSrc(_raw: string): string | null {
  return null;
}

/**
 * Local BUNDLED-asset image gate for the `article` variant ONLY (static repo
 * markdown such as the "How Vex works" guide — never model output; chat stays
 * on `safeImgSrc`, which rejects everything). Accepts exactly one shape: a
 * root-relative path into the renderer's own public/ assets. No scheme, no
 * host, no `..`, no query/fragment — a same-origin GET to a bundled file
 * cannot reach an attacker host, so the W1 exfiltration channel stays closed.
 */
export function safeArticleImgSrc(raw: string): string | null {
  const trimmed = raw.trim();
  if (hasControlChars(trimmed)) return null;
  if (!/^\/[A-Za-z0-9_/-]+\.(?:png|svg|jpg|jpeg|webp)$/.test(trimmed)) {
    return null;
  }
  // The character class above already excludes "." path segments; the "//"
  // check closes the protocol-relative shape a doubled separator would allow.
  if (trimmed.includes("//")) return null;
  return trimmed;
}

/**
 * Render options threaded through the token walk. `chat` (default) is the
 * hardened assistant-output path — behavior unchanged. `article` restyles
 * headings for long-form static docs (serif h2s) and allows local bundled
 * images via `safeArticleImgSrc`.
 */
interface RenderOptions {
  readonly variant: "chat" | "article";
}

function tokenText(token: Token): string {
  if ("text" in token && typeof token.text === "string") return token.text;
  return token.raw;
}

function renderInline(
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
            className="rounded-[3px] bg-white/[0.06] px-1.5 py-0.5 font-mono text-[13px]"
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
        // Remote images are DISABLED for launch: `safeImgSrc` now returns null
        // for every source, so this always takes the alt-text branch below and
        // closes the CSP img-src exfiltration channel (a hostile model could
        // otherwise smuggle a wallet address/portfolio out via an <img> GET).
        // The `MarkdownImage` branch is intentionally DORMANT (kept for the
        // post-launch tool-sourced-URL allowlist restore), not dead code — for
        // CHAT. The `article` variant (static repo docs only, never model
        // output) renders local bundled assets through `safeArticleImgSrc`.
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

function renderBlock(token: Token, key: number, opts: RenderOptions): ReactNode {
  switch (token.type) {
    case "space":
      return null;
    case "paragraph":
      return <p key={key}>{renderInline(token.tokens, opts)}</p>;
    case "heading": {
      // Article variant: long-form static docs earn REAL heading elements in
      // the Chronos editorial voice (serif h2s). Chat keeps its original
      // semantic decision (no h-tags in chat prose) — S3 restyles the
      // document scale only: h1/h2-level lead, h3+ subordinate.
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
      return (
        <p
          key={key}
          className={
            token.depth <= 2
              ? "mt-5 text-[17px] font-semibold text-foreground"
              : "text-[15px] font-semibold text-foreground"
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
          {renderBlocks(token.tokens, opts)}
        </blockquote>
      );
    case "list": {
      const items = token.items.map((item, i) =>
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
                item.tokens.filter((t) => t.type !== "checkbox"),
                opts,
              )}
            </span>
          </li>
        ) : (
          <li key={i}>{renderBlocks(item.tokens, opts)}</li>
        ),
      );
      const hasTask = token.items.some((item) => item.task);
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
                {token.header.map((cell, i) => (
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
              {token.rows.map((cells, r) => (
                <tr key={r}>
                  {cells.map((cell, c) => (
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

function renderBlocks(tokens: readonly Token[], opts: RenderOptions): ReactNode[] {
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
 * document's URL), NOT the image request URL itself;
 * size is CSS-bounded so a hostile dimension can't blow out the layout; on a
 * load error we drop back to the alt text rather than showing a broken glyph.
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

const COPY_RESET_MS = 1_500;

/**
 * Fenced code block — recessed case file (S3): hairline wrapper on the
 * surface-down well with a language strip + copy key. The copy button writes
 * the token's RAW string via the clipboard API — it never re-enters the React
 * tree, so the no-HTML-sink invariant is untouched.
 */
function CodeBlock({
  lang,
  code,
}: {
  readonly lang: string;
  readonly code: string;
}): JSX.Element {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The reset timer must not fire setState after unmount.
  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      // Clipboard can be denied/unavailable — surface it instead of lying.
      setCopyState("failed");
    }
    if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopyState("idle"), COPY_RESET_MS);
  };

  return (
    <div className="overflow-hidden rounded-[10px] border border-[var(--vex-line)] bg-[var(--vex-surface-down)]">
      <div className="flex h-7 items-center justify-between border-b border-[var(--vex-line)] px-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
          {lang}
        </span>
        <button
          type="button"
          aria-label="Copy code"
          onClick={() => void onCopy()}
          className="flex items-center text-[var(--vex-text-3)] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          {copyState === "idle" ? (
            <VexIcon icon={Copy01Icon} size={12} aria-hidden />
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-[0.14em]">
              {copyState === "copied" ? "Copied" : "Copy failed"}
            </span>
          )}
        </button>
      </div>
      <pre className="max-h-[480px] overflow-auto px-4 py-3 font-mono text-[12.5px] leading-[1.6] text-[var(--vex-text-2)]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function MarkdownContent({
  text,
  variant = "chat",
}: {
  readonly text: string;
  /**
   * `chat` (default) = hardened assistant-output rendering, unchanged.
   * `article` = long-form STATIC repo markdown (e.g. the "How Vex works"
   * guide): serif h2 headings + local bundled images. Never pass `article`
   * for model output — the image gate difference is the whole point.
   */
  readonly variant?: "chat" | "article";
}): JSX.Element {
  const opts: RenderOptions = { variant };
  let tokens: readonly Token[];
  try {
    tokens = lexer(text);
  } catch {
    return <p className="whitespace-pre-wrap break-words">{text}</p>;
  }
  return (
    <div className="flex flex-col gap-2 break-words">
      {renderBlocks(tokens, opts)}
    </div>
  );
}
