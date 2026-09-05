/**
 * The production wiring for the Virtuals keeper sweep.
 *
 * Separate from the sweep for the reason every sibling here is: the sweep's own
 * logic is testable without a node, and this file is the only place that knows
 * about RPC clients. It contains no policy - it translates one chain read into
 * the sweep's three-answer vocabulary and nothing else.
 *
 * An RPC failure becomes `unknown`, never `none`. That distinction is the whole
 * reason the vocabulary has four members: `none` says the chain answered and
 * the keeper has not acted, which is a fact about the launch; `unknown` says
 * Vex could not ask, which is a fact about the network. Collapsing them would
 * let a bad hour of RPC look identical to a stalled keeper.
 */

import { getAddress, isAddress } from "viem";

import {
  getVirtualsCurvePublicClient,
  virtualsCurveDeployment,
} from "@tools/virtuals/curve/index.js";
import { keeperLogReaderFrom, readKeeperOutcome } from "@tools/virtuals/launch/index.js";

import type { KeeperSweepObservation, VirtualsKeeperSweepDeps } from "./virtuals-keeper-launch.js";

export function buildProductionVirtualsKeeperSweepDeps(): VirtualsKeeperSweepDeps {
  return {
    observe: async ({ chainKey, token, fromBlock }): Promise<KeeperSweepObservation> => {
      const deployment = virtualsCurveDeployment(chainKey);
      if (deployment === undefined) {
        return { kind: "unknown", detail: `no Virtuals contract table for chain "${chainKey}"` };
      }
      if (!isAddress(token)) {
        return { kind: "unknown", detail: "the recorded token is not an address" };
      }
      try {
        const outcome = await readKeeperOutcome({
          client: keeperLogReaderFrom(getVirtualsCurvePublicClient(deployment)),
          deployment,
          token: getAddress(token),
          fromBlock,
        });
        if (outcome.kind === "observed") return { kind: "launched", keeperTxHash: outcome.txHash };
        if (outcome.kind === "cancelled") return { kind: "cancelled", txHash: outcome.txHash };
        return { kind: "none" };
      } catch (err) {
        // The error's own text never leaves this function: the sweep stores a
        // class, and provider payloads carry URLs and request bodies.
        return { kind: "unknown", detail: err instanceof Error ? err.name : "unknown" };
      }
    },
  };
}
