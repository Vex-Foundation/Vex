/**
 * EmbeddingStep pure form helpers/types - extracted from
 * `EmbeddingStep.tsx` to keep the screen file under the 400-LOC
 * scalability ceiling (god-file split). VERBATIM move; zero behavior
 * change.
 *
 * URL is validated against `new URL()` before submit (renderer mirrors
 * the schema refine so the user gets immediate feedback). DIM has a
 * numeric range hint enforced against the shared MIN/MAX constants.
 *
 * `narrowDimLockDetails` narrows `VexError.details` through `in`-operator
 * checks (zero `as` casts) so the renderer never trusts an arbitrary
 * unknown shape - codex review round 3/4 YELLOW.
 *
 * Pure module - no React imports, fully unit-testable, no JSX.
 */

import {
  MAX_EMBEDDING_DIM,
  MIN_EMBEDDING_DIM,
} from "@vex-lib/embedding-constants.js";

export interface FormState {
  baseUrl: string;
  model: string;
  dim: string;
  provider: string;
}

export interface DimLockDetails {
  readonly existingRowCount: number;
  readonly targetDim: number;
}

export function narrowDimLockDetails(raw: unknown): DimLockDetails | null {
  // Server-side `embedding-writer.ts` puts these fields into
  // `VexError.details` on `embedding.dim_locked`. Narrow here through
  // `in` operator checks (zero `as` casts) so the renderer never
  // trusts an arbitrary unknown shape - codex review round 3/4 YELLOW.
  if (typeof raw !== "object" || raw === null) return null;
  if (!("existingRowCount" in raw) || !("targetDim" in raw)) return null;
  const existingRowCount = raw.existingRowCount;
  const targetDim = raw.targetDim;
  if (typeof existingRowCount !== "number" || typeof targetDim !== "number") {
    return null;
  }
  return { existingRowCount, targetDim };
}

export function isValidUrlClient(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.hostname.length === 0) return false;
    if (u.username.length > 0 || u.password.length > 0) return false;
    return true;
  } catch {
    return false;
  }
}

export function validateForm(state: FormState): string | null {
  if (state.baseUrl.trim().length === 0) return "Base URL is required.";
  if (!isValidUrlClient(state.baseUrl.trim())) {
    return "Base URL must be a valid http(s):// URL with a hostname and no embedded credentials.";
  }
  if (state.model.trim().length === 0) return "Model is required.";
  const dim = Number(state.dim);
  if (!Number.isInteger(dim) || dim < MIN_EMBEDDING_DIM || dim > MAX_EMBEDDING_DIM) {
    return `Dim must be an integer between ${MIN_EMBEDDING_DIM} and ${MAX_EMBEDDING_DIM}.`;
  }
  if (state.provider.trim().length === 0) return "Provider is required.";
  return null;
}

export interface ServerError {
  readonly code: string;
  readonly message: string;
  readonly details?: DimLockDetails;
}
