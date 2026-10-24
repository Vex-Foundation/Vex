/**
 * Limits on the user's own MCP servers (F12). One table so the store, the
 * client, the lane and the recheck worker cannot disagree.
 */

/** Servers the user can add. */
export const MAX_SERVERS = 5;
/**
 * Tools turned on across every server. Desktop has no intent router, so every
 * enabled tool is offered on every round of an agent turn; the cap keeps that
 * block small.
 */
export const MAX_ENABLED_TOOLS = 8;
/** Tools read from one server's listing; the rest are ignored. */
export const MAX_TOOLS_PER_SERVER = 100;
/** Text of one result the model sees, in characters. */
export const MAX_RESULT_CHARS = 16_000;
/** Bytes read from a server for one request. */
export const MAX_RESPONSE_BYTES = 256 * 1024;
/** One operation (handshake plus the list or the call) end to end. */
export const OPERATION_TIMEOUT_MS = 15_000;
/** Tool calls across every server, per minute. */
export const CALLS_PER_MINUTE = 30;
/** Adds and rechecks the user starts from Settings, per minute. */
export const ADMIN_OPS_PER_MINUTE = 6;

/** A server's tool list is read again after this long. */
export const RECHECK_AFTER_MS = 6 * 60 * 60 * 1000;
/** How often the recheck worker looks for due servers. */
export const RECHECK_TICK_MS = 15 * 60 * 1000;
/** Due servers taken in one tick. */
export const RECHECK_BATCH = 50;
/** Failed listings in a row that move a server to `error`. */
export const FAILURES_BEFORE_ERROR = 3;

/** A tool description as stored. */
export const MAX_STORED_DESCRIPTION_CHARS = 1_000;
/** A tool description as the model sees it, after the third-party label. */
export const MAX_MODEL_DESCRIPTION_CHARS = 400;
/** The arguments shown on an approval card. */
export const MAX_PREVIEW_ARGUMENT_CHARS = 600;
/** A pinned schema as Settings shows it. */
export const MAX_DISPLAY_SCHEMA_CHARS = 4_000;
