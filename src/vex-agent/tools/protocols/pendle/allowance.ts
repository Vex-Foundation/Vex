/** Durable-nonce adapter for Pendle's legacy approval helper. */

import {
  ensurePendleAllowanceExact as ensurePendleAllowanceExactBase,
  type CreatePendleAllowanceStaging,
} from "@tools/pendle/erc20.js";
import {
  markLegacyEvmNonceAccepted,
  reserveLegacyEvmNonce,
  stageLegacyEvmNonce,
  terminalizeLegacyEvmNonce,
  type LegacyEvmNonceReservation,
} from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";

const createStaging: CreatePendleAllowanceStaging = () => {
  let reservation: LegacyEvmNonceReservation | null = null;
  return {
    hooks: {
      onNonceReserved: async (request) => {
        if (reservation !== null) {
          throw new Error("pendle allowance nonce reservation was requested twice");
        }
        reservation = await reserveLegacyEvmNonce(request, "pendle_allowance");
        return reservation.nonce;
      },
      onHashStaged: async (handles) => {
        if (reservation === null) {
          throw new Error("pendle allowance hash reached staging without a nonce reservation");
        }
        await stageLegacyEvmNonce(reservation.id, handles);
      },
      onAccepted: async () => {
        if (reservation === null) {
          throw new Error("pendle allowance submit was accepted without a nonce reservation");
        }
        await markLegacyEvmNonceAccepted(reservation.id);
      },
    },
    terminalize: async () => {
      if (reservation === null) {
        throw new Error("pendle allowance became terminal without a nonce reservation");
      }
      try {
        await terminalizeLegacyEvmNonce(reservation.id);
      } catch (cause) {
        logger.warn("pendle.allowance.nonce_terminal_write_failed", {
          reservationId: reservation.id,
          errorKind: cause instanceof Error ? cause.name : "UnknownError",
        });
      }
    },
  };
};

export async function ensurePendleAllowanceExact(
  ...args: Parameters<typeof ensurePendleAllowanceExactBase>
): ReturnType<typeof ensurePendleAllowanceExactBase> {
  const [publicClient, walletClient, token, spender, requiredAmount] = args;
  return ensurePendleAllowanceExactBase(
    publicClient,
    walletClient,
    token,
    spender,
    requiredAmount,
    createStaging,
  );
}
