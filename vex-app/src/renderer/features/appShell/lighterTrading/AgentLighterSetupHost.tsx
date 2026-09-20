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
    return window.vex.engine.onLighterSetupRequested((event: LighterSetupHandoffEvent) => {
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
    let active = true;
    void window.vex.lighterTrading.getPendingAgentSetup({ sessionId }).then((result) => {
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

  const settle = useCallback(async (
    outcome: "completed",
  ): Promise<boolean> => {
    if (snapshot === null) return false;
    const result = await window.vex.lighterTrading.settleAgentSetup({
      sessionId: snapshot.sessionId,
      intentId: snapshot.intentId,
      outcome,
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
      lockEnvironment
      externalError={settlementError}
      onDone={() => settle("completed")}
      onCancel={cancel}
    />
  );
}
