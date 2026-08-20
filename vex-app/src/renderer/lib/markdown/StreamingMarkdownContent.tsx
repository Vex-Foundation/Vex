/**
 * Streaming variant of `MarkdownContent` for a live, append-only text stream.
 * Blocks behind the parse frontier are lexed once and their rendered React
 * nodes cached by stream-stable key (`incremental.ts`); only the unstable
 * tail re-lexes and re-renders per delta, so a long reply streams at constant
 * cost instead of re-lexing the whole document every tick. Same hardened
 * renderer, same no-HTML-sink guarantee, same `.vex-chat-prose` register as
 * the settled row this preview becomes.
 */

import { lexer, type Token } from "marked";
import { useRef, type JSX, type ReactNode } from "react";
import { IncrementalMarkdownLexer } from "./incremental.js";
import {
  renderBlock,
  type RenderOptions,
} from "./MarkdownContent/render-tokens.js";

const CHAT_OPTS: RenderOptions = { variant: "chat" };

interface FrozenCache {
  generation: number;
  nodes: Map<number, ReactNode>;
}

export function StreamingMarkdownContent({
  text,
}: {
  readonly text: string;
}): JSX.Element {
  const parserRef = useRef<IncrementalMarkdownLexer | null>(null);
  parserRef.current ??= new IncrementalMarkdownLexer(
    (source: string): readonly Token[] => {
      try {
        return lexer(source);
      } catch {
        // Degrade to one opaque text token — rendered pre-wrapped verbatim by
        // the default branch, mirroring MarkdownContent's lexer-failure path.
        return [{ type: "failed", raw: source, text: source } as Token];
      }
    },
  );
  const cacheRef = useRef<FrozenCache>({ generation: 0, nodes: new Map() });

  const { frozen, tail, generation } = parserRef.current.update(text);
  const cache = cacheRef.current;
  if (cache.generation !== generation) {
    cache.generation = generation;
    cache.nodes.clear();
  }
  const frozenNodes = frozen.map((block) => {
    const cached = cache.nodes.get(block.key);
    if (cached !== undefined) return cached;
    const node = (
      <FrozenBlock key={block.key} token={block.token} />
    );
    cache.nodes.set(block.key, node);
    return node;
  });

  return (
    <div className="vex-chat-prose flex flex-col gap-2 break-words">
      {frozenNodes}
      {tail.map((block) => (
        <FrozenBlock key={block.key} token={block.token} />
      ))}
    </div>
  );
}

/** One rendered block; keyed by absolute source offset by the caller. */
function FrozenBlock({ token }: { readonly token: Token }): JSX.Element {
  return <>{renderBlock(token, 0, CHAT_OPTS)}</>;
}
