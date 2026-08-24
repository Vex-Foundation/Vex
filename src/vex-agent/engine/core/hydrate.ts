/**
 * Session hydration — reconstruct engine state from DB.
 *
 * Loads session, messages, mission (if any), active run, summary.
 * loadedDocuments starts empty and is populated at tool-dispatch time
 * (e.g. MemoryGet injects fetched entry content under a `long_memory:{id}` key).
 */

import { z } from "zod";
import type { EngineContext, Permission, SessionKind, WalletPolicy } from "../types.js";
import type { WalletResolution } from "@tools/wallet/multi-auth.js";
import * as sessionsRepo from "@vex-agent/db/repos/sessions.js";
import * as messagesRepo from "@vex-agent/db/repos/messages.js";
import * as missionsRepo from "@vex-agent/db/repos/missions.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import * as sessionPlansRepo from "@vex-agent/db/repos/session-plans.js";
import { getUserProfile, type UserProfile } from "@vex-agent/db/repos/soul.js";
import { readMissionBaseline } from "../mission/baseline.js";

export interface HydratedSession {
  context: EngineContext;
  messages: messagesRepo.Message[];
  summary: string | null;
  /** Session's token count — used for checkpoint evaluation. */
  tokenCount: number;
}

/**
 * Hydrate an engine session from DB state.
 * Returns null if session doesn't exist.
 *
 * `loadedDocuments` is left empty — it is populated at tool-dispatch time
 * (e.g. MemoryGet injects fetched entry content).
 *
 * `sessionKind` and `sessionPermission` are immutable per session.
 * `sessionKind` defaults to `session.mode` from DB; if an active mission
 * is attached we surface `"mission"` regardless. `sessionPermission`
 * mirrors `session.permission` and is the single source for approval
 * gates throughout the turn — no per-call DB queries downstream.
 */
// `freezeDraft` (mission/mapper.ts) nests the mission fields under
// `frozenMission.draft`, so the accepted contract's allowed wallets live at
// `frozenMission.draft.allowedWallets` — NOT at the top of `frozenMission`.
// Reading the shallower (non-existent) path made EVERY active run resolve to an
// empty set → `empty_allowed_wallets` → invalid policy → every mission swap and
// bridge failed closed at the prequote gate. `.passthrough()` tolerates the
// other frozen fields (id/title/goal/approvedAt/constraintsJson).
const FrozenAllowedWalletsSchema = z
  .object({
    draft: z
      .object({ allowedWallets: z.array(z.string()).nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

/**
 * Resolve the mission wallet policy from the ACTIVE run's frozen contract
 * snapshot (not the live mission row, which can drift back to draft/edit).
 * A mission with no active run, or a missing/malformed/empty snapshot, is
 * `invalid` → wallet resolution fails closed (contract drift).
 */
export function resolveWalletPolicy(
  mission: missionsRepo.Mission | null,
  activeRun: missionRunsRepo.MissionRun | null,
): WalletPolicy {
  if (activeRun) {
    const frozen = (activeRun.contractSnapshotJson as { frozenMission?: unknown } | null)
      ?.frozenMission;
    const parsed = FrozenAllowedWalletsSchema.safeParse(frozen ?? null);
    if (!parsed.success) return { kind: "invalid", reason: "missing_or_malformed_snapshot" };
    const allowed = parsed.data.draft?.allowedWallets ?? [];
    if (allowed.length === 0) return { kind: "invalid", reason: "empty_allowed_wallets" };
    return { kind: "mission_allowed", allowedWallets: allowed };
  }
  // Mission in setup (no active run yet) has no accepted snapshot → fail closed.
  if (mission) return { kind: "invalid", reason: "mission_without_active_run" };
  return { kind: "none" };
}

/**
 * Build a session-scoped WalletResolution from a hydrated context's selection.
 * Engine sessions ALWAYS use source:"session" — a null family selection makes
 * wallet tools for that family fail closed (no fall-through to primary).
 */
export function buildSessionWalletResolution(ctx: {
  selectedEvmWallet: { id: string; address: string } | null;
  selectedSolanaWallet: { id: string; address: string } | null;
}): WalletResolution {
  return { source: "session", evm: ctx.selectedEvmWallet, solana: ctx.selectedSolanaWallet };
}

export async function hydrateEngineSession(sessionId: string): Promise<HydratedSession | null> {
  const session = await sessionsRepo.getSession(sessionId);
  if (!session) return null;

  // Load messages
  const messages = await messagesRepo.getLiveMessages(sessionId);

  // Load active mission (excludes completed/failed/cancelled)
  const mission = await missionsRepo.getActiveMission(sessionId);
  let activeRun: missionRunsRepo.MissionRun | null = null;
  let missionRunId: string | null = null;

  if (mission) {
    activeRun = await missionRunsRepo.getActiveRun(mission.id);
    if (activeRun) {
      missionRunId = activeRun.id;
    }
  }

  // Mode discrimination: a session with an attached active mission acts as
  // "mission" regardless of the row's `mode` column. Sessions without a
  // mission fall through to whatever `mode` the row was created with — only
  // `"agent"` is observed today since mission setup creates the mission row
  // synchronously (see Commit C mission creation pipeline).
  const sessionKind: SessionKind = mission ? "mission" : session.mode;
  const sessionPermission: Permission = session.permission;

  // User profile (DB singleton) — advisory prompt personalization; a read
  // failure degrades to an unpersonalized prompt, never a failed hydration.
  let userProfile: UserProfile = {
    displayName: null,
    instructionsMd: null,
    workDescription: null,
    stylePreset: null,
    characteristics: [],
    riskAppetite: null,
  };
  try { userProfile = await getUserProfile(); } catch { /* degrade silently */ }

  // Session-scoped plan-mode (turn-start snapshot for tool visibility + the
  // "# Active Plan" prompt layer). A missing row means plan-mode is off. The
  // dispatcher execution gate re-reads acceptance live per call, so this
  // snapshot drives only what the model SEES, not what it can execute.
  const plan = await sessionPlansRepo.getActivePlan(sessionId);

  return {
    context: {
      sessionId,
      sessionKind,
      sessionPermission,
      missionId: mission?.id ?? null,
      missionRunId,
      sessionStartedAt: session.startedAt,
      missionRunStartedAt: activeRun?.startedAt ?? null,
      missionDeadline: extractMissionDeadline(mission?.constraintsJson ?? null),
      selectedEvmWallet: session.selectedEvmWallet,
      selectedSolanaWallet: session.selectedSolanaWallet,
      walletPolicy: resolveWalletPolicy(mission, activeRun),
      loadedDocuments: new Map(), // Populated by caller
      userDisplayName: userProfile.displayName,
      userInstructionsMd: userProfile.instructionsMd,
      userWorkDescription: userProfile.workDescription,
      userStylePreset: userProfile.stylePreset,
      userCharacteristics: userProfile.characteristics,
      userRiskAppetite: userProfile.riskAppetite,
      planMode: plan?.enabled ?? false,
      planMd: plan?.enabled ? plan.planMd : null,
      planAccepted: plan?.accepted ?? false,
      // Frozen start-of-run capital baseline. ZERO extra queries: `activeRun`
      // is already loaded above and every run read is `SELECT *`. The blob is
      // immutable once written, so a hydration snapshot cannot go stale.
      missionBaseline: readMissionBaseline(activeRun?.baselineJson ?? null),
    },
    messages,
    summary: session.summary ?? null,
    tokenCount: session.tokenCount,
  };
}

function extractMissionDeadline(constraints: Record<string, unknown> | null): string | null {
  const raw = constraints?.deadline;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}
