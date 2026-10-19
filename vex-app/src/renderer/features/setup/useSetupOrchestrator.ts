/**
 * SETUP ORCHESTRATOR — the launch pipeline behind the Chronos Gate plate.
 *
 * Runs ONCE per process while the Chronos Gate covers the window and
 * decides where the launch lands, replacing the click-through chain
 * (intro → systemCheck → runtime → migrations) for the returning user. The
 * pipeline is a re-sequencing of the EXACT same IPC contracts those screens
 * own today — no new main-process behavior:
 *
 *   1. Parallel probes: system.health / system.runtime / onboarding.envState.
 *   2. FIRST RUN (`setupCompleteFlag === false`): hand off to the classic
 *      systemCheck screen after the probes — the gate never drives setup on
 *      a machine that has not completed it.
 *   3. RETURNING USER: macOS translocation → systemCheck (its banner owns
 *      the warning). Otherwise the gate waits for the bundled native
 *      runtime, which main started at boot: ready → migrate → the shared
 *      wizard-entry table (features/wizard/wizard-entry.ts) → appShell /
 *      unlock / wizard. A failed start, or a model download or re-hash long
 *      enough to deserve its progress, hands off to runtimeBootstrap (which
 *      advances to migrations once ready). First, though: while this
 *      install's data must still be moved from the previous release, main
 *      has NOT started the runtime, and the gate hands off to
 *      runtimeMigration (which hands off to runtimeBootstrap). Any non-happy
 *      outcome hands off to the classic screen that owns that remediation —
 *      never a dead end.
 *   4. E2E DOOR RUN (`system.runtime` answers `native: false`, which only
 *      an unpackaged end-to-end run whose test door already published the
 *      database does): main starts no runtime, so there is nothing to wait
 *      for, and the gate goes straight to migrate.
 *
 * Contract notes carried over from the screens this fast path bypasses:
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
import type { NativeRuntimeStatus } from "@shared/schemas/system.js";
import { onboardingKeys, systemKeys } from "../../lib/api/queryKeys.js";
import { needsRuntimeScreen } from "../runtime/bootstrap/steps.js";
import { resolveWizardEntry } from "../wizard/wizard-entry.js";
import type { UnlockReturnView, View } from "../../stores/uiStore.js";

/** Where the gate lands after the pipeline resolves. */
export type SetupHandoff =
  | {
      readonly kind: "view";
      readonly view: Extract<
        View,
        | "systemCheck"
        | "runtimeMigration"
        | "runtimeBootstrap"
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

/**
 * Wait for main's start of the native runtime: true once it is ready, false
 * as soon as the runtime screen should take over. Subscribes BEFORE reading
 * the status and ignores anything older than what it has seen.
 */
function nativeRuntimeReady(): Promise<boolean> {
  return new Promise((resolve) => {
    let seen = -1;
    let settled = false;
    const settle = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      off();
      resolve(ready);
    };
    const decide = (status: NativeRuntimeStatus): void => {
      if (status.seq < seen) return;
      seen = status.seq;
      if (status.phase === "ready") settle(true);
      else if (needsRuntimeScreen(status)) settle(false);
    };
    const off = window.vex.system.onRuntimeProgress(decide);
    void window.vex.system.runtimeStatus().then((result) => {
      if (result.ok) decide(result.data);
      else settle(false);
    });
  });
}

export function useSetupOrchestrator(): SetupOrchestrator {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SetupStatusLine>(() =>
    statusLine("probing"),
  );
  const [handoff, setHandoff] = useState<SetupHandoff | null>(null);
  // Guards same-instance effect re-runs. StrictMode's dev remount creates
  // a NEW instance whose pipeline runs again — the same double-invoke the
  // classic runtime/migrations screens have today, and safe for the same
  // reasons: the gate only watches main's single-flight runtime start, and
  // the migration runner serializes on a Postgres advisory lock. The unmounted first
  // instance's setState calls are no-ops, so only the live instance
  // drives the gate.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const run = async (): Promise<void> => {
      // ---- 1. Parallel probes ---------------------------------------
      const [health, runtime, env] = await Promise.all([
        window.vex.system.health(),
        window.vex.system.runtime(),
        window.vex.onboarding.getEnvState(),
      ]);
      // Only an explicit `native: false` is a door run. An unreadable answer
      // takes the native path, whose own failures hand off to its screens.
      const doorRun = runtime.ok && !runtime.data.native;
      // Seed the caches the classic screens read (parity with today's
      // cross-screen reuse; each option's own staleTime applies).
      queryClient.setQueryData(systemKeys.health(), health);
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
      // ---- 2. The native runtime -----------------------------------
      // Main started it at boot and the migrate call below joins that start.
      // A door run's database is already published: there is nothing to
      // start or wait for, so it goes straight to migrate.
      if (!doorRun) {
        setStatus(statusLine("services"));
        // Main starts nothing while data must be moved: waiting for the
        // runtime would wait forever. Any answer but not_needed (an IPC
        // failure included) is the migration screen's to explain.
        const migration = await window.vex.system.runtimeMigrationStatus();
        if (!migration.ok || migration.data.kind !== "not_needed") {
          setHandoff({ kind: "view", view: "runtimeMigration" });
          return;
        }
        if (!(await nativeRuntimeReady())) {
          setHandoff({ kind: "view", view: "runtimeBootstrap" });
          return;
        }
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
