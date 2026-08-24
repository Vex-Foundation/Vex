/**
 * SETUP ORCHESTRATOR — the launch pipeline behind the Chronos Gate plate.
 *
 * Runs ONCE per process while the cobalt cold-open covers the window and
 * decides where the launch lands, replacing the old click-through chain
 * (intro → systemCheck → docker → compose → migrations) for the returning
 * user. The pipeline is a re-sequencing of the EXACT same IPC contracts
 * those screens own today — no new main-process behavior:
 *
 *   1. Parallel probes: system.health / docker.detect / onboarding.envState.
 *   2. FIRST RUN (`setupCompleteFlag === false`): hand off to the classic
 *      systemCheck screen after the probes — the gate never auto-starts
 *      compose on a machine that has not completed setup (this also keeps
 *      the e2e boot smoke deterministic on CI runners that have Docker).
 *   3. RETURNING USER: macOS translocation → systemCheck (its banner owns
 *      the warning); Docker endpoint/engine/daemon not ready →
 *      dockerBootstrap (full remediation branch tree lives there).
 *      Otherwise compose up → migrate → the shared wizard-entry table
 *      (features/wizard/wizard-entry.ts) → appShell / unlock / wizard.
 *      Any non-happy outcome hands off to the classic screen that owns
 *      that remediation — never a dead end.
 *
 * Contract notes carried over from the screens this fast path bypasses:
 *  - compose: `composeUpAbortable` is NEVER cancelled from effect cleanup
 *    (StrictMode double-mount would race the main-process single-flight
 *    join — same rule as ComposeBootstrap). The gate offers no cancel;
 *    remediation screens do.
 *  - migrate: subscribe to `database.onProgress` BEFORE invoking migrate
 *    (the push bus replays the latest event to late subscribers); there is
 *    deliberately NO cancel path (mid-SQL aborts are unsafe). On success
 *    the envState query is invalidated — migrate seeds embedding env
 *    defaults the wizard reads fresh.
 *  - probe results are seeded into the TanStack cache so a handoff screen
 *    paints from the same data it would have fetched itself (staleTime
 *    semantics identical to today's cross-screen cache reuse).
 */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { MigrateProgress } from "@shared/schemas/database.js";
import {
  dockerKeys,
  onboardingKeys,
  systemKeys,
} from "../../lib/api/queryKeys.js";
import { resolveWizardEntry } from "../wizard/wizard-entry.js";
import type { UnlockReturnView, View } from "../../stores/uiStore.js";

/** Where the gate lands after the pipeline resolves. */
export type SetupHandoff =
  | {
      readonly kind: "view";
      readonly view: Extract<
        View,
        | "systemCheck"
        | "dockerBootstrap"
        | "composeBootstrap"
        | "migrations"
        | "wizard"
        | "appShell"
      >;
    }
  | { readonly kind: "unlock"; readonly returnView: UnlockReturnView };

/** Gate status line — honest, bound to the real pipeline stage. */
export interface SetupStatusLine {
  readonly key: "probing" | "services" | "schema" | "ledger" | "ready";
  readonly label: string;
}

const STATUS: Record<SetupStatusLine["key"], string> = {
  probing: "Waking the desk",
  services: "Starting services",
  schema: "Preparing the ledger",
  ledger: "Reading your setup",
  ready: "Ready",
};

function statusLine(
  key: SetupStatusLine["key"],
  detail?: string,
): SetupStatusLine {
  return {
    key,
    label: detail === undefined ? STATUS[key] : `${STATUS[key]} · ${detail}`,
  };
}

export interface SetupOrchestrator {
  readonly status: SetupStatusLine;
  readonly handoff: SetupHandoff | null;
}

