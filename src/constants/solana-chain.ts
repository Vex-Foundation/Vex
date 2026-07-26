/**
 * Solana's synthetic chain id, as used across the Agent Scan activity
 * vocabulary (migration `049_agent_activity_solana_vocabulary.sql`: the
 * `agent_activity_kind_family_binding` CHECK) and by every Jupiter/Solana
 * write path (kind='swap' Jupiter swaps, kind='lend', kind='prediction' —
 * all always `chain_family='solana'` + this chain id).
 *
 * This is the SAME id Khalani already uses for Solana in its chain aliases
 * (`src/tools/khalani/chains.ts` — `sol`/`solana` -> 20011000000) and that
 * `db/repos/agent-activity/bridge-intent.ts` already stores in
 * `from_chain_id`/`to_chain_id` for Solana bridge legs. It lives here — a
 * standalone chain-domain module, not `db/repos/agent-activity/types.ts` (W5
 * design REVISION 1 R1) — so the DB repo's types module stays pure types with
 * no runtime exports, and so every consumer (repo writes, the future Solana
 * sweep, Jupiter handlers) imports one canonical value instead of a repeated
 * numeric literal.
 *
 * The desktop app keeps its OWN copy for display purposes
 * (`vex-app/src/shared/chains/display.ts` — `SOLANA_CHAIN_ID`), read by both
 * Electron trust zones with zero dependency on backend/root code. The two
 * values MUST never drift; `src/__tests__/constants/solana-chain.test.ts`
 * pins them together as a cross-package contract test.
 */
export const SOLANA_SYNTHETIC_CHAIN_ID = 20_011_000_000;
