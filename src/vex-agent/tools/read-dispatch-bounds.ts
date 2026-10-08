/**
 * Effective read-dispatch bounds (Kairos Phase 5, T-1 + T-3), read from the
 * environment at the point of use.
 *
 * An invalid value never widens anything: it is logged (key and reason only,
 * never the raw value) and the field's default applies. `loadEnvConfig` in
 * `inference/config.ts` validates the same fields and fails startup on them,
 * so in a running engine this fallback is only a guard.
 */

import {
  parseAgentToolReadEnv,
  type AgentToolReadBounds,
} from "../../lib/agent-config.js";
import logger from "@utils/logger.js";

export type { AgentToolReadBounds };

export function readToolReadBounds(
  env: NodeJS.ProcessEnv = process.env,
): AgentToolReadBounds {
  const parsed = parseAgentToolReadEnv(env);
  for (const error of parsed.errors) {
    logger.warn("tools.read_bounds.invalid_using_default", {
      key: error.key,
      reason: error.reason,
    });
  }
  return parsed.value;
}
