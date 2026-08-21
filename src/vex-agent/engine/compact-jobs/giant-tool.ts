/**
 * Giant-tool placeholder — stub left in `messages` table when a single
 * oversized tool result is forked into `messages_archive` via the
 * giant-tool compact mode. References the `compact_job` that owns the archive
 * chunking (NOT a session episode — episode extraction was removed when
 * PR2 cut over to the per-session memory layer).
 *
 * The placeholder mentions `SessionMemorySearch` as the recovery path because
 * The archive chunking worker will emit a narrative chunk that summarises the
 * archived tool output; the agent can fetch it semantically once that lands.
 */

export function buildGiantToolPlaceholder(
  bloatedMessageId: number,
  compactJobId: number,
): string {
  return (
    `[oversized tool output — full payload archived at message_id=${bloatedMessageId}, ` +
    `compact_job_id=${compactJobId}. The narrative chunk for this material is ` +
    `produced asynchronously by the archive chunking worker; query via SessionMemorySearch once it lands.]`
  );
}
