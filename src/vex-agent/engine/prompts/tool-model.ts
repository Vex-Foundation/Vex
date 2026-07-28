/**
 * Tool Model — constant static layer (P3 decomposition, split out of the old
 * `tool-usage.ts` §1–§3). Holds the routing model: internal vs protocol tools,
 * the `discover_tools` / `execute_tool` mechanics, and live-state routing
 * (query, never memorize).
 *
 * Execution safety (quote/preview, 2-step transfers, pressure-barrier gate,
 * gas/balance/token rules) lives in the sibling `# Safety Contract` layer.
 * Memory routing lives in `# Memory & Learning`; research in `# Research`.
 * The `# Available Tool Map` (built in `tool-catalog.ts`) lists what is
 * callable RIGHT NOW for the active mode + pressure band.
 *
 * Tool-specific operational contracts (semantic-intent examples, save /
 * do-not-save lists, per-arg ✓/✗ examples) live on the ToolDef.description
 * payloads in `tools/registry/*.ts` so the model sees them at the tool
 * selection point, not just in the system prompt.
 */

import { buildMissingCapabilityNotice } from "./capability-availability.js";

export function buildToolModelPrompt(): string {
  // Live env read on every build (vault unlock/lock mutates process.env), so the
  // notice describes the posture of THIS prompt build. "" when nothing is missing.
  const missingCapabilityNotice = buildMissingCapabilityNotice();
  const notice = missingCapabilityNotice.length > 0 ? `\n\n${missingCapabilityNotice}` : "";

  return `# Tool Model

## 1. Tool Selection

Two ways to call tools:

1. **Direct internal tools** — called by name. Listed in the Tool Map provided in the turn state with their category. Examples: \`wallet_balances\`, \`session_memory_search\`, \`compact_now\`. Used for agent-level operations and curated read-only shortcuts.

2. **Protocol tools** — discovered through \`discover_tools\`, executed through \`execute_tool\` with a dotted \`toolId\` like \`khalani.bridge\` or \`kyberswap.swap.execute\`. The full multi-chain protocol surface lives here.

Use the Tool Map: if a tool is not in it RIGHT NOW, it is not callable. The pressure-band filter, role gates, and env gates already narrowed the list to what the dispatcher will accept. Do not emit calls to tools that are not in the Map — the dispatcher rejects them with an actionable error explaining which gate blocked.

Every call example in this prompt is written as \`tool_name(param="value")\`. That notation shows INTENT, not wire format — always emit a real tool call through the tools API, never the example text as a message.

### Shortcuts are the same engines

The curated shortcuts below run the SAME protocol code as the dotted toolIds they route to. PREFER the shortcut: it is one call instead of \`discover_tools\` + \`execute_tool\`, and its schema is already in front of you.

| Shortcut | Runs |
| --- | --- |
| \`token_find\` | \`khalani.tokens.search\` (canonical token resolver) |
| \`token_check\` | \`kyberswap.tokens.check\` (EVM honeypot / fee-on-transfer) |
| \`khalani_chains_list\` | \`khalani.chains.list\` |
| \`khalani_tokens_top\` | \`khalani.tokens.top\` |
| \`khalani_tokens_balances\` | \`khalani.tokens.balances\` |
| \`swap_quote\` / \`swap_execute\` | the chain's swap venue (EVM → \`kyberswap.swap.*\`, \`chain="solana"\` → \`solana.swap.*\`) |
| \`bridge_quote\` / \`bridge\` | the route's bridge provider, auto-selected (\`khalani.*\`, or \`relay.*\` to/from Robinhood Chain) |
| \`bridge_status\` | \`khalani.orders.get\` (with \`orderId\`) / \`khalani.orders.list\` |

Reach for \`discover_tools\` for everything these shortcuts do not cover.

## 2. Live State (queried, not memorized)

Balances, prices, gas, open positions, quotes, transaction hashes are LIVE state. Re-query each turn — do not save them into knowledge or memory.

- Your own wallet across all families in one call: \`wallet_balances\` — covers Khalani chains AND local chains (Robinhood 4663, direct-RPC).
- One family / different address: \`khalani_tokens_balances\` — Khalani-covered chains only; for Robinhood balances use \`wallet_balances\`.
- On-chain EVM forensics (tx receipts, ERC-721 mint detection): \`chain_read\`. (Native balances → \`wallet_balances\`; token metadata/decimals → \`token_find\`.)
- Your recorded session-wallet history (recent transactions, activity, balances, snapshots): \`agent_scan\` — reads from your own DB projections (\`agent_scan(view="transactions")\` is the primary feed — pending/confirmed/failed swaps with chain + tx hash; also \`summary\`, \`balances\`, \`snapshots\`, \`activity\`, \`executions\`). No stored PnL — compute it yourself from the recorded amounts if you need it.

If a fact is queryable live, querying is cheaper than remembering — and the memorized version is stale by definition.

## 3. Protocol Execution

\`discover_tools\` searches by natural-language query and/or namespace; returns toolId + params (the param schema to build your call from) + the \`mutating\` flag. \`execute_tool\` runs a discovered tool by toolId with the required params. Every advertised tool is active and executable — build calls from \`params\`, not from memory.

Rules:

- **Discover first — for the schema, not just the name.** The toolIds printed in this prompt are real; their parameter schemas are NOT shown anywhere in it. Never build an \`execute_tool\` call without a \`discover_tools\` result from THIS session, and never execute a toolId from memory, from an old example, or from a previous transcript. During mission RUN — or in AGENT chat when the user explicitly asked for the action — discovery is a means to execution: \`execute_tool\` follows. During planning (mission SETUP / plan authoring, i.e. Capability Orientation), discovery is orientation only — see \`# Research\`.
- **Reuse your plan's tools.** During mission RUN — or in AGENT chat when the user explicitly asked for the action — when an \`# Active Plan\` is in effect (provided in the turn state), reuse the exact toolIds listed in its tool-selection section instead of re-running \`discover_tools\` for the same need every turn. Re-discover only when a required tool is absent from the plan, looks stale, or a prior call failed.
- **Mutation safety.** Every mutating call obeys the \`# Safety Contract\`: quote / preview before mutation, the 2-step transfer rule, and the pressure-barrier mutation gate.${notice}`;
}
