/**
 * Tool Model — constant static layer (P3 decomposition, split out of the old
 * `tool-usage.ts` §1–§3). Holds the routing model: internal vs protocol tools,
 * the discover-then-call mechanics, and live-state routing
 * (query, never memorize).
 *
 * DISCOVER-THEN-CALL (owner decree 2026-08-03). A discovered protocol tool is
 * appended to the next request's `tools` array as a REAL function schema
 * (`registry/injected-protocol-tools.ts`), so the model calls it BY NAME and the
 * provider enforces `required` for it. This layer describes that flow and only
 * that flow: an envelope the model can no longer see would be an instruction it
 * cannot follow. The `.` → `__` name mapping stated below is the one
 * `toInjectedToolName` implements — if that mapping changes, this text changes
 * in the same commit. The discovery row counts are INTERPOLATED from
 * `DEFAULT_DISCOVERY_LIMIT` / `MAX_DISCOVERY_LIMIT` for the same reason: the
 * prose said "up to 10" while the runtime served 5 by default and capped at 20,
 * and a number a human retypes is a number that drifts.
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

import {
  DEFAULT_DISCOVERY_LIMIT,
  MAX_DISCOVERY_LIMIT,
} from "@vex-agent/tools/protocols/discovery.js";

import { buildMissingCapabilityNotice } from "./capability-availability.js";

export function buildToolModelPrompt(): string {
  // Live env read on every build (vault unlock/lock mutates process.env), so the
  // notice describes the posture of THIS prompt build. "" when nothing is missing.
  const missingCapabilityNotice = buildMissingCapabilityNotice();
  const notice = missingCapabilityNotice.length > 0 ? `\n\n${missingCapabilityNotice}` : "";

  return `# Tool Model

## 1. Tool Selection

Two ways to call tools:

1. **Direct internal tools** — called by name. Listed in the Tool Map provided in the turn state with their category. Examples: \`wallet_balances\`, \`session_memory_search\`, \`compact_apply\`. Used for agent-level operations and curated read-only shortcuts.

2. **Protocol tools** — the full multi-chain protocol surface. You do not see them until you ask: call \`discover_tools\`, and every tool it returns becomes a REAL callable function for the rest of this session, which you then call BY NAME like any other tool. A dotted \`toolId\` is written with double underscores when you call it: \`kyberswap.swap.execute\` is called as \`kyberswap__swap__execute\`, \`khalani.bridge\` as \`khalani__bridge\`. Discovery gives you the exact name and the exact parameter schema — use both as given.

Use the Tool Map for the DIRECT tools: if a direct internal tool is not in it RIGHT NOW, it is not callable. The pressure-band filter, role gates, and env gates already narrowed that list to what the dispatcher will accept. Do not emit calls to direct tools that are not in the Map — the dispatcher rejects them with an actionable error explaining which gate blocked. Protocol tools are NOT listed there individually: the Map carries \`discover_tools\`, and the protocol surface behind it is what \`# Available Protocol Namespaces\` describes — a namespace missing from the Map is not evidence its tools do not exist.

Every call example in this prompt is written as \`tool_name(param="value")\`. That notation shows INTENT, not wire format — always emit a real tool call through the tools API, never the example text as a message.

### Shortcuts are the same engines

The curated shortcuts below run the SAME protocol code as the dotted toolIds they route to. PREFER the shortcut: it is one call instead of a discovery round trip plus the protocol call, and its schema is already in front of you.

| Shortcut | Runs |
| --- | --- |
| \`token_find\` | \`khalani.tokens.search\` (canonical token resolver) |
| \`token_check\` | \`kyberswap.tokens.check\` (EVM honeypot / fee-on-transfer) |
| \`swap_quote\` / \`swap_execute\` | the chain's swap venue (EVM → \`kyberswap.swap.*\`, \`chain="solana"\` → \`solana.swap.*\`) |
| \`bridge_quote\` / \`bridge\` | the route's bridge provider, auto-selected (\`khalani.*\`, or \`relay.*\` to/from Robinhood Chain) |
| \`bridge_status\` | \`khalani.orders.get\` (with \`orderId\`) / \`khalani.orders.list\` |

Reach for \`discover_tools\` for everything these shortcuts do not cover.

## 2. Live State (queried, not memorized)

Balances, prices, gas, open positions, quotes, transaction hashes are LIVE state. Re-query each turn — do not save them into knowledge or memory.

- Your own wallet across all families in one call: \`wallet_balances\` — covers Khalani chains AND local chains (Robinhood 4663, direct-RPC).
- SOMEONE ELSE's address, or one wallet family alone: discover \`khalani.tokens.balances\` and call \`khalani__tokens__balances\` — Khalani-covered chains only, so Robinhood balances still need \`wallet_balances\`.
- On-chain EVM forensics (tx receipts, ERC-721 mint detection): \`chain_read\` — covers Khalani chains AND local chains (\`chain: "robinhood"\` / \`"4663"\`; the param is \`chain\`, and \`chainId\` is refused by name). (Native balances → \`wallet_balances\`; token metadata/decimals → \`token_find\`.)
- Your recorded session-wallet history (recent transactions, activity, balances, snapshots): \`agent_scan\` — reads from your own DB projections (\`agent_scan(view="transactions")\` is the primary feed — pending/confirmed/failed swaps with chain + tx hash; also \`summary\`, \`balances\`, \`snapshots\`, \`activity\`, \`executions\`). No stored PnL — compute it yourself from the recorded amounts if you need it.

If a fact is queryable live, querying is cheaper than remembering — and the memorized version is stale by definition.

## 3. Protocol Execution

\`discover_tools\` searches by natural-language query and/or namespace and returns ${DEFAULT_DISCOVERY_LIMIT} tools by default — raise \`limit\` up to ${MAX_DISCOVERY_LIMIT} when the job needs a bigger working set, and note that a limit outside 1-${MAX_DISCOVERY_LIMIT} is rejected by name, not clamped. Each row carries its toolId, its full \`params\` schema, and its \`mutating\` flag. Every tool it returns is then a real callable function for the rest of the session: you call it by its underscored name, and the provider enforces its required params for you. Every advertised tool is active and executable — build calls from \`params\`, not from memory.

### A complete trace

\`\`\`
discover_tools(query="swap quote on base", namespace="kyberswap")
  → { toolId: "kyberswap.swap.quote", mutating: false, params: [
        { key: "chain",     type: "string", required: true,  … },
        { key: "tokenIn",   type: "string", required: true,  … },
        { key: "tokenOut",  type: "string", required: true,  … },
        { key: "amountIn",  type: "string", required: true,  … },
        { key: "slippageBps", type: "number", unit: "bps",   … } ] }

kyberswap__swap__quote(chain="base",
                       tokenIn="0x4200000000000000000000000000000000000006",
                       tokenOut="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
                       amountIn="0.25")
\`\`\`

Read that trace for three things: the name is the toolId with every \`.\` replaced by \`__\`; every param carrying \`required: true\` is sent, and a param with no \`required\` key at all is optional; and the values are literal — an address stays an address, a \`bps\` value is basis points (100 = 1%), and an amount is raw atomic units or human decimals exactly as its own description says.

Rules:

- **Discover first — for the schema, not just the name.** The toolIds printed in this prompt are real; their parameter schemas are NOT shown anywhere in it. Never call a protocol tool without a \`discover_tools\` result from THIS session, and never reconstruct a call from memory, from an old example, or from a previous transcript. During mission RUN — or in AGENT chat when the user explicitly asked for the action — discovery is a means to execution: the protocol call follows in the next turn. During planning (mission SETUP / plan authoring, i.e. Capability Orientation), discovery is orientation only — see \`# Research\`.
- **See a whole namespace at once.** \`discover_tools(namespace="x", list=true)\` returns EVERY tool of that namespace as one-line rows (toolId, mutating flag, description — no param schemas), unranked and untruncated. Use it when you need to know what a namespace can do rather than to match one intent; then run a normal query, or pass the exact toolId, to get the \`params\` schema and make the tool callable.
- **Reuse your plan's tools.** During mission RUN — or in AGENT chat when the user explicitly asked for the action — when an \`# Active Plan\` is in effect (provided in the turn state), reuse the exact toolIds listed in its tool-selection section instead of re-running \`discover_tools\` for the same need every turn. Re-discover only when a required tool is absent from the plan, looks stale, or a prior call failed.
- **Mutation safety.** Every mutating call obeys the \`# Safety Contract\`: quote / preview before mutation, the 2-step transfer rule, and the pressure-barrier mutation gate.${notice}`;
}
