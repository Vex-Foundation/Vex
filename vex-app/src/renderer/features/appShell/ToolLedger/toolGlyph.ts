/**
 * Tool name → ledger glyph (S5). The act ledger registers the CATEGORY of an
 * act at a glance; the exact tool name sits next to the glyph, so a coarse,
 * ordered keyword match is enough — no registry round-trip, no new IPC.
 * Pure function: trivially unit-testable, no React.
 */

import type { ComponentType } from "react";
import {
  type GlyphProps,
  IconGlobe,
  IconWallet,
  IconBrain,
  IconCable,
  IconFile,
  IconRefresh,
  IconSearch,
  IconTerminal,
  IconWrench,
} from "../../../components/icons/index.js";

/**
 * Ordered rules — first match wins, so the more specific intent keywords sit
 * above the broader ones (e.g. "search" beats "web" for `web_search`).
 *
 * The money rules sit at the top because a protocol act now arrives as its
 * dotted toolId (`relay.bridge`, `kyberswap.swap.quote`) and would otherwise
 * collapse into one anonymous wrench in the group header strip. Cosmetic only:
 * a curated namespace renders its own logo and never reaches this function.
 */
const GLYPH_RULES: readonly (readonly [RegExp, ComponentType<GlyphProps>])[] = [
  [/bridge/, IconCable],
  [/swap|trade|quote/, IconRefresh],
  [/search/, IconSearch],
  [/web|browse/, IconGlobe],
  [/terminal|exec|shell/, IconTerminal],
  [/file/, IconFile],
  [/memory|recall|knowledge/, IconBrain],
  [/wallet|chain|balance/, IconWallet],
];

/** Resolve the glyph for a sanitized tool name; wrench is the fallback act. */
export function toolGlyph(toolName: string): ComponentType<GlyphProps> {
  const name = toolName.toLowerCase();
  for (const [pattern, icon] of GLYPH_RULES) {
    if (pattern.test(name)) return icon;
  }
  return IconWrench;
}
