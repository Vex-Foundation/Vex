/**
 * The signing contract for Lighter's TxType 20: the per-market initial margin
 * fraction and margin mode of one account.
 *
 * This module owns the SHAPE and the BOUNDS of a leverage change on the way to
 * the signer helper. It owns no policy above that: which market a user may
 * touch, whether the target clears the market's own minimum, and whether the
 * human consented are decided by the privileged main-process executor, which
 * re-reads live state immediately before calling into here.
 *
 * The unit is the canonical 10000-scale integer of `margin-fraction.ts`. No
 * leverage number reaches this module.
 */

import { ErrorCodes, VexError } from "../../errors.js";
import type { LighterEnvironment } from "./constants.js";
import {
  LIGHTER_MARGIN_FRACTION_TICK,
  LIGHTER_MARGIN_MODE_WIRE,
} from "./margin-fraction.js";
import {
  lifecycleScope,
  type LighterOrderLifecycleSigningScope,
} from "./signer-order-lifecycle.js";
import type { LighterTradingSecretMaterial } from "./trading-secret.js";

export const LIGHTER_TX_TYPE_UPDATE_LEVERAGE = 20 as const;

/**
 * Leverage is a perpetual concept. Lighter's spot range (2048..4094) has no
 * initial margin fraction, and 255 is the provider's own "no market" marker, so
 * the accepted range stops one short of it - the same bound
 * `txtypes.MaxPerpsMarketIndex` states and the Go helper enforces.
 */
const MIN_PERPS_MARKET_INDEX = 0;
const MAX_PERPS_MARKET_INDEX = 254;

export interface LighterUpdateLeverageSigningInput extends LighterOrderLifecycleSigningScope {
  readonly kind: "lighter_update_leverage_signing_input";
  readonly marketIndex: number;
  /** Canonical 10000-scale integer; 1 through 10000 inclusive. */
  readonly initialMarginFraction: number;
  readonly marginMode: 0 | 1;
}

export interface LighterUpdateLeverageSignerResult {
  readonly kind: "lighter_update_leverage_signer_result";
  readonly operation: "update_leverage";
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly txType: 20;
  readonly txInfo: string;
  readonly txHash: string;
}

export interface LighterLeverageSignerAdapter {
  readonly source: "official_lighter_signer";
  readonly signUpdateLeverage: (
    input: LighterUpdateLeverageSigningInput,
  ) => Promise<LighterUpdateLeverageSignerResult>;
}

export function buildLighterUpdateLeverageSigningInput(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly marketIndex: number;
  readonly initialMarginFraction: number;
  readonly marginMode: 0 | 1;
  readonly secret: LighterTradingSecretMaterial;
}): LighterUpdateLeverageSigningInput {
  const scope = lifecycleScope(input);
  if (
    !Number.isInteger(input.marketIndex)
    || input.marketIndex < MIN_PERPS_MARKET_INDEX
    || input.marketIndex > MAX_PERPS_MARKET_INDEX
  ) {
    throw invalid("marketIndex must be a Lighter perpetual market from 0 through 254.");
  }
  if (
    !Number.isInteger(input.initialMarginFraction)
    || input.initialMarginFraction < 1
    || input.initialMarginFraction > LIGHTER_MARGIN_FRACTION_TICK
  ) {
    throw invalid(
      `initialMarginFraction must be a whole number from 1 through ${LIGHTER_MARGIN_FRACTION_TICK}.`,
    );
  }
  if (
    input.marginMode !== LIGHTER_MARGIN_MODE_WIRE.cross
    && input.marginMode !== LIGHTER_MARGIN_MODE_WIRE.isolated
  ) {
    throw invalid("marginMode must be Lighter's cross or isolated wire code.");
  }
  return {
    kind: "lighter_update_leverage_signing_input",
    ...scope,
    marketIndex: input.marketIndex,
    initialMarginFraction: input.initialMarginFraction,
    marginMode: input.marginMode,
  };
}

function invalid(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Re-read the Lighter market and account state and prepare the leverage change again.",
  );
}
