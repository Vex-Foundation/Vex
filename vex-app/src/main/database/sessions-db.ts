/**
 * Sessions DB helper for the multi-session app shell.
 *
 * vex-app's main process talks to the same Postgres instance the engine
 * (`src/vex-agent`) writes to, but it does NOT import the engine repos —
 * vex-app deliberately uses its own pg connections so the GUI build stays
 * decoupled from the engine module graph (mirrors the pattern in
 * `dim-lock.ts`).
 *
 * SQL is the contract here. The base Vex Agent migrations create:
 *   sessions(id PK, scope, started_at, ended_at, ..., mode CHECK ('agent'|'mission'),
 *            permission CHECK ('restricted'|'full'), initial_goal)
 *   missions(id PK, root_session_id FK, status, title, goal, ...)
 *   mission_runs(id PK, mission_id FK, session_id FK, status, ...)
 *
 * Mission creation pipeline:
 *   1. INSERT sessions (mode='mission', permission, initial_goal=NULL)
 *   2. INSERT missions (id, root_session_id=session.id, status='draft')
 *   3. Do NOT create mission_runs here — that happens later via startMission()
 *      after the conversational setup flow refines the contract.
 * Steps 1+2 run inside a single BEGIN/COMMIT — a crash after step 1 must NOT
 * leave a mission session without its missions row.
 *
 * The first chat submit for a mission stores the initial goal snapshot and
 * lets the engine's mission-setup conversational flow refine the draft.
 *
 * This module is the compatibility façade for the sessions DB repository:
 * the implementation lives in `./sessions/*` and is re-exported here so the
 * existing import path (`../database/sessions-db.js`) keeps its public surface.
 */

export { createSessionWithClient, createSession } from "./sessions/create.js";
export {
  getSessionWalletScope,
  initializeSessionWalletScopeWithClient,
  initializeSessionWalletScope,
  type SessionWalletScopeRow,
} from "./sessions/wallet-scope.js";
export { setInitialMissionGoalIfUnset } from "./sessions/mission-goal.js";
export { getSessionById, listSessions } from "./sessions/read.js";
export { getSessionExportMessages } from "./sessions/export-history.js";
export { softDeleteSessionWithClient, softDeleteSession } from "./sessions/delete.js";
export { setSessionPinnedWithClient, setSessionPinned } from "./sessions/pin.js";
