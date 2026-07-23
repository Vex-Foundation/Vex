-- 047: drop the legacy PnL projection tables (owner order, 2026-07-23).
--
-- Agent Scan Phase 1 deleted every writer and reader of the FIFO-lot PnL
-- machinery (repos pnl-lots/pnl-matches, sync projectors, MTM) — since then
-- `proj_pnl_lots` / `proj_pnl_matches` have been orphaned archives no code
-- references (verified: only historical migrations 001/003/004 and narrative
-- comments mention them). `agent_activity` (044/045) is the trade-truth store.
--
-- DESTRUCTIVE by design: the owner explicitly ordered the legacy rows dropped
-- "żeby nie było niejasności". No expand/contract window is needed — there is
-- no reader on either side of the deploy.
--
-- Order matters: matches FK-references lots.

DROP TABLE IF EXISTS proj_pnl_matches;
DROP TABLE IF EXISTS proj_pnl_lots;
