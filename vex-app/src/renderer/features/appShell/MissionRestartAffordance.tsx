/**
 * "Tell Vex what to do differently" — the post-stop restart affordance.
 *
 * Rendered by `MissionControls` in its terminal branch (accepted contract,
 * terminal last run, no pending draft), next to "Renew mission". The two are
 * deliberately different actions and the copy has to keep them apart: Renew
 * CLONES the contract into a fresh draft you must accept again; this restarts
 * the SAME accepted contract with one added instruction. A user who only wants
 * to say "skip the SOL leg this time" should not have to re-accept a contract
 * they never changed.
 *
 * Own file rather than another branch inside `MissionControls` (534 lines
 * before this): a disclosure with local draft state is a different reason to
 * change than the control strip's routing, and the strip was already at the
 * point where one more branch would have pushed it past the repo's size rule.
 *
 * The instruction is untrusted text on its way to a transcript row the agent
 * re-reads every turn. It is bounded here by `maxLength` for the user's sake,
 * and independently by the Zod schema at the preload boundary and by the
 * engine primitive — this input is a convenience, never the enforcement.
 */

import { useState, type FormEvent, type JSX } from "react";
import { MISSION_RESTART_INSTRUCTION_MAX_LENGTH } from "@shared/schemas/mission.js";
import type { MissionRestartWithInstructionResult } from "@shared/schemas/mission.js";
import type { Result } from "@shared/ipc/result.js";
import { useMissionRestartWithInstruction } from "../../lib/api/mission.js";

export interface MissionRestartAffordanceProps {
  readonly sessionId: string;
  readonly missionId: string;
  /** Mirrors the strip's own disabled gate (a control call already in flight). */
  readonly disabled: boolean;
}

/**
 * Outcome → user copy. Every arm is named: a silent no-op after pressing
 * Restart is the failure mode that makes a user press it again, and on this
 * path a second press would be a second run.
 */
export function restartNoticeFor(
  result: Result<MissionRestartWithInstructionResult>,
): string | null {
  if (!result.ok) return "Couldn't restart the mission. Try again.";
  switch (result.data.outcome) {
    case "dispatched":
      return null;
    case "contract_dirty":
      return result.data.reason === "plan_not_accepted"
        ? "The action plan needs review before this mission can run again. Open Review & accept."
        : "The contract changed since you accepted it. Open Review & accept, then restart.";
    case "run_active":
      return "A run is still active. Stop it first, then restart.";
    case "lease_busy":
      return "The runtime is busy with another turn. Try again in a moment.";
    case "not_ready":
      return "The mission draft is no longer complete. Edit it before restarting.";
    case "provider_unavailable":
      return "No inference provider is available. Check your provider settings.";
    case "instruction_empty":
      return "Type what should be different before restarting.";
    case "mission_not_found":
    case "session_mismatch":
      return "This mission is no longer available in this session.";
  }
}

export function MissionRestartAffordance({
  sessionId,
  missionId,
  disabled,
}: MissionRestartAffordanceProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const restart = useMissionRestartWithInstruction();

  const trimmed = instruction.trim();
  const busy = disabled || restart.isPending;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (trimmed.length === 0 || busy) return;
    try {
      const result = await restart.mutateAsync({
        sessionId,
        missionId,
        instruction: trimmed,
      });
      const text = restartNoticeFor(result);
      setNotice(text);
      // Only a dispatched run clears the field. Keeping the text on every
      // refusal means a user who has to go accept a drifted contract does not
      // have to retype what they wanted changed.
      if (text === null) {
        setInstruction("");
        setOpen(false);
      }
    } catch {
      setNotice("Couldn't restart the mission. Try again.");
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen(true)}
        className="mt-2 w-full text-left text-xs text-muted-foreground underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
      >
        Tell Vex what to do differently
      </button>
    );
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="mt-2 w-full">
      <label
        htmlFor="mission-restart-instruction"
        className="mb-1 block text-xs text-muted-foreground"
      >
        What should be different this run?
      </label>
      <textarea
        id="mission-restart-instruction"
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        maxLength={MISSION_RESTART_INSTRUCTION_MAX_LENGTH}
        rows={3}
        placeholder="e.g. Skip the SOL leg and rebalance into USDC instead."
        className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
      />
      <p className="mt-1 text-[11px] text-muted-foreground">
        Restarts the same accepted contract with this instruction added. The
        contract itself is unchanged.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="submit"
          disabled={busy || trimmed.length === 0}
          className="inline-flex h-8 items-center rounded-full border border-[var(--vex-accent-border-strong)] bg-[var(--vex-accent-fill-8)] px-3.5 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--vex-accent-text)] transition-colors hover:bg-[var(--vex-accent-fill-12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Restart with instruction
        </button>
        <button
          type="button"
          disabled={restart.isPending}
          onClick={() => {
            setOpen(false);
            setNotice(null);
          }}
          className="inline-flex h-8 items-center rounded-full border border-border px-3.5 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
      {notice !== null ? (
        <p role="alert" className="mt-1 w-full text-xs text-destructive">
          {notice}
        </p>
      ) : null}
    </form>
  );
}
