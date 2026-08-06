/**
 * Text policy for the metadata `create()` writes ON-CHAIN, PERMANENTLY.
 *
 * `name`, `symbol`, `description` and `links` are arguments to the launchpad's
 * `create()`. Once it runs they are immutable, so a control character or a
 * double quote in any of them breaks the token's metadata for every consumer of
 * that token, forever. The launchpad operator reported exactly this, with the
 * newline as the common case.
 *
 * THE CONTRACT IS REJECT, NEVER TRANSFORM. Vex does not repair the text:
 *
 *   - `trench.launch_execute` can sign under full autonomy with NO preview, so a
 *     silent rewrite would put text on-chain that the user never reviewed;
 *   - the preview result carries no canonical text field, so a normalized value
 *     would not even be visible to the user before it was signed;
 *   - coercing invalid input into valid-looking state is what rule 03 forbids at
 *     a boundary, and this boundary spends real funds irreversibly.
 *
 * The refusal therefore names the offending FIELD and the remedy the user can
 * act on, rather than reporting a generic validation failure.
 *
 * SCOPE: the forbidden set is exactly C0 controls, DEL, and `"`. Everything else
 * a user can type is preserved on purpose. Emoji, accented letters, apostrophes
 * and dashes are legitimate token metadata, and over-restricting them would be a
 * defect of its own.
 *
 * WHY THIS LIVES IN `src/lib`. Three surfaces must apply ONE definition of the
 * policy: the agent runtime (`trench` launch handlers), the privileged IPC
 * contract (`vex-app/src/shared/schemas/token-launch.ts`) and the renderer form.
 * The renderer and `shared` may not import `src/vex-agent`, and the sanctioned
 * cross-boundary path is `@vex-lib` -> `../src/lib` for modules that are PURE.
 * This module is therefore deliberately dependency-free: it imports nothing, it
 * reads no environment, it touches no key, DB or network. Keep it that way, or
 * it stops being importable by the renderer
 * (`vex-app/scripts/check-process-boundaries.mjs`).
 */

/** C0 controls, DEL, and the double quote. Nothing wider. */
const FORBIDDEN_METADATA_PATTERN = /[\u0000-\u001F\u007F"]/;

/** What the user needs to do, in the same words on every field. */
const REMEDY =
  "Replace line breaks with spaces and double quotes with apostrophes, then send it again.";

/** Name the character, so the user can find it rather than hunt for it. */
function describeForbidden(character: string): string {
  switch (character) {
    case '"':
      return "a double quote";
    case "\n":
      return "a line break";
    case "\r":
      return "a carriage return";
    case "\t":
      return "a tab";
    default: {
      const codePoint = character.codePointAt(0) ?? 0;
      return `a control character (U+${codePoint.toString(16).toUpperCase().padStart(4, "0")})`;
    }
  }
}

function refuseText(field: string, text: string): string | null {
  const found = FORBIDDEN_METADATA_PATTERN.exec(text);
  if (!found) return null;
  return (
    `Refusing the launch: ${field} contains ${describeForbidden(found[0])}. `
    + "create() writes the name, symbol, description and links on-chain and they can NEVER be edited "
    + "afterwards, so Vex refuses this text instead of rewriting it into something you did not review. "
    + REMEDY
  );
}

/**
 * Reject forbidden characters in one named metadata field, on the RAW value.
 *
 * Call this BEFORE trimming and before any other per-field check. Trim-then-
 * validate can make the checked string differ from the submitted one, and a
 * control character inside a URL can be silently dropped by a parser later, so
 * the scheme check must not get to answer first.
 *
 * A list value (the `links` param, which accepts an array) is inspected element
 * by element and the refusal names the offending index.
 *
 * Returns the refusal, or `null` when the value carries nothing forbidden. A
 * non-string, non-list value is not this policy's concern; the field's own
 * validation still rejects it.
 */
export function rejectForbiddenTokenMetadataText(field: string, raw: unknown): string | null {
  if (typeof raw === "string") return refuseText(field, raw);
  if (!Array.isArray(raw)) return null;

  for (const [index, element] of raw.entries()) {
    if (typeof element !== "string") continue;
    const refusal = refuseText(`${field}[${index}]`, element);
    if (refusal) return refusal;
  }
  return null;
}

/**
 * Does this raw text carry anything the on-chain metadata policy forbids?
 *
 * For UI that only needs to disarm a control or flag a field. The refusal WORDS
 * come from `rejectForbiddenTokenMetadataText`; this is the same predicate
 * without them, so the renderer cannot drift into a second definition of the
 * forbidden set.
 */
export function hasForbiddenTokenMetadataText(text: string): boolean {
  return FORBIDDEN_METADATA_PATTERN.test(text);
}
