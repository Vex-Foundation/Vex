/**
 * DISPLAY-ONLY trim of the routing prefix: `deepseek/deepseek-v4-pro` reads
 * as `deepseek-v4-pro` (owner QA round 3 follow-up). Only the FIRST segment
 * is cut - an id with no `/` passes through, and a variant suffix (`:free`)
 * survives. The FULL id stays the source of truth everywhere else: the
 * accessible name, the tooltip, the settings screen, and every request path.
 */
export function modelDisplayName(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 && slash < modelId.length - 1
    ? modelId.slice(slash + 1)
    : modelId;
}
