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
 *
 * ── RETIRED NAMES STILL RESOLVE, and that is the point ────────────────────
 *
 * The live catalog is the resolver, so a RETIRED tool stops resolving the day
 * its manifest is deleted - and every transcript that ever called it then
 * renders the raw wire name instead of the identity the ledger maps. Old
 * transcripts are exactly what this function exists to show, so the retirement
 * carries its own frozen table beside it.
 */

import { resolveInjectedProtocolTool } from "@vex-agent/tools/registry/injected-protocol-tools.js";

/**
 * The ten Trench Express public names, frozen at the shape the model was offered
 * before migration 108 deleted their manifests.
 *
 * WHY A LITERAL TABLE and not a codec. Inverting `__` back to `.` is unsound
 * under the public-name grammar (`kyberswap__swap_quote` inverts to
 * `kyberswap.SwapQuote`, not the immutable `kyberswap.swap.quote`), which is why
 * the live path resolves through the manifest rather than a mapping. A retired
 * namespace has no manifest left, so the pairs are written out - copied verbatim
 * from the deleted `tool-surface-spec/mappings/trench.json`, which is where they
 * were reviewed.
 *
 * DISPLAY ONLY. Nothing dispatches on this: `execute_tool` resolves through the
 * catalog, and a retired toolId finds nothing there. This table decides one
 * thing, which is what a human reading their own history sees.
 *
 * It only ever shrinks, and only when transcripts stop being retained.
 */
const RETIRED_PUBLIC_NAMES: Readonly<Record<string, string>> = {
  trench__tokens_discover: "trench.tokens",
  trench__tokens_search: "trench.search",
  trench__token_trades_list: "trench.trades",
  trench__images_list: "trench.images",
  trench__my_launches_list: "trench.my_launches",
  trench__trade_quote: "trench.trade_quote",
  trench__trade_execute: "trench.trade_execute",
  trench__launch_preview: "trench.launch_preview",
  trench__launch_request_form: "trench.launch_request_form",
  trench__launch_execute: "trench.launch_execute",
};

export function canonicalToolName(name: string): string {
  const live = resolveInjectedProtocolTool(name)?.toolId;
  if (live !== undefined) return live;
  // The live catalog wins on every name it knows, so a retired entry can never
  // shadow a tool that still exists.
  return RETIRED_PUBLIC_NAMES[name] ?? name;
}
