/**
 * The `vex:telemetry:reportRendererError` payload schema - ONE definition,
 * imported by both the preload validator and the main handler.
 *
 * Before B0.2 the two sides each spelled the same object literal, which is a
 * drift the type system cannot see: a field added to one is silently rejected
 * by the other, and the renderer's evidence disappears into a caught promise.
 *
 * ## Bounds, and why every one of them reports itself
 *
 * The payload crosses IPC, so it must be bounded. It must NOT be cut in
 * silence (owner decree): after reading a report, the reader has to be able to
 * tell exactly what was left out. So every bound here is paired with the count
 * it was applied to - `messageBytes`/`messageTruncated`,
 * `componentStackBytes`/`componentStackTruncated`, and the stack digest's
 * `frameCount`/`byteCount`/`truncated`. A report that fits carries
 * `truncated: false` and the full text; one that does not says so and says by
 * how much.
 *
 * The renderer is untrusted, so these are also the LIMITS main enforces: a
 * payload that exceeds them is rejected by the preload schema rather than
 * shortened, which is why the renderer applies the same bounds before sending.
 */

import { z } from "zod";

/** Frames a single report may carry. Deeper frames are dropped and counted. */
export const TELEMETRY_STACK_FRAME_LIMIT = 24;
/** Characters of the error message a single report may carry. */
export const TELEMETRY_MESSAGE_LIMIT = 2000;
/** Characters of the React component stack a single report may carry. */
export const TELEMETRY_COMPONENT_STACK_LIMIT = 10_000;

export const telemetryStackFrameSchema = z
  .object({
    fn: z.string().max(300).nullable(),
    file: z.string().max(400).nullable(),
    line: z.number().int().nonnegative().nullable(),
    column: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const telemetryStackDigestSchema = z
  .object({
    frames: z.array(telemetryStackFrameSchema).max(TELEMETRY_STACK_FRAME_LIMIT),
    frameCount: z.number().int().nonnegative(),
    byteCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const telemetryReportInputSchema = z
  .object({
    kind: z.enum(["caught", "uncaught", "boundary"]),
    message: z.string().max(TELEMETRY_MESSAGE_LIMIT),
    componentStack: z
      .string()
      .max(TELEMETRY_COMPONENT_STACK_LIMIT)
      .nullable()
      .optional(),
    correlationId: z.string().max(64).optional(),
    errorName: z.string().max(200).optional(),
    messageBytes: z.number().int().nonnegative().optional(),
    messageTruncated: z.boolean().optional(),
    componentStackBytes: z.number().int().nonnegative().optional(),
    componentStackTruncated: z.boolean().optional(),
    stack: telemetryStackDigestSchema.nullable().optional(),
  })
  .strict();

export const telemetryReportOutputSchema = z
  .object({ recorded: z.boolean() })
  .strict();
