/**
 * `mission.setLaunchCeilings` — the host-only writer for the two autonomous
 * token-launch ceilings (§C6 spend, §C6b count).
 *
 * MAIN OWNS THE UNIT CONVERSION. The renderer sends a plain decimal ETH string
 * exactly as the user typed it; this handler converts it to wei with `viem`'s
 * `parseUnits`, the same way the token-launch prebuy is handled. A renderer
 * that did its own decimal→wei maths is one UI bug away from a thousandfold
 * ceiling (rule 90), so the conversion lives here, once.
 *
 * Authority is server-side: the engine refuses a mission past the editable
 * draft/ready window (`blocked_status`), collapses a cross-session or missing
 * id to `not_found`, and clears acceptance because both ceilings are canonical
 * contract-hash material. NEVER starts a run.
 */

import { parseUnits } from "viem";

import { CH } from "@shared/ipc/channels.js";
import { ok, err, type Result } from "@shared/ipc/result.js";
import {
  missionSetLaunchCeilingsInputSchema,
  missionSetLaunchCeilingsResultSchema,
  type MissionSetLaunchCeilingsResult,
} from "@shared/schemas/mission.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { controlFailedError } from "../runtime/_errors.js";
import { ensureEngineDbUrl } from "../runtime/_ensure-engine-db-url.js";

/**
 * Native ETH on Robinhood Chain. The ceiling is compared against `msg.value` in
 * wei and is NEVER rescaled at enforcement time, so it is authored at exactly
 * these decimals — see `engine/mission/launch-ceiling.ts`.
 */
const ETH_DECIMALS = 18;

export function registerMissionSetLaunchCeilingsHandler(): () => void {
  return registerHandler({
    channel: CH.mission.setLaunchCeilings,
    domain: "mission",
    inputSchema: missionSetLaunchCeilingsInputSchema,
    outputSchema: missionSetLaunchCeilingsResultSchema,
    handle: async (input, ctx): Promise<Result<MissionSetLaunchCeilingsResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;

      let maxLaunchValueRaw: string | null = null;
      if (input.maxLaunchValueEth !== null) {
        // `parseUnits` ROUNDS excess precision instead of throwing — verified
        // against viem 2.54: `parseUnits("0.0000000000000000001", 18)` is `0n`.
        // Silently storing a rounded ceiling would show the user a number they
        // did not author, so an unrepresentable amount is refused BY NAME.
        const fraction = input.maxLaunchValueEth.split(".")[1] ?? "";
        if (fraction.length > ETH_DECIMALS) {
          return ok({
            outcome: "invalid",
            reason:
              "That amount cannot be expressed in wei — ETH has 18 decimal places. Use at most 18 digits after the point.",
          });
        }
        maxLaunchValueRaw = parseUnits(input.maxLaunchValueEth, ETH_DECIMALS).toString();
      }

      try {
        const { setMissionLaunchCeilings } = await import(
          "@vex-agent/engine/mission/set-launch-ceilings.js"
        );
        const outcome = await setMissionLaunchCeilings({
          sessionId: input.sessionId,
          missionId: input.missionId,
          maxLaunchValueRaw,
          maxLaunchValueDecimals: maxLaunchValueRaw === null ? null : ETH_DECIMALS,
          maxLaunchCount: input.maxLaunchCount,
        });
        log.info(
          `[ipc:vex:mission:setLaunchCeilings] outcome=${outcome.outcome} ` +
            `missionId=${input.missionId} correlationId=${ctx.requestId}`,
        );
        return ok(outcome);
      } catch (cause) {
        log.warn(
          `[ipc:vex:mission:setLaunchCeilings] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}
