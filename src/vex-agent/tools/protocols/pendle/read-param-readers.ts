/**
 * The primitive value readers every Pendle READ param contract refuses by name
 * with.
 *
 * Split out of `market-read-params.ts` because the two change for different
 * reasons: the tool contracts move when Pendle's query surface moves, these
 * readers move when the refusal vocabulary itself does. Each returns the shared
 * `PendleReadParams` result rather than throwing, so a parser can stop at the
 * first bad value and hand the agent the PARAM NAME plus what would have been
 * accepted.
 *
 * Two of them guard an unsafe sink. A chain and an address here become URL PATH
 * segments, and they arrive from tool params - ultimately from model output. The
 * check is "is this a chain we support" and "is this an address", not "is this
 * safe to encode": percent-encoding a non-address still leaves it addressing
 * something.
 *
 * `read-params.ts` (the portfolio-shaped read tools) carries its own private
 * copies of several of these. Collapsing the two sets onto this module is a
 * deliberate follow-up, not an oversight - it would mean editing a file another
 * card owns.
 */

import { PENDLE_SUPPORTED_CHAIN_IDS, pendleChainSlug, resolvePendleChainId } from "@tools/pendle/chains.js";
import type { PendleReadTimeFrame } from "@tools/pendle/read/types.js";
import type { PendleReadParams } from "./read-params.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const TIME_FRAMES: readonly PendleReadTimeFrame[] = ["hour", "day", "week"];

const TIME_FRAME_MS: Record<PendleReadTimeFrame, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

export function reject<T>(param: string, message: string): PendleReadParams<T> {
  return { ok: false, rejection: { param, message } };
}

/** Trimmed non-empty string, or absent. Whitespace is absence, not a value. */
export function readOptionalString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

/** A required chain, resolved through the pinned Pendle registry. */
export function requireChain(raw: unknown, param = "chain"): PendleReadParams<number> {
  const value = readOptionalString(raw);
  if (value === undefined) {
    return reject(param, `\`${param}\` is required - name the Pendle chain (for example 'ethereum' or 42161).`);
  }
  const chainId = resolvePendleChainId(value.toLowerCase());
  if (chainId === undefined) {
    const supported = PENDLE_SUPPORTED_CHAIN_IDS.map((id) => pendleChainSlug(id)).join(", ");
    return reject(param, `\`${param}\` is "${value}", which Pendle does not support. Supported: ${supported}.`);
  }
  return { ok: true, value: chainId };
}

/** A required address that will become a URL path segment; lowercased once accepted. */
export function requireAddressParam(raw: unknown, param: string): PendleReadParams<string> {
  const value = readOptionalString(raw);
  if (value === undefined) {
    return reject(param, `\`${param}\` is required - pass a 0x-prefixed 40-hex contract address.`);
  }
  if (!ADDRESS_PATTERN.test(value)) {
    return reject(
      param,
      `\`${param}\` is not a contract address. Pass a 0x-prefixed 40-hex address, received "${value}".`,
    );
  }
  return { ok: true, value: value.toLowerCase() };
}

/** Is this a well-formed EVM address? Used where a list member must be checked. */
export function isAddress(value: string): boolean {
  return ADDRESS_PATTERN.test(value);
}

/** Series resolution, defaulting to daily. */
export function readTimeFrame(raw: unknown, param = "timeFrame"): PendleReadParams<PendleReadTimeFrame> {
  const value = readOptionalString(raw);
  if (value === undefined) return { ok: true, value: "day" };
  const match = TIME_FRAMES.find((f) => f === value.toLowerCase());
  if (match === undefined) {
    return reject(param, `\`${param}\` must be one of: ${TIME_FRAMES.join(", ")}. Received "${value}".`);
  }
  return { ok: true, value: match };
}

/** An optional ISO-8601 instant as epoch milliseconds. */
export function readOptionalInstantMs(raw: unknown, param: string): PendleReadParams<number | undefined> {
  const value = readOptionalString(raw);
  if (value === undefined) return { ok: true, value: undefined };
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return reject(
      param,
      `\`${param}\` must be an ISO-8601 instant (for example 2026-07-20T00:00:00Z). Received "${value}".`,
    );
  }
  return { ok: true, value: ms };
}

/** An optional whole number inside a declared range. */
export function readOptionalInteger(
  raw: unknown,
  param: string,
  bounds: { min: number; max?: number },
): PendleReadParams<number | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return reject(param, `\`${param}\` must be a finite number.`);
  }
  if (!Number.isInteger(raw)) return reject(param, `\`${param}\` must be a whole number. Received ${raw}.`);
  if (raw < bounds.min) return reject(param, `\`${param}\` must be at least ${bounds.min}. Received ${raw}.`);
  if (bounds.max !== undefined && raw > bounds.max) {
    return reject(param, `\`${param}\` must be at most ${bounds.max}. Received ${raw}.`);
  }
  return { ok: true, value: raw };
}

/**
 * The window guard shared by the two series tools.
 *
 * The point count is COMPUTED, and the refusal quotes it - "that window is 8,761
 * hourly points, the cap is 1,440" tells an agent exactly how to narrow, where a
 * bare "too large" does not. An open-ended window (no `from`) cannot be bounded
 * here; the caller bounds the RESULT instead and reports truncation explicitly.
 */
export function checkSeriesWindow(
  fromMs: number | undefined,
  toMs: number | undefined,
  timeFrame: PendleReadTimeFrame,
  nowMs: number,
  maxPoints: number,
): PendleReadParams<true> {
  if (fromMs !== undefined && toMs !== undefined && toMs <= fromMs) {
    return reject("to", "`to` must be later than `from`.");
  }
  if (fromMs === undefined) return { ok: true, value: true };
  const end = toMs ?? nowMs;
  if (end <= fromMs) return reject("from", "`from` is in the future - it must be earlier than `to` (or than now).");

  const points = Math.ceil((end - fromMs) / TIME_FRAME_MS[timeFrame]) + 1;
  if (points > maxPoints) {
    return reject(
      "from",
      `that window is ${points} ${timeFrame} points; the cap is ${maxPoints}. ` +
        "Narrow `from`/`to`, or use a coarser `timeFrame`.",
    );
  }
  return { ok: true, value: true };
}
