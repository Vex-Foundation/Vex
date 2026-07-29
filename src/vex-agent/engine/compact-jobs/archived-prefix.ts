/**
 * Archived-prefix loading + rendering for the archive chunking
 * worker. Extracted from `executor.ts` for scaling — these
 * helpers don't depend on the worker lifecycle or the chunker
 * loop's `claimLost` flag, so they extract cleanly.
 *
 * - `loadArchivedPrefix` — DB read of `messages_archive` rows.
 * - `renderRedactedArchivedTranscript` — render rows + re-scrub
 *   pre-memory-layer wallet/tx/secret material BEFORE the remote
 *   chunker sees the prompt.
 * - `redactStringArray` — apply `redact` to a structured array
 *   (entities / protocols / chains / tasks / etc.) and aggregate
 *   the hard/mask counters.
 */

import { query } from "../../db/client.js";
import { redact, type RedactionResult } from "../../memory/redaction.js";

export interface ArchivedPrefixRow {
  readonly role: string;
  readonly content: string;
  readonly tool_call_id: string | null;
}

export async function loadArchivedPrefix(
  sessionId: string,
  startId: number | null,
  endId: number,
): Promise<ArchivedPrefixRow[]> {
  const startClause = startId === null ? "" : "AND id >= $3 ";
  const params: unknown[] =
    startId === null ? [sessionId, endId] : [sessionId, endId, startId];
  const rows = await query<ArchivedPrefixRow>(
    `SELECT role, content, tool_call_id
     FROM messages_archive
     WHERE session_id = $1 AND id <= $2 ${startClause}
     ORDER BY id ASC`,
    params,
  );
  return rows;
}

/**
 * Transcript-side scrubber: archived live messages may contain wallet
 * identifiers, tx hashes, API tokens, or key material that pre-date
 * the memory layer's output-side redaction. Re-scrub before the remote
 * chunker provider sees the prompt; output-side redaction in
 * `executor.ts` remains the DB and embedding guard.
 */
export function renderRedactedArchivedTranscript(
  archivedPrefix: ReadonlyArray<ArchivedPrefixRow>,
): { transcript: string; redactionCounts: { hard: number; mask: number } } {
  let hard = 0;
  let mask = 0;
  const transcript = archivedPrefix
    .map((m) => {
      const redacted = redact(m.content);
      hard += redacted.hardRedactCount;
      mask += redacted.maskCount;
      return `[${m.role}${m.tool_call_id ? ` tool=${m.tool_call_id}` : ""}] ${redacted.text}`;
    })
    .join("\n");

  return { transcript, redactionCounts: { hard, mask } };
}

/**
 * Apply `redact` to every element of a string array and aggregate the
 * hard-redact + mask counts. Used for the structured columns the
 * chunker emits (entities / protocols / error_classes / chains /
 * tasks). Anything that tripped a hard-redact pattern (BIP39, private
 * keys, JWT, API keys) is replaced with a placeholder; mask patterns
 * (addresses, tx hashes) are masked. Both flavours are reflected in
 * the returned counts.
 */
export function redactStringArray(values: readonly string[]): {
  values: string[];
  hardCount: number;
  maskCount: number;
} {
  const out: string[] = [];
  let hardCount = 0;
  let maskCount = 0;
  for (const v of values) {
    const r: RedactionResult = redact(v);
    out.push(r.text);
    hardCount += r.hardRedactCount;
    maskCount += r.maskCount;
  }
  return { values: out, hardCount, maskCount };
}
