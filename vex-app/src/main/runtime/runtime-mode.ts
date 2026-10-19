/**
 * Who serves this process's local services (Postgres + pgvector, the
 * embeddings server).
 *
 * The bundled native runtime is the only runtime Vex runs (plan D11): every
 * launch, development and packaged alike, starts it through the migration
 * gate. The one exception is an end-to-end run whose door already published a
 * database (`database/e2e-connection-door.ts`, inert in a packaged build): that
 * database is the run's own, so the native runtime is never started and never
 * displaces it. Everything that would act on the bundled runtime - its start,
 * stop, restart, reset, data move and live embeddings endpoint - asks this
 * module first and stands aside for a door run.
 */

export type RuntimeMode = "native" | "e2e_door";

export function resolveRuntimeMode(input: { readonly connectionAlreadyPublished: boolean }): RuntimeMode {
  return input.connectionAlreadyPublished ? "e2e_door" : "native";
}

let mode: RuntimeMode = "native";

/** Decided once at boot (index.ts), after the e2e door. */
export function setRuntimeMode(value: RuntimeMode): void {
  mode = value;
}

export function getRuntimeMode(): RuntimeMode {
  return mode;
}
