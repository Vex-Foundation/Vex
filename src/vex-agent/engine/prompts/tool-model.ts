/**
 * Tool Model — constant static layer (P3 decomposition, split out of the old
 * `tool-usage.ts` §1–§3). Holds the routing model: internal vs protocol tools,
 * the discover-then-call mechanics, and live-state routing
 * (query, never memorize).
 *
 * SEARCH-THEN-CALL. A selected protocol tool is appended to the NEXT request's
 * `tools` array as a REAL function schema
 * (`registry/injected-protocol-tools.ts`), so the model calls it BY NAME and the
 * provider enforces `required` for it. This layer describes that flow and only
 * that flow: an envelope the model can no longer see would be an instruction it
 * cannot follow.
 *
 * THE NAME IS NEVER DERIVED. An earlier version of this text taught a `.` → `__`
 * transform. That transform is GONE: `publicName` is an authored table entry
 * (`tool-surface-spec/mappings/*.json`) and the grammar now carries exactly one
 * `__`, at the namespace boundary, so the toolId `kyberswap.swap.quote` is named
 * `kyberswap__swap_quote` and no string surgery produces it. Teaching a
 * derivation would teach the model to fabricate names the catalog rejects. The
 * rule is: use the name the result gave you, verbatim.
 *
 * The row counts are INTERPOLATED from `DEFAULT_DISCOVERY_LIMIT` /
 * `MAX_DISCOVERY_LIMIT`: the prose once said "up to 10" while the runtime served
 * 5 by default and capped at 20, and a number a human retypes is a number that
 * drifts.
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

1. **Direct internal tools** — called by name. Listed in the Tool Map provided in the turn state with their category. Examples: \`WalletBalances\`, \`SessionMemorySearch\`, \`CompactApply\`. Used for agent-level operations and curated read-only shortcuts.

2. **Protocol tools** — the full multi-chain protocol surface. You do not see them until you ask: call \`ToolSearch\`, and every tool it returns is added to your tool list as a REAL function with its full parameter schema, which you then call BY NAME like any other tool. Use the name EXACTLY as the result gave it (\`kyberswap__swap_quote\`, \`khalani__bridge_execute\`) — the name is an authored identifier, not something you can build from a dotted id, and a name you construct yourself will not resolve.

Use the Tool Map for the DIRECT tools: if a direct internal tool is not in it RIGHT NOW, it is not callable. The pressure-band filter, role gates, and env gates already narrowed that list to what the dispatcher will accept. Do not emit calls to direct tools that are not in the Map - the dispatcher rejects them with an actionable error explaining which gate blocked. Protocol tools are NOT listed there individually: the Map carries \`ToolSearch\`, and the protocol surface behind it is what \`## What Vex can reach\` describes - a namespace missing from the Map is not evidence its tools do not exist.

Every call example in this prompt is written as \`tool_name(param="value")\`. That notation shows INTENT, not wire format — always emit a real tool call through the tools API, never the example text as a message.

### Shortcuts route through the owned engines

The curated shortcuts below keep one stable name while routing through the protocol or chain capability that owns the request. PREFER the shortcut: it is one call instead of a discovery round trip plus the protocol call, and its schema is already in front of you.

One exception: an explicit Lighter deposit or funding amount is an exact transfer, not an onboarding collateral target. Skip the onboarding shortcuts and \`WalletBalances\`; call \`ToolSearch\` once for \`lighter.deposit.prepare\`, then pass the user's amount unchanged. Deposit preparation owns its live balance and readiness preflight.

| Shortcut | Runs |
| --- | --- |
| \`lighter_rhc_onboarding_status\` | \`lighter.account.onboarding.status\` fixed to Robinhood Chain; setup and named-trade collateral readiness only, never direct deposit sizing |
| \`lighter_core_onboarding_status\` | \`lighter.account.onboarding.status\` fixed to Core; setup and named-trade collateral readiness only, never direct deposit sizing |
| \`TokenFind\` | EVM token identity router: Khalani search on Khalani-covered chains, local search plus contract validation on Robinhood Chain |
| \`TokenCheck\` | \`kyberswap__token_safety_check\` (EVM honeypot / fee-on-transfer) |
| \`SwapQuote\` / \`SwapExecute\` | the chain's swap venue (EVM → \`kyberswap__swap_*\`, \`chain="solana"\` → \`solana__swap_*\`) |
| \`BridgeQuote\` / \`BridgeExecute\` | the route's bridge provider, auto-selected (Khalani, or Relay to/from Robinhood Chain) |
| \`BridgeStatus\` | \`khalani__order_get\` (with \`orderId\`) / \`khalani__orders_list\` |

Reach for \`ToolSearch\` for everything these shortcuts do not cover.

## 2. Live State (queried, not memorized)

Balances, prices, gas, open positions, quotes, transaction hashes are LIVE state. Re-query each turn — do not save them into knowledge or memory.

- Your own wallet across all families in one call: \`WalletBalances\` — covers Khalani chains AND local chains (Robinhood 4663, direct-RPC).
- SOMEONE ELSE's address, or one wallet family alone: search for the Khalani balances read and call it by the name the result gives — Khalani-covered chains only, so Robinhood balances still need \`WalletBalances\`.
- On-chain EVM forensics (tx receipts, ERC-721 mint detection, and \`erc20_balance\`, a direct \`balanceOf\` for one token and one owner, defaulting to your own wallet): \`ChainRead\` — covers Khalani chains AND local chains (\`chain: "robinhood"\` / \`"4663"\`; the param is \`chain\`, and \`chainId\` is refused by name). \`erc20_balance\` asks the token contract itself, so it is what settles "did that buy actually deliver": \`WalletBalances\` reports a scan projection, and receipt Transfer logs are written by the token. (Native balances → \`WalletBalances\`; token symbol/name → \`TokenFind\`.)
- Your recorded session-wallet history (recent transactions, activity, balances, snapshots): \`AgentScan\` — reads from your own DB projections (\`AgentScan(view="transactions")\` is the primary feed — pending/confirmed/failed swaps with chain + tx hash; also \`summary\`, \`balances\`, \`snapshots\`, \`activity\`, \`executions\`). No stored PnL — compute it yourself from the recorded amounts if you need it.

If a fact is queryable live, querying is cheaper than remembering — and the memorized version is stale by definition.

## 3. Protocol Execution

\`ToolSearch\` is the one entry point to the protocol surface, with three modes:

- **Search** — \`ToolSearch(query="...")\`, optionally \`namespace="..."\` to rank inside one protocol. Returns ${DEFAULT_DISCOVERY_LIMIT} rows by default; raise \`limit\` up to ${MAX_DISCOVERY_LIMIT} when the job needs a bigger working set. A limit outside 1-${MAX_DISCOVERY_LIMIT} is rejected by name, not clamped.
- **List a namespace** — \`ToolSearch(namespace="x")\` with NO query returns every tool of that protocol as one-line rows with their required param keys, unranked and untruncated. Use it to learn what a namespace can do rather than to match one intent. A listing is a menu: it makes nothing callable.
- **Select** — \`ToolSearch(query="select:Name1,Name2")\` makes named tools callable. Use it to order from a listing, and to recover a tool whose schema an earlier result no longer carries because the conversation moved on or was compacted away.

Search answers with names, one-line summaries and match evidence. Select answers with acknowledgement rows only - the name and whether it is now callable - because you already know what you asked for. Neither returns parameter schemas. Each tool they return is added to your tool list as a real function carrying its full schema, and the provider enforces its required params for you. That addition takes effect on your NEXT message: a tool you just searched for or selected is not callable in the same turn you asked for it.

### A complete trace

\`\`\`
turn N:    ToolSearch(query="swap quote on base", namespace="kyberswap")
             → { publicName: "kyberswap__swap_quote",
                 summary: "Preview a KyberSwap route ...",
                 mutating: false, actionKind: "read" }

turn N+1:  kyberswap__swap_quote(chain="base",
                                 tokenIn="0x4200000000000000000000000000000000000006",
                                 tokenOut="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
                                 amountIn="0.25")
\`\`\`

Read that trace for three things: the call uses \`publicName\` EXACTLY as returned, never a name you assembled yourself; the call happens on the FOLLOWING turn, because that is when the schema reaches you; and the values are literal — an address stays an address, a \`bps\` value is basis points (100 = 1%), and an amount is raw atomic units or human decimals exactly as its own parameter description says.

An amount is raw base units or human decimals, exactly as its name and description say. The two differ by orders of magnitude. Do not convert, round, or guess a unit - resolve decimals with \`TokenFind\` first.

Rules:

- **Search first — for the schema, not just the name.** The tools named in this prompt are real; their parameter schemas are NOT shown anywhere in it. Never call a protocol tool without a \`ToolSearch\` result from THIS session, and never reconstruct a call from memory, from an old example, or from a previous transcript. During mission RUN — or in AGENT chat when the user explicitly asked for the action — searching is a means to execution: the protocol call follows in the next turn. During planning (mission SETUP / plan authoring, i.e. Capability Orientation), searching is orientation only — see \`# Research\`.
- **Reuse your plan's tools.** During mission RUN — or in AGENT chat when the user explicitly asked for the action — when an \`# Active Plan\` is in effect (provided in the turn state), select the exact tools listed in its tool-selection section instead of re-running a search for the same need every turn. Search again only when a required tool is absent from the plan, looks stale, or a prior call failed.
- **Mutation safety.** Every mutating call obeys the \`# Safety Contract\`: quote / preview before mutation, the 2-step transfer rule, and the pressure-barrier mutation gate.${notice}`;
}
