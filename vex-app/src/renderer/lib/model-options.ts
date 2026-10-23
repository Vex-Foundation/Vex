/**
 * Pure reads over a resolved `models.listAvailable` result (F06). Kept out of
 * `lib/api/models.ts` (the query hook) so a component test that mocks the
 * hook still reads its fixture through the real rules.
 */

import type { Result } from "@shared/ipc/result.js";
import type { ModelOptionDto, ModelsListAvailableResult } from "@shared/schemas/models.js";

/** The configured default (`AGENT_MODEL`) in a resolved list, else `null`. */
export function defaultModelOption(
  result: Result<ModelsListAvailableResult> | undefined,
): ModelOptionDto | null {
  if (result?.ok !== true) return null;
  return result.data.models.find((option) => option.isDefault) ?? null;
}

/** One model's row in a resolved list, else `null`. */
export function findModelOption(
  result: Result<ModelsListAvailableResult> | undefined,
  modelId: string | null,
): ModelOptionDto | null {
  if (result?.ok !== true || modelId === null) return null;
  return result.data.models.find((option) => option.modelId === modelId) ?? null;
}
