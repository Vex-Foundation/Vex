/**
 * Canonical whitespace helper for `discovery.embeddingText` passages.
 *
 * Collapses runs of whitespace into a single space and trims the result.
 * Used by per-protocol manifests when authoring multi-line passage strings
 * with template literals - the helper keeps the source readable while the
 * stored value stays compact.
 *
 * Replaces the previously duplicated `kyberEmbeddingText` /
 * `khalaniEmbeddingText` helpers (identical implementations).
 */
export function embeddingText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
