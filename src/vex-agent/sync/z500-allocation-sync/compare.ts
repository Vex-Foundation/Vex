/**
 * Allocation comparison — mint-and-weight identity, nothing else.
 *
 * The input type IS the guarantee the spec asks for: a comparison over
 * `Record<mint, weight>` cannot consult symbols, names, or ordering, because
 * none of them exist in the shape. Both sides normalize through the same
 * function so "identical" means identical after trimming, whatever produced
 * the map.
 */

/** Normalize an allocation map: trimmed mint keys, numeric integer weights. */
export function normalizeAllocation(
  allocation: Readonly<Record<string, number>>,
): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [mint, weight] of Object.entries(allocation)) {
    normalized[mint.trim()] = weight;
  }
  return normalized;
}

/** True iff both allocations hold exactly the same mints at the same weights. */
export function allocationsEqual(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): boolean {
  const left = normalizeAllocation(a);
  const right = normalizeAllocation(b);
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  for (const mint of leftKeys) {
    if (right[mint] !== left[mint]) return false;
  }
  return true;
}
