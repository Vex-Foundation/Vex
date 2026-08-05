/**
 * Wire tool NAME -> canonical dotted toolId, at the main boundary.
 *
 * The model calls a discovered protocol manifest under an OpenAI-legal name
 * (`kyberswap.swap.quote` -> `kyberswap__swap__quote`,
 * `src/vex-agent/tools/registry/injected-protocol-tools.ts`). Everything that
 * SHOWS a tool to a human — the transcript DTO, the live stream preview, the
 * Markdown export — must show the dotted id, the same rule the approval
 * preview already follows (`engine/core/approval-intent-preview.ts`, "The human
 * must still see the dotted toolId, never the wire-safe mapped name").
 *
 * Resolution goes through the ENGINE's own resolver, not a copy of the codec:
 * a name the live catalog cannot resolve — an internal tool, a typo, a
 * hallucinated id — is returned VERBATIM, so an unresolvable call keeps its raw
 * name and can never borrow a venue's identity downstream.
 *
 * Case-preserving by construction: the manifest's own `toolId` is returned.
 * Nothing here may lower-case a name before resolving it — 14 real toolIds are
 * camelCase (`dexscreener.tokenPairs`, `pendle.lp.toPt`, …).
 */

import { resolveInjectedProtocolTool } from "@vex-agent/tools/registry/injected-protocol-tools.js";

export function canonicalToolName(name: string): string {
  return resolveInjectedProtocolTool(name)?.toolId ?? name;
}
