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

  useEffect(() => {
    return window.vex.engine.onLighterSetupRequested((event: LighterSetupHandoffEvent) => {
      if (event.sessionId !== sessionId) return;
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
      setSnapshot({
        intentId: interaction.intentId,
        sessionId: interaction.sessionId,
        environment: interaction.environment,
      });
    });
    return () => { active = false; };
  }, [sessionId]);

  const settle = useCallback(async (
    outcome: "completed" | "cancelled",
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

  if (snapshot === null || snapshot.sessionId !== sessionId) return null;
  return (
    <LighterAccountSetupModal
      key={snapshot.intentId}
      open
      onOpenChange={() => undefined}
      sessionId={snapshot.sessionId}
      environment={snapshot.environment}
      lockEnvironment
      onDone={() => settle("completed")}
      onCancel={() => settle("cancelled")}
    />
  );
}
