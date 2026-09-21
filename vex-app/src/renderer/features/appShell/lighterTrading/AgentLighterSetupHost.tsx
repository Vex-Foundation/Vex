import { useCallback, useEffect, useState, type JSX } from "react";
import type { LighterSetupHandoffEvent } from "@shared/schemas/lighter-setup-handoff.js";
import { LighterAccountSetupModal } from "./LighterAccountSetupModal.js";

interface SetupSnapshot {
  readonly intentId: string;
  readonly sessionId: string;
  readonly environment: "core" | "rhc";
}

export function AgentLighterSetupHost({
  sessionId,
}: {
  readonly sessionId: string | null;
}): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<SetupSnapshot | null>(null);
  const [settlementError, setSettlementError] = useState<string | null>(null);

  useEffect(() => {
    const engine = window.vex.engine;
    if (engine?.onLighterSetupRequested === undefined) return undefined;
    return engine.onLighterSetupRequested((event: LighterSetupHandoffEvent) => {
      if (event.sessionId !== sessionId) return;
      setSettlementError(null);
      setSnapshot({
        intentId: event.intentId,
        sessionId: event.sessionId,
        environment: event.environment,
      });
    });
  }, [sessionId]);

  useEffect(() => {
    if (sessionId === null) {
      setSnapshot(null);
      return;
    }
    // The host mounts with the agent shell, which is also rendered where the
    // Lighter bridge is absent. An unguarded read here threw during mount and
    // took the whole shell down with it, so a missing bridge is simply no
    // parked setup to resume.
    const bridge = window.vex.lighterTrading;
    if (bridge?.getPendingAgentSetup === undefined) {
      setSnapshot(null);
      return;
    }
    let active = true;
    void bridge.getPendingAgentSetup({ sessionId }).then((result) => {
      if (!active || !result.ok || result.data.interaction === null) return;
      const interaction = result.data.interaction;
      setSettlementError(null);
      setSnapshot({
        intentId: interaction.intentId,
        sessionId: interaction.sessionId,
        environment: interaction.environment,
      });
    });
    return () => { active = false; };
  }, [sessionId]);

  /**
   * `environment` is the one the modal FINISHED, which need not be the one the
   * agent opened it with: the toggle is the user's to move. Main verifies and
   * records that deployment, so the parked turn is answered about the account
   * the user actually set up.
   */
  const settle = useCallback(async (
    environment: "core" | "rhc",
  ): Promise<boolean> => {
    if (snapshot === null) return false;
    const result = await window.vex.lighterTrading.settleAgentSetup({
      sessionId: snapshot.sessionId,
      intentId: snapshot.intentId,
      outcome: "completed",
      environment,
    });
    if (!result.ok || !result.data.settled) return false;
    setSnapshot(null);
    return true;
  }, [snapshot]);

  const cancel = useCallback((): void => {
    if (snapshot === null) return;
    const cancelled = snapshot;
    // The button is already an explicit, deliberate choice. Remove the modal
    // in the same event turn; durable settlement continues below and restores
    // the surface only if main refuses to acknowledge it.
    setSettlementError(null);
    setSnapshot(null);
    void window.vex.lighterTrading.settleAgentSetup({
      sessionId: cancelled.sessionId,
      intentId: cancelled.intentId,
      outcome: "cancelled",
    }).then((result) => {
      if (result.ok && result.data.settled) return;
      setSettlementError("Vex could not record the cancellation. Try again.");
      setSnapshot((current) => current ?? cancelled);
    }).catch(() => {
      setSettlementError("Vex could not record the cancellation. Try again.");
      setSnapshot((current) => current ?? cancelled);
    });
  }, [snapshot]);

  if (snapshot === null || snapshot.sessionId !== sessionId) return null;
  return (
    <LighterAccountSetupModal
      key={snapshot.intentId}
      open
      onOpenChange={() => undefined}
      sessionId={snapshot.sessionId}
      environment={snapshot.environment}
      externalError={settlementError}
      onDone={(environment) => settle(environment)}
      onCancel={cancel}
    />
  );
}
