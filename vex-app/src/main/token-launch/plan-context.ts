/**
 * The shared LAUNCH PLAN CONTEXT — everything both the preview and the submit
 * must resolve before a plan can be built, resolved exactly once.
 *
 * WHY IT IS ONE FUNCTION. Preview shows the user a number; submit authorizes it.
 * If those two assembled their inputs separately — a different wallet, a
 * different fee planner, a different chain client — the figure shown and the
 * figure charged could disagree while both looked correct in isolation. That
 * class of defect is invisible to a test of either side alone, so the two are
 * not allowed to have separate assembly code.
 *
 * It resolves inputs and refuses; it never signs, writes, or spends.
 */

import {
  buildLaunchPlan,
  type BuildLaunchPlanInput,
  type LaunchPlan,
  type LaunchPlanRefusalCode,
} from "@vex-agent/tools/protocols/trench/handlers/launch/plan.js";
import { validateLaunchRequest } from "@vex-agent/tools/protocols/trench/handlers/launch/validate.js";
import type { ValidatedLaunchRequest } from "@vex-agent/tools/protocols/trench/handlers/launch/validate.js";
import {
  planTrenchLaunchFeeLeg,
  type PlanTrenchFeeLeg,
} from "@vex-agent/tools/protocols/trench/handlers/launch/fee-seam.js";
import type { Permission } from "@vex-agent/engine/types.js";
import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getLocalPublicClient } from "@tools/evm-chains/evm-client.js";
import type { TokenLaunchForm } from "@shared/schemas/token-launch.js";
import { getSessionById, getSessionWalletScope } from "../database/sessions-db.js";

export { buildLaunchPlan, validateLaunchRequest };
export type { LaunchPlan, LaunchPlanRefusalCode };

/** The zero address, as the fee planner names the native asset. */
export const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** The chain Trench Express launches on. */
export const TRENCH_LAUNCH_CHAIN_ID = TRENCH_CHAIN_ID;

/**
 * Reasons the main side refuses. Mapped 1:1 onto `tokenLaunch.*` error codes by
 * the handler — the handler owns the wire shape, this module owns the reason.
 */
export type TokenLaunchRefusal =
  | { readonly kind: "preview_stale"; readonly detail: string }
  | { readonly kind: "value_ceiling_exceeded"; readonly detail: string }
  | { readonly kind: "launch_count_exceeded"; readonly detail: string }
  | { readonly kind: "ceiling_not_set"; readonly detail: string }
  | { readonly kind: "invalid"; readonly detail: string }
  /** No EVM wallet is selected for this session — there is nothing to price. */
  | { readonly kind: "no_wallet"; readonly detail: string }
  /** The named image is not in the locker, or the locker could not be read. */
  | { readonly kind: "image_not_found"; readonly detail: string }
  | { readonly kind: "image_unavailable"; readonly detail: string }
  /** The wallet cannot cover the value + gas this launch would need. */
  | { readonly kind: "insufficient_funds"; readonly detail: string }
  /**
   * The signing leg refused and NOTHING WAS SIGNED — authorization drift, a lost
   * double-submit race, a locked vault. `detail` is the executor's own prose,
   * carried verbatim: it knows precisely what it refused and why, and
   * paraphrasing a money refusal teaches the user the wrong thing.
   */
  | { readonly kind: "launch_refused"; readonly detail: string }
  /**
   * The chain could not price the launch — fee unreadable, gas unestimable,
   * balance unreadable, or the value gate could not attribute every wei. Each of
   * those is a REFUSAL to quote, never a zero substituted for a measurement.
   */
  | { readonly kind: "unpriceable"; readonly detail: string };

/**
 * The fee planner, injected the same way the agent handler takes it.
 *
 * Defaults to "no fee leg" rather than inventing one: a fabricated fee on a
 * signing path is precisely the unprovable number rule 90 forbids.
 */
export const NO_FEE_LEG: PlanTrenchFeeLeg = () => null;

