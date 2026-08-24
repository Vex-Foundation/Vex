/** Static research-mode discipline. Cross-namespace procedure lives with task shapes. */

const CAPABILITY_ORIENTATION_SECTION = `## Capability Orientation vs Operational Research

Planning and execution use tools differently:

- **Capability Orientation** (planning — mission setup and plan authoring): identify WHICH tools and venues the work will use. Read your Available Tool Map categories — including the Research category (\`WebResearch\`, \`TwitterAccount\`) when present — and use \`ToolSearch\` for protocol-tool metadata (name, summary, mutating flag). This is orientation, not market operation: do NOT call discovered market-data tools (token trending, boosts, pair scans) and do NOT pull route/price quotes while planning. Reads of your OWN state — \`WalletBalances\`, \`AgentScan\` — are allowed, to ground capital and chains.
- **Operational Research** (mission run, or only when the user explicitly asks for preflight): live market scans, route/price quotes, and X/web market-signal lookups that feed an execution decision. This is the only phase where discovery leads to actually calling a market-data tool.

During mission RUN — or in AGENT chat when the user explicitly asked for the action — discovery is a means to execution (Operational Research). After \`ToolSearch\` returns a relevant read-only protocol tool, choose the best one and CALL IT BY NAME on your next turn before searching the same namespace again or reaching for a general web lookup.`;

export function buildResearchPrompt(): string {
  return `# Research

Research workflow varies by mode. Mission SETUP: this is Capability Orientation — identify which tools/venues fit the mission and ground the draft (read \`WalletBalances\`, \`AgentScan\`), not market operation; do NOT call market-data tools or pull quotes while planning (see the rule below). Mission RUN: research must end in an actionable decision (execute / shortlist / defer / stop). Chat: answer the current request, then stop.

${CAPABILITY_ORIENTATION_SECTION}`;
}