export function useSetupOrchestrator(): SetupOrchestrator {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SetupStatusLine>(() =>
    statusLine("probing"),
  );
  const [handoff, setHandoff] = useState<SetupHandoff | null>(null);
  // Guards same-instance effect re-runs. StrictMode's dev remount creates
  // a NEW instance whose pipeline runs again — the same double-invoke the
  // classic compose/migrations screens have today, and safe for the same
  // reasons: compose up single-flight-joins in main, and the migration
  // runner serializes on a Postgres advisory lock. The unmounted first
  // instance's setState calls are no-ops, so only the live instance
  // drives the gate.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const run = async (): Promise<void> => {
      // ---- 1. Parallel probes ---------------------------------------
      const [health, docker, env] = await Promise.all([
        window.vex.system.health(),
        window.vex.docker.detect(),
        window.vex.onboarding.getEnvState(),
      ]);
      // Seed the caches the classic screens read (parity with today's
      // cross-screen reuse; each option's own staleTime applies).
      queryClient.setQueryData(systemKeys.health(), health);
      queryClient.setQueryData(dockerKeys.status(), docker);
      queryClient.setQueryData(onboardingKeys.envState(), env);

      const setupComplete = env.ok && env.data.setupCompleteFlag;
      if (!setupComplete) {
        // First run (or unreadable env state): the classic guided chain
        // owns the narrative until the single-page setup lands (PR2).
        setHandoff({ kind: "view", view: "systemCheck" });
        return;
      }
      if (!health.ok || health.data.translocated) {
        // Translocation (macOS quarantine) must stay loud — the
        // systemCheck banner owns that warning.
        setHandoff({ kind: "view", view: "systemCheck" });
        return;
      }
      const dockerReady =
        docker.ok &&
        docker.data.endpoint.accepted &&
        docker.data.engine.present &&
        docker.data.daemon.running;
      if (!dockerReady) {
        setHandoff({ kind: "view", view: "dockerBootstrap" });
        return;
      }

      // ---- 2. Compose up (returning user only) ----------------------
      setStatus(statusLine("services"));
      // Deliberately NOT cancelled on unmount — see the header contract.
      const composeInvocation = window.vex.docker.composeUpAbortable({});
      let compose: Awaited<typeof composeInvocation.promise>;
      try {
        compose = await composeInvocation.promise;
      } catch {
        setHandoff({ kind: "view", view: "composeBootstrap" });
        return;
      }
      if (!compose.ok || (compose.data.kind !== "running" && compose.data.kind !== "reused")) {
        // port_collision / unhealthy / failed / IPC error — the classic
        // compose screen owns every remediation branch (incl. the
        // "previous Vex install holds the ports" special case).
        setHandoff({ kind: "view", view: "composeBootstrap" });
        return;
      }

      // ---- 3. Migrations -------------------------------------------
      setStatus(statusLine("schema"));
      let appliedCount = 0;
      // Subscribe BEFORE invoking — the bus replays its latest event.
      const unsubscribe = window.vex.database.onProgress(
        (progress: MigrateProgress) => {
          if (progress.phase === "applied") {
            appliedCount += 1;
            setStatus(statusLine("schema", `${appliedCount} applied`));
          }
        },
      );
      let migrate: Awaited<ReturnType<typeof window.vex.database.migrate>>;
      try {
        migrate = await window.vex.database.migrate();
      } catch {
        unsubscribe();
        setHandoff({ kind: "view", view: "migrations" });
        return;
      }
      unsubscribe();
      if (!migrate.ok) {
        setHandoff({ kind: "view", view: "migrations" });
        return;
      }
      // Migrate seeds embedding env defaults — refresh the env state the
      // wizard reads (same invalidation the Migrations screen performs).
      void queryClient.invalidateQueries({
        queryKey: onboardingKeys.envState(),
      });

      // ---- 4. Wizard-entry decision --------------------------------
      setStatus(statusLine("ledger"));
      const [wizardState, secrets] = await Promise.all([
        window.vex.onboarding.getWizardState(),
        window.vex.secrets.status(),
      ]);
      if (!wizardState.ok) {
        // WizardShell owns the retryable "setup unavailable" panel.
        setHandoff({ kind: "view", view: "wizard" });
        return;
      }
      queryClient.setQueryData(onboardingKeys.wizardState(), wizardState);
      const decision = resolveWizardEntry({
        persisted: wizardState.data,
        vaultConfigured: secrets.ok ? secrets.data.vaultConfigured : false,
        unlocked: secrets.ok ? secrets.data.unlocked : false,
        entryMode: "setup",
      });
      setStatus(statusLine("ready"));
      if (decision.kind === "unlock") {
        setHandoff({ kind: "unlock", returnView: decision.returnView });
        return;
      }
      if (decision.kind === "appShell") {
        setHandoff({ kind: "view", view: "appShell" });
        return;
      }
      // A step decision means the wizard should mount and resolve the
      // same table itself (deterministic — same inputs, same row).
      setHandoff({ kind: "view", view: "wizard" });
    };

    void run();
  }, [queryClient]);

  return { status, handoff };
}