/** Map a plan refusal code onto the main-side refusal vocabulary. */
export function refusalFromPlanCode(
  code: LaunchPlanRefusalCode | string,
  detail: string,
): TokenLaunchRefusal {
  switch (code) {
    case "ceiling_not_set":
      return { kind: "ceiling_not_set", detail };
    case "value_ceiling_exceeded":
      return { kind: "value_ceiling_exceeded", detail };
    case "launch_count_exceeded":
      return { kind: "launch_count_exceeded", detail };
    case "image_not_found":
      return { kind: "image_not_found", detail };
    case "image_store_unavailable":
      return { kind: "image_unavailable", detail };
    case "insufficient_native_balance":
      return { kind: "insufficient_funds", detail };
    // A launch nobody can price is not an invalid REQUEST — the form may be
    // perfect. Collapsing these into `invalid` would tell the user to fix a
    // field, which is advice that cannot work.
    case "fee_unreadable":
    case "gas_unestimable":
    case "balance_unreadable":
    case "native_value_unauthorized":
      return { kind: "unpriceable", detail };
    default:
      return { kind: "invalid", detail };
  }
}


/** Everything `buildLaunchPlan` needs that must be resolved from session state. */
export interface LaunchPlanContext {
  readonly ok: true;
  readonly request: ValidatedLaunchRequest;
  readonly walletAddress: string;
  readonly permission: Permission;
  /**
   * Typed FROM the consumer, not from a local `viem` import: this package and
   * the root each resolve their own copy of viem, and re-declaring the client
   * type here makes the two structurally incompatible for no benefit.
   */
  readonly publicClient: BuildLaunchPlanInput["publicClient"];
  readonly planFeeLeg: PlanTrenchFeeLeg;
  readonly nativeAddress: typeof NATIVE_ADDRESS;
}

export type LaunchPlanContextOutcome =
  | LaunchPlanContext
  | { readonly ok: false; readonly refusal: TokenLaunchRefusal };

/**
 * Resolve the session's launch context, or say why it cannot be resolved.
 *
 * The fee planner is ALWAYS the real one. A preview wired to "no fee leg" would
 * show a Vex fee of zero for a launch that will be charged 25 bps — a consent
 * modal disclosing a number the execute path contradicts.
 */
export async function planLaunchContext(
  sessionId: string,
  form: TokenLaunchForm,
): Promise<LaunchPlanContextOutcome> {
  const validated = validateLaunchRequest({ ...form });
  if (!validated.ok) return { ok: false, refusal: { kind: "invalid", detail: validated.reason } };

  const scope = await getSessionWalletScope(sessionId);
  if (!scope.ok) {
    return {
      ok: false,
      refusal: {
        kind: "unpriceable",
        detail:
          "Vex could not read this session's wallet selection, so the launch cannot be priced. "
          + "Check that Vex services are running and try again.",
      },
    };
  }
  const evm = scope.data.evm;
  if (evm === null) {
    return {
      ok: false,
      refusal: {
        kind: "no_wallet",
        detail:
          "No EVM wallet is selected for this session, so there is no account to launch from. "
          + "Pick one in the session's wallet card, then preview the launch again.",
      },
    };
  }

  const session = await getSessionById(sessionId);
  if (!session.ok || session.data === null) {
    return {
      ok: false,
      refusal: {
        kind: "invalid",
        detail: "That session no longer exists, so the launch cannot be priced.",
      },
    };
  }

  const chainConfig = getLocalChain(TRENCH_CHAIN_ID);
  if (!chainConfig) {
    return {
      ok: false,
      refusal: {
        kind: "unpriceable",
        detail:
          `Robinhood Chain (${TRENCH_CHAIN_ID}) is not in the local chain registry, so the launch `
          + "cannot be priced on-chain. Nothing was signed.",
      },
    };
  }

  return {
    ok: true,
    request: validated.value,
    walletAddress: evm.address,
    permission: session.data.permission,
    publicClient: getLocalPublicClient(chainConfig),
    planFeeLeg: planTrenchLaunchFeeLeg,
    nativeAddress: NATIVE_ADDRESS,
  };
}
