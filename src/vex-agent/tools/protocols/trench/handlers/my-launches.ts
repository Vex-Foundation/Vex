/**
 * `trench.my_launches` handler — the user's OWN Trench Express token launches,
 * read from the durable `launched_tokens` index (migration `062_trench_launch`).
 *
 * READ-ONLY and local: this reads Vex's own database, not the launchpad API. The
 * index is written when a launch confirms and reconciled by
 * `sync/launch-identity-repair.ts`, so a launch that settled on-chain appears
 * here even if the process died before the handler could finish.
 *
 * A DB-backed protocol read tool is established practice — the KyberSwap and
 * Relay execute handlers already call `tracked-tokens.ts` the same way. It lives
 * in the `trench` namespace rather than as an internal tool so a model exploring
 * "what can I do on Trench" through `discover_tools` finds it beside the other
 * launchpad capabilities.
 *
 * The wallet is SERVER-RESOLVED from the session's selection, never taken from
 * a parameter. A read tool that let the model name the wallet would let it read
 * another wallet's launch history; there is deliberately no `wallet` param to
 * pass, and no way to widen the scope from model input.
 */

import { formatUnits } from "viem";

import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import * as launchedTokens from "@vex-agent/db/repos/launched-tokens.js";
import type { LaunchedToken } from "@vex-agent/db/repos/launched-tokens.js";
import { resolveSelectedAddressForRead } from "../../../internal/wallet/resolve.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import { readNumber } from "../../runtime/list-params.js";
import type { NumericParamSpecs } from "../../runtime/list-params.js";

const MY_LAUNCHES_NUMERIC_PARAMS: NumericParamSpecs = {
  limit: { domain: "nonNegative", integer: true, min: 1, max: 100 },
};

const DEFAULT_LIMIT = 25;

interface LaunchRow {
  token: string;
  name: string;
  symbol: string;
  createTx: string;
  launchedAt: string;
  /**
   * The prebuy, rendered from `initial_buy_raw` at its OWN recorded decimals —
   * never at an assumed 18. `null` when no prebuy was recorded, which is NOT the
   * same as a prebuy of zero and is reported as such.
   */
  prebuy: { amount: string; raw: string; decimals: number; token: string | null } | null;
}

/**
 * Render one raw amount at its recorded decimals, or decline.
 *
 * The decimals are read from the ROW, never assumed: "1047061" is 1.05 at 6
 * decimals and 0.00105 at 9, and guessing is the thousandfold error rule 90
 * exists to prevent. The DB CHECK guarantees raw and decimals travel together,
 * so a missing pair means "no prebuy recorded" rather than "prebuy of unknown
 * size" — but this still checks both instead of trusting the constraint.
 */
function projectPrebuy(row: LaunchedToken): LaunchRow["prebuy"] {
  const { initialBuyRaw, initialBuyDecimals } = row;
  if (initialBuyRaw === null || initialBuyDecimals === null) return null;
  return {
    amount: formatUnits(BigInt(initialBuyRaw), initialBuyDecimals),
    raw: initialBuyRaw,
    decimals: initialBuyDecimals,
    token: row.initialBuyTokenAddress,
  };
}

function projectLaunch(row: LaunchedToken): LaunchRow {
  return {
    token: row.tokenAddress,
    name: row.name,
    symbol: row.symbol,
    createTx: row.createTxHash,
    launchedAt: row.createdAt,
    prebuy: projectPrebuy(row),
  };
}

export async function trenchMyLaunchesHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const limitRead = readNumber(p, "limit", MY_LAUNCHES_NUMERIC_PARAMS);
  if (!limitRead.ok) return fail(limitRead.reason);

  let walletAddress: string;
  try {
    walletAddress = resolveSelectedAddressForRead(
      context.walletResolution,
      context.walletPolicy,
      "eip155",
    );
  } catch (err) {
    return fail(`trench.my_launches: ${err instanceof Error ? err.message : String(err)}`);
  }

  const rows = await launchedTokens.listForWallets({
    walletAddresses: [walletAddress],
    chainId: TRENCH_CHAIN_ID,
    limit: limitRead.value ?? DEFAULT_LIMIT,
  });

  return ok({
    wallet: walletAddress,
    chainId: TRENCH_CHAIN_ID,
    count: rows.length,
    // Said explicitly so an empty list is never read as "the launchpad is down".
    // This is Vex's own record of launches VEX performed; a token the user
    // created elsewhere has no row here and its absence means nothing.
    source: "Vex's local launch index — launches made through this app",
    launches: rows.map(projectLaunch),
  });
}
