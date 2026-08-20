/**
 * MarkdownContent — render assistant markdown WITHOUT ever producing an HTML
 * string. The build pipeline bans `dangerouslySetInnerHTML`
 * (`scripts/check-build-artifacts.mjs`), so `marked` is used ONLY as a
 * tokenizer (`lexer`) and the token tree is rendered to React elements
 * (`MarkdownContent/render-tokens.tsx`); URL hardening lives in
 * `MarkdownContent/url-safety.ts`. If `lexer` throws, the original text is
 * shown verbatim, never blanked.
 */

import { lexer, type Token } from "marked";
import { useMemo } from "react";
import type { JSX } from "react";
import {
  renderBlocks,
  type RenderOptions,
} from "./MarkdownContent/render-tokens.js";

export {
  safeArticleImgSrc,
  safeHref,
  safeImgSrc,
} from "./MarkdownContent/url-safety.js";

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
  // MEMOIZED ON THE TEXT (owner decree 2026-08-03 — streaming speed). The lex
  // + block render is the expensive half of a streamed token: unmemoized, a
  // preview tick re-lexed this body, and every OTHER assistant row in the
  // transcript re-lexed with it, which is what made a long conversation stream
  // slower the longer it got. Memoized, only the body whose text actually
  // changed pays. A lexer failure degrades to plain text, inside the memo so
  // the fallback is not recomputed either.
  const rendered = useMemo(() => {
    const opts: RenderOptions = { variant };
    let tokens: readonly Token[];
    try {
      tokens = lexer(text);
    } catch {
      return null;
    }
    return renderBlocks(tokens, opts);
  }, [text, variant]);

  if (rendered === null) {
    return <p className="whitespace-pre-wrap break-words">{text}</p>;
  }
  return (
    // THE READING REGISTER: chat body copy runs through `.vex-chat-prose`,
    // which pins the prose face/scale and the technical opt-outs (code/pre
    // stay mono, tables stay sans + tabular-nums) — ONE class here rather
    // than per-node utilities. The `article` variant is long-form static repo
    // markdown with its own heading scale and stays on the support face.
    <div
      className={`flex flex-col gap-2 break-words${
        variant === "chat" ? " vex-chat-prose" : ""
      }`}
    >
      {rendered}
    </div>
  );
}
