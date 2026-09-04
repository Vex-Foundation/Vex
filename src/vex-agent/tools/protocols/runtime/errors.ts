/**
 * Provider-safe error normalization/redaction (B-003) for the protocol runtime.
 *
 * FAÇADE. This file keeps its name and its public exports; the implementation
 * moved to `src/utils/error-summary.ts` (+ its sibling folder) so that
 * `src/tools/**` - which must never import `src/vex-agent/**` - can reach the
 * SAME sanitizer instead of growing a venue-local copy. See that module's
 * header for the pipeline's structure and the layering rationale.
 *
 * Every protocol call site keeps importing from here.
 */

export {
  classifyError,
  describeFailureForAgent,
  describeFailureForLog,
  renderProtocolFailureOutput,
  summarizeProtocolError,
  type ErrorCategory,
  type SafeErrorSummary,
} from "../../../../utils/error-summary.js";
