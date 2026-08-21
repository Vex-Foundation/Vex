#!/usr/bin/env tsx
/**
 * extract-tool-discovery-traffic — provenance step for the retrieval gold set.
 *
 * Reads the local agent DB (SELECT only) and emits every historic
 * `ToolSearch` call together with the protocol calls the session went
 * on to make, as a labelling worksheet. This is the RAW MATERIAL behind
 * `measure-tool-retrieval-baseline-dataset/production-gold-set.json`; the gold
 * set itself is hand-labelled, never generated from this output.
 *
 * Why hand-labelling is not optional: the follow-up executes are a SANITY
 * SIGNAL, not a label. Three ways the naive pairing lies, all present in this
 * repo's own traffic —
 *
 *   1. **Parallel discover batches.** One assistant message frequently carries
 *      several discovery calls. Every following execute then appears to
 *      belong to the LAST query in the batch. `siblingsInMessage > 1` marks
 *      these; their follow-up window belongs to the batch as a whole.
 *   2. **Mission-length windows.** A window can span 30+ executes covering a
 *      whole trading session, not the one tool the query was looking for.
 *   3. **Retired capabilities.** Hyperliquid, Polymarket and the KyberSwap
 *      buy/sell split were removed; their executes name tool ids that no longer
 *      exist. `unknownToolIds` flags them.
 *
 * Read-only by construction: one SELECT, no writes, no wallet, no provider, no
 * network beyond Postgres. Queries are the agent's own generated search
 * strings; the worksheet keeps a truncated session id for de-duplication only
 * and the checked-in gold set drops it entirely.
 *
 * Usage:
 *   pnpm extract:tool-discovery-traffic            # human-readable worksheet
 *   pnpm extract:tool-discovery-traffic --json     # machine-readable
 */

import { closePool, query } from "@vex-agent/db/client.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";
import logger from "@utils/logger.js";

interface ToolCallRow {
  session_id: string;
  created_at: Date;
  message_id: number;
  command: string;
  tool_id: string | null;
  discovery_query: string | null;
  discovery_namespace: string | null;
  discovery_limit: number | null;
}

interface DiscoveryCandidate {
  /** Truncated session id — correlation only, never a user identifier. */
  readonly sessionPrefix: string;
  readonly query: string | null;
  readonly namespace: string | null;
  readonly limit: number | null;
  /** How many discovery calls shared this assistant message. */
  readonly siblingsInMessage: number;
  /** Distinct tool ids executed before the next discovery call. */
  readonly followedByToolIds: readonly string[];
  /** Subset of the above that no longer exists in the catalog. */
  readonly unknownToolIds: readonly string[];
}

/**
 * The command spellings a DISCOVERY call can carry in `messages.tool_calls`.
 *
 * `messages` is durable history: a row written before the ToolSearch merge holds
 * the retired spelling forever and is never rewritten, so a worksheet that read
 * only the live name would silently report zero traffic for every session that
 * predates the rename. The retired names are read-only history here, not a
 * live surface - nothing in this script emits them.
 */
const DISCOVERY_COMMANDS: readonly string[] = ["ToolSearch", "discover_tools"];

/** Same reasoning: the approval envelope's command, stable across the merge. */
const EXECUTE_COMMAND = "execute_tool";

function isDiscoveryCommand(command: string): boolean {
  return DISCOVERY_COMMANDS.includes(command);
}

const SELECT_TOOL_CALLS = `
  SELECT m.session_id,
         m.created_at,
         m.id                                        AS message_id,
         c->>'command'                               AS command,
         c->'args'->>'toolId'                        AS tool_id,
         c->'args'->>'query'                         AS discovery_query,
         c->'args'->>'namespace'                     AS discovery_namespace,
         (c->'args'->>'limit')::int                  AS discovery_limit
  FROM messages m,
       LATERAL jsonb_array_elements(m.tool_calls) c
  WHERE m.role = 'assistant'
    AND m.tool_calls IS NOT NULL
    AND c->>'command' = ANY($1)
  ORDER BY m.session_id, m.created_at, m.id
`;

export async function extractDiscoveryCandidates(): Promise<DiscoveryCandidate[]> {
  const rows = await query<ToolCallRow>(SELECT_TOOL_CALLS, [
    [...DISCOVERY_COMMANDS, EXECUTE_COMMAND],
  ]);

  const bySession = new Map<string, ToolCallRow[]>();
  for (const row of rows) {
    const bucket = bySession.get(row.session_id);
    if (bucket) bucket.push(row);
    else bySession.set(row.session_id, [row]);
  }

  const candidates: DiscoveryCandidate[] = [];
  for (const [sessionId, events] of bySession) {
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event === undefined || !isDiscoveryCommand(event.command)) continue;

      const siblingsInMessage = events.filter(
        (other) => isDiscoveryCommand(other.command) && other.message_id === event.message_id,
      ).length;

      const followed = new Set<string>();
      for (let j = i + 1; j < events.length; j++) {
        const next = events[j];
        if (next === undefined || isDiscoveryCommand(next.command)) break;
        if (next.tool_id !== null) followed.add(next.tool_id);
      }
      const followedByToolIds = [...followed];

      candidates.push({
        sessionPrefix: sessionId.slice(0, 8),
        query: event.discovery_query,
        namespace: event.discovery_namespace,
        limit: event.discovery_limit,
        siblingsInMessage,
        followedByToolIds,
        unknownToolIds: followedByToolIds.filter((id) => getProtocolManifest(id) === undefined),
      });
    }
  }
  return candidates;
}

function renderWorksheet(candidates: readonly DiscoveryCandidate[]): string {
  const lines: string[] = [];
  const sessions = new Set(candidates.map((c) => c.sessionPrefix));
  lines.push(
    `# ToolSearch traffic worksheet — ${candidates.length} calls across ${sessions.size} sessions`,
    "",
    "Columns: index | siblings-in-message | namespace | limit | query => distinct follow-up executes (! = tool no longer in catalog)",
    "",
  );
  candidates.forEach((candidate, index) => {
    const followed = candidate.followedByToolIds
      .map((id) => (candidate.unknownToolIds.includes(id) ? `!${id}` : id))
      .join(", ");
    lines.push(
      [
        String(index + 1).padStart(4),
        `sib${candidate.siblingsInMessage}`,
        `ns=${candidate.namespace ?? "-"}`,
        `lim=${candidate.limit ?? "-"}`,
        JSON.stringify(candidate.query),
        `=> [${followed}]`,
      ].join(" | "),
    );
  });
  return lines.join("\n");
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const candidates = await extractDiscoveryCandidates();
  process.stdout.write(
    (asJson ? JSON.stringify(candidates, null, 2) : renderWorksheet(candidates)) + "\n",
  );
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    logger.error("tool_discovery.traffic_extract.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.stderr.write(
      `extract:tool-discovery-traffic failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await closePool().catch(() => undefined);
    process.exit(1);
  });
