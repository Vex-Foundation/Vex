/**
 * The runtime host: drives one `LocalRuntimeProvider` and is the ONLY
 * production writer of the database connection (`setDbConnection`). The e2e
 * door is the one other writer, and it is inert in a packaged build.
 *
 * Two rules it owns, whichever provider runs the services:
 *
 *   - Publication. A start that settles `running` / `reused` publishes its
 *     endpoints; any other outcome publishes nothing, so no consumer is ever
 *     handed a connection to a degraded runtime. Only a CONFIRMED stop clears
 *     the connection: a failed stop may have left the services up with the
 *     same credentials, and the connection must keep pointing at them.
 *
 *   - Single flight. A start that arrives while an identical one is running
 *     JOINS it instead of starting a second one (React StrictMode and HMR
 *     double-fire the renderer's start). A joined caller's abort detaches only
 *     that caller - it returns AbortError while the shared start continues for
 *     everyone else. Only the initiator's signal reaches the provider, so only
 *     the initiator can cancel the shared work, and then every waiter sees the
 *     AbortError.
 */

import { setDbConnection } from "../database/connection-state.js";
import { raceWithAbort } from "../ipc/cancel-helpers.js";
import {
  isUsableStart,
  type LocalRuntimeProvider,
  type RuntimeStartOptions,
  type RuntimeStartOutcome,
  type RuntimeStopOutcome,
} from "./provider.js";

export interface HostedStart<Detail> {
  readonly outcome: RuntimeStartOutcome<Detail>;
  /** True when this caller joined a start another caller initiated. */
  readonly joined: boolean;
}

export interface RuntimeHost<Input, StartDetail, StopDetail> {
  readonly provider: LocalRuntimeProvider<Input, StartDetail, StopDetail>;
  /**
   * Start, or join the identical start already in flight. `key` identifies
   * "identical": two starts with different keys do not share work.
   */
  start(input: Input, key: string, options: RuntimeStartOptions): Promise<HostedStart<StartDetail>>;
  stop(): Promise<RuntimeStopOutcome<StopDetail>>;
}

export function createRuntimeHost<Input, StartDetail, StopDetail>(
  provider: LocalRuntimeProvider<Input, StartDetail, StopDetail>,
): RuntimeHost<Input, StartDetail, StopDetail> {
  let inFlight: { readonly key: string; readonly run: Promise<RuntimeStartOutcome<StartDetail>> } | null = null;

  return {
    provider,

    async start(input, key, options) {
      const current = inFlight;
      if (current !== null && current.key === key) {
        return { outcome: await raceWithAbort(current.run, options.signal), joined: true };
      }

      const run = provider.start(input, options).then((outcome) => {
        if (isUsableStart(outcome.kind) && outcome.endpoints !== null) {
          setDbConnection(outcome.endpoints.db);
        }
        return outcome;
      });
      const entry = { key, run };
      inFlight = entry;
      try {
        return { outcome: await run, joined: false };
      } finally {
        if (inFlight === entry) inFlight = null;
      }
    },

    async stop() {
      const outcome = await provider.stop();
      if (outcome.kind === "stopped") setDbConnection(null);
      return outcome;
    },
  };
}
