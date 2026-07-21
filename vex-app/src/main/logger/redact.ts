/**
 * Compatibility facade for the shared transport-boundary log redactor.
 * Electron logs, engine stderr, and telemetry must use the same policy.
 */
export {
  redactLogValue as redact,
  redactLogArgs as redactArgs,
} from "@vex-lib/diagnostics/log-redaction.js";
