/**
 * Provider-safe error normalization/redaction (B-003) — the neutral,
 * layer-free home of the scrub → classify → remediate → render pipeline.
 *
 * WHY IT LIVES HERE. `src/tools/**` must never import `src/vex-agent/**`
 * (stated at `tools/kyberswap/constants.ts`), yet `evm-chains/staged-broadcast.ts`
 * needs the SAME sanitizer the protocol runtime uses — a venue-local copy is
 * exactly the duplication `summarizeProtocolError` was made the single owner of.
 * Both rules survive by owning the pipeline on neutral ground: this module
 * depends only on `src/errors.ts` and `src/lib/diagnostics/text-redaction.ts`,
 * so `src/tools`, `src/vex-agent` and `src/lib` may all reach it.
 * `vex-agent/tools/protocols/runtime/errors.ts` remains the runtime's façade
 * and re-exports everything below, so no protocol call site changed.
 *
 * ENTRY POINT. This file keeps the public exports; the implementation lives in
 * the sibling `error-summary/` folder, split by responsibility:
 *   - `error-summary/scrub.ts`       — the sanitizer pipeline and the length cap,
 *   - `error-summary/classify.ts`    — `ErrorCategory` and `classifyError`,
 *   - `error-summary/remediation.ts` — the first-party remediation table,
 *   - `error-summary/render.ts`      — the agent-/log-facing renderings.
 *
 * A thrown handler/provider/SDK error can embed URLs, request/response bodies,
 * auth headers, and key material — none of which may reach the tool output, the
 * structured logs, or the renderer. This module is the single owner of that
 * redaction.
 *
 * `summarizeProtocolError(err).message` is the ONE sufficient entry point
 * (FIX4-SPINE C37 — Codex final-review round 3 finding 1): every venue's
 * output/log/persisted-reason text must route through it rather than through
 * a venue-local preprocessor, so a scrub-core fix (like this round's
 * Bearer-ordering / HTML-document / balanced-body hardening) protects every
 * caller at once instead of needing to be re-applied per venue.
 */

export { classifyError, type ErrorCategory } from "./error-summary/classify.js";
export { scrubProviderText } from "./error-summary/scrub.js";
export {
  remediationFor,
  slippageRemediation,
  type SlippageRemediationInput,
} from "./error-summary/remediation.js";
export {
  describeFailureForAgent,
  describeFailureForLog,
  renderProtocolFailureOutput,
  summarizeProtocolError,
  type SafeErrorSummary,
} from "./error-summary/render.js";
