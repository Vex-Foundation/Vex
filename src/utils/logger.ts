import winston from "winston";
import type { Writable } from "node:stream";
import { redactLogValue } from "../lib/diagnostics/log-redaction.js";

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

function shouldUseStructuredFormat(): boolean {
  const explicit = process.env.LOG_FORMAT;
  if (explicit === "json") return true;
  if (explicit === "pretty") return false;
  return !process.stderr.isTTY;
}

const colorizedFormat = winston.format.combine(
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.colorize(),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
    return `${timestamp} ${level}: ${message}${metaStr}`;
  })
);

const structuredFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json(),
);

/**
 * Sanitize the shared Winston info object before any transport sees it.
 * Symbol properties used internally by Winston remain in place; all
 * user-controlled string-keyed message and metadata fields are replaced by
 * their safe equivalents.
 */
const redactingFormat = winston.format((info) => {
  const safe = redactLogValue(info) as Record<string, unknown>;
  for (const key of Object.keys(info)) delete info[key];
  Object.assign(info, safe);
  return info;
});

// All logs go to stderr (stdout reserved for machine-readable output)
export const logger = winston.createLogger({
  level: LOG_LEVEL,
  defaultMeta: {
    service: "vex-agent",
  },
  format: winston.format.combine(
    redactingFormat(),
    shouldUseStructuredFormat() ? structuredFormat : colorizedFormat,
  ),
  transports: [
    new winston.transports.Stream({
      stream: process.stderr as unknown as Writable,
    }),
  ],
});

/** Create a child logger with additional context (requestId, sessionId, etc.). */
export function createChildLogger(meta: Record<string, string | number | undefined>): winston.Logger {
  // Filter out undefined values
  const clean: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v !== undefined) clean[k] = v;
  }
  return logger.child(clean);
}

export default logger;
