/**
 * Research — constant static layer (P3 decomposition, split out of the old
 * `tool-usage.ts` §6). Holds the `web_research` shapes, the per-mode research
 * workflow, and the canonical "Capability Orientation vs Operational Research"
 * discipline (merged in from the former `planning-discipline.ts`).
 *
 * ONE vocabulary for planning vs execution: planning identifies WHICH
 * tools/venues the work will use; live market work happens only in the mission
 * RUN (or an explicit user-requested preflight). Deterministic text (no
 * timestamps/randomness) so it stays cache-stable in the static prefix. Tool
 * NAMES here are generic static pointers ("when present in your Tool Map");
 * dynamic availability lives in the turn-state Tool Map.
 */

export function buildResearchPrompt(): string {
  return `# Research

\`web_research\` is one tool. Default: search + auto-scrape top 5 hits in a single Tavily batch call. Pick the smallest shape that answers the question:

- \`web_research({ query: "..." })\` — DEFAULT: search + scrape top 5.
- \`web_research({ query: "...", fetchTop: 10 })\` — for deep research needing multiple sources.
- \`web_research({ query: "...", fetchTop: 0 })\` — search-only, no scraping. Rare.
- \`web_research({ url: "https://..." })\` — fetch one specific page as markdown.

Pass \`searchDepth: "advanced"\` only when \`basic\` recall is insufficient (costs more Tavily credits).

Research workflow varies by mode. Mission SETUP: this is Capability Orientation — identify which tools/venues fit the mission and ground the draft (read \`wallet_balances\`, \`agent_scan\`), not market operation; do NOT call \`execute_tool\` on market data or pull quotes while planning (see the rule below). Mission RUN: research must end in an actionable decision (execute / shortlist / defer / stop). Chat: answer the current request, then stop.

## Capability Orientation vs Operational Research

Planning and execution use tools differently:

- **Capability Orientation** (planning — mission setup and plan authoring): identify WHICH tools and venues the work will use. Read your Available Tool Map categories — including the Research category (\`web_research\`, \`twitter_account\`) when present — and use \`discover_tools\` for protocol-tool metadata (toolId, params, mutating flag). This is orientation, not market operation: do NOT call \`execute_tool\` on market data (token trending, boosts, pair scans) and do NOT pull route/price quotes while planning. Reads of your OWN state — \`wallet_balances\`, \`agent_scan\` — are allowed, to ground capital and chains.
- **Operational Research** (mission run, or only when the user explicitly asks for preflight): live market scans, route/price quotes, and X/web market-signal lookups that feed an execution decision. This is the only phase where discovery leads to \`execute_tool\` on market data.

During mission RUN / agent execution (Operational Research), when researching markets or tokens, discovery is a means to execution. After \`discover_tools\` returns a relevant read-only protocol tool, choose the best \`toolId\` and call \`execute_tool\` before repeating discovery for the same namespace or falling back to \`web_research\`.`;
}
