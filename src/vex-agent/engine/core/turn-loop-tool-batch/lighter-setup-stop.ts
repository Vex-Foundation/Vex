import { randomUUID } from "node:crypto";

import type { EngineContext } from "../../types.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { createWith } from "@vex-agent/db/repos/lighter-setup-interactions.js";
import {
  acquireSessionControlLock,
  gateOnOperatorStopWithClient,
} from "@vex-agent/engine/runtime/lease-and-status.js";

export type LighterSetupParkOutcome =
  | { readonly kind: "parked"; readonly intentId: string }
  | { readonly kind: "abandoned" };

export async function parkTurnOnLighterSetup(input: {
  readonly context: EngineContext;
  readonly toolCallId: string;
  readonly environment: "core" | "rhc";
}): Promise<LighterSetupParkOutcome> {
  const intentId = randomUUID();
  return withTransaction(async (client): Promise<LighterSetupParkOutcome> => {
    await acquireSessionControlLock(client, input.context.sessionId);
    const gate = await gateOnOperatorStopWithClient(client, {
      sessionId: input.context.sessionId,
      missionRunId: null,
    });
    if (gate.kind === "stopped") return { kind: "abandoned" };

    await createWith(client, {
      intentId,
      sessionId: input.context.sessionId,
      toolCallId: input.toolCallId,
      environment: input.environment,
    });
    return { kind: "parked", intentId };
  });
}
