/**
 * Extracts the provider prefix from an OpenRouter-style model id
 * (`<provider>/<model>`).
 *
 * Returns the lowercased prefix when the id is well-formed; `null`
 * when there is no `/`, the prefix is empty after trim, or the input
 * is empty. The result feeds `ModelBrandIcon` which looks up a brand
 * SVG from a small hardcoded mapping (no dynamic require - bundle
 * predictable, CSP-clean).
 *
 * Pure function - kept separate from the React component so it can be
 * unit-tested without rendering.
 */
export function parseModelProvider(modelId: string): string | null {
  if (typeof modelId !== "string") return null;
  const slash = modelId.indexOf("/");
  if (slash <= 0) return null;
  const raw = modelId.slice(0, slash).trim();
  if (raw.length === 0) return null;
  return raw.toLowerCase();
}
