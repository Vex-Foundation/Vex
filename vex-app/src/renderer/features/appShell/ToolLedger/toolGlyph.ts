/**
 * Tool name → ledger glyph (S5). The act ledger registers the CATEGORY of an
 * act at a glance; the exact tool name sits next to the glyph, so a coarse,
 * ordered keyword match is enough — no registry round-trip, no new IPC.
 * Pure function: trivially unit-testable, no React.
 */

import {
  AiWebBrowsingIcon,
  BitcoinWalletIcon,
  Brain01Icon,
  File01Icon,
  type IconGlyph,
  Search01Icon,
  TerminalIcon,
  Wrench01Icon,
} from "../../../components/icons/index.js";

/**
 * Ordered rules — first match wins, so the more specific intent keywords sit
 * above the broader ones (e.g. "search" beats "web" for `web_search`).
 */
const GLYPH_RULES: readonly (readonly [RegExp, IconGlyph])[] = [
  [/search/, Search01Icon],
  [/web|browse/, AiWebBrowsingIcon],
  [/terminal|exec|shell/, TerminalIcon],
  [/file/, File01Icon],
  [/memory|recall|knowledge/, Brain01Icon],
  [/wallet|chain|balance/, BitcoinWalletIcon],
];

/** Resolve the glyph for a sanitized tool name; wrench is the fallback act. */
export function toolGlyph(toolName: string): IconGlyph {
  const name = toolName.toLowerCase();
  for (const [pattern, icon] of GLYPH_RULES) {
    if (pattern.test(name)) return icon;
  }
  return Wrench01Icon;
}
