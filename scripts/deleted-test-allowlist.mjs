/**
 * Reviewed test deletions.
 *
 * `check-test-unsafe-escapes.mjs` prohibits deleting a test file, because the
 * cheapest way to turn a suite green is to delete what fails. That gate has one
 * legitimate exception: a test whose SUBJECT was deliberately removed by the
 * same change. Such a test cannot be kept - there is no code left to exercise -
 * and silently dropping it is exactly what the gate exists to prevent. So each
 * one is named here with the contract change that removed its subject, and with
 * where the surviving behavior is covered instead.
 *
 * Same discipline as the manifest-lint allowlists: entries are added ONLY with
 * the change that deletes the subject, an entry whose file is no longer deleted
 * fails as stale, and the table may not be used to park a test that still has a
 * subject. Removing dead entries is expected maintenance, not a favor.
 *
 * The table is EMPTY between contract changes, and that is its resting state:
 * every entry is consumed the moment the change carrying it merges, because
 * the deletion stops being a deletion against the new base. A row that
 * outlives its merge is stale by construction and the gate says so.
 */

/**
 * The migration-108 Trench Express retirement carried 63 reviewed deletions
 * here; they merged with PR #165 (`7890245fa`) and were consumed by that
 * merge. The Lighter shell migration entries were also consumed after their
 * deleted test files landed on the base branch.
 * The 12 retired feed/ws fixture entries were consumed when the replacement
 * envelope protocol landed in main through PR #205 (`1dc37f68f`).
 * The four V10 Spread entries (the outline glyphs, the state dot, the sidebar
 * collapse choreography and the rail glass tier) were consumed when PR #212
 * merged. The 28 R3 Minimal entries were consumed when PR #215 merged.
 */
export const DELETED_TEST_ALLOWLIST = [
  {
    path: "vex-app/src/main/compose/__tests__/embeddings-health.test.ts",
    reason: "compose/embeddings-health.ts polled the Docker Compose embeddings container and was deleted with the Compose provider (native runtime, phase 4a); the bundled llama-server's readiness (/health, then one real /v1/embeddings call checking the alias, the 768 dimensions and the key) lives in runtime/native/llama-supervisor.ts; also covered by native-runtime.real.test.ts.",
    coveredBy: "vex-app/src/main/runtime/__tests__/llama-supervisor.test.ts",
  },
  {
    path: "vex-app/src/main/compose/__tests__/lifecycle-foreign-listener.test.ts",
    reason: "compose/lifecycle.ts (composeUp) was deleted with the Compose provider (native runtime, phase 4a); the guarantee it pinned, never using a database the app cannot prove is its own, is the native supervisor's identity check on its own 127.0.0.1 cluster.",
    coveredBy: "vex-app/src/main/runtime/__tests__/pg-identity.test.ts",
  },
  {
    path: "vex-app/src/main/compose/__tests__/lifecycle-orphan-collision.test.ts",
    reason: "compose/lifecycle.ts and compose/orphan-stacks.ts were deleted with the Compose provider (native runtime, phase 4a); the native cluster reuses its last port only while free and otherwise takes an OS-assigned one, so there is no published-port collision to resolve.",
    coveredBy: "vex-app/src/main/runtime/__tests__/free-port.test.ts",
  },
  {
    path: "vex-app/src/main/compose/__tests__/lifecycle-recreate.test.ts",
    reason: "compose/lifecycle.ts was deleted with the Compose provider (native runtime, phase 4a); the stale bind-mount pattern survives in compose/recreate.ts for the migration and keeps its own test (compose/__tests__/recreate.test.ts); native restarts are the supervisor's.",
    coveredBy: "vex-app/src/main/runtime/__tests__/postgres-supervisor.test.ts",
  },
  {
    path: "vex-app/src/main/compose/__tests__/lifecycle-surface.test.ts",
    reason: "The facade it pinned, compose/lifecycle.ts, was deleted with the Compose provider (native runtime, phase 4a); the provider surface the app now starts through is the native provider.",
    coveredBy: "vex-app/src/main/runtime/__tests__/native-provider.test.ts",
  },
  {
    path: "vex-app/src/main/compose/__tests__/lifecycle.test.ts",
    reason: "compose/lifecycle.ts was deleted with the Compose provider (native runtime, phase 4a); starting, reusing and stopping the runtime is the native runtime's.",
    coveredBy: "vex-app/src/main/runtime/__tests__/native-runtime.test.ts",
  },
  {
    path: "vex-app/src/main/compose/__tests__/orphan-stacks.test.ts",
    reason: "compose/orphan-stacks.ts found and stopped a previous install's containers holding the Compose ports; it was deleted with the Compose provider (native runtime, phase 4a); the one Docker stack still touched is the old one the migration reads from.",
    coveredBy: "vex-app/src/main/runtime/__tests__/docker-source.test.ts",
  },
  {
    path: "vex-app/src/main/docker/__tests__/engine-state.test.ts",
    reason: "docker/probe/daemon.ts (classifyEngineState) was deleted with the Docker probe (native runtime, phase 4a); the start window keeps its own test (docker/__tests__/engine-start-window.test.ts) and System Check now probes the local runtime.",
    coveredBy: "vex-app/src/main/runtime/__tests__/local-runtime-check.test.ts",
  },
  {
    path: "vex-app/src/main/docker/__tests__/installer-urls.test.ts",
    reason: "docker/installer-urls.ts was deleted: the app no longer installs Docker Desktop (native runtime, phase 4a); the runtime ships inside the package and the clean-machine gate proves first run with Docker removed.",
    coveredBy: "vex-app/src/main/runtime/__tests__/native-runtime-packaging.test.ts",
  },
  {
    path: "vex-app/src/main/docker/__tests__/probe-behavior.test.ts",
    reason: "docker/probe/{daemon,disk,ports}.ts were deleted with the Docker probe (native runtime, phase 4a); cli-env, endpoint-policy, engine-endpoint, engine-start-window and locate survive for the migration and keep their own tests; System Check now probes the local runtime.",
    coveredBy: "vex-app/src/main/runtime/__tests__/local-runtime-check.test.ts",
  },
  {
    path: "vex-app/src/main/docker/__tests__/probe-surface.test.ts",
    reason: "The facade it pinned, docker/probe.ts, was deleted with the Docker probe (native runtime, phase 4a); System Check now probes the local runtime.",
    coveredBy: "vex-app/src/main/runtime/__tests__/local-runtime-check.test.ts",
  },
  {
    path: "vex-app/src/main/ipc/__tests__/docker-compose-up.test.ts",
    reason: "ipc/docker.ts and its compose-up handler were deleted (native runtime, phase 4a); the native runtime starts in the main process on every launch, gated by the start gate, and the renderer reads it through the runtime status handler.",
    coveredBy: "vex-app/src/main/runtime/__tests__/native-start-gate.test.ts",
  },
  {
    path: "vex-app/src/main/ipc/__tests__/docker-stop-previous.test.ts",
    reason: "ipc/docker.ts and its stop-previous handler were deleted with compose/orphan-stacks.ts (native runtime, phase 4a); the previous release's data is reached only through the migration handler.",
    coveredBy: "vex-app/src/main/ipc/__tests__/system-runtime-migration.test.ts",
  },
  {
    path: "vex-app/src/renderer/features/compose/__tests__/ComposeBootstrap.test.tsx",
    reason: "ComposeBootstrap.tsx was deleted with the Compose provider (native runtime, phase 4a); first-run startup is RuntimeBootstrap on the plate layout.",
    coveredBy: "vex-app/src/renderer/features/runtime/__tests__/RuntimeBootstrap.test.tsx",
  },
  {
    path: "vex-app/src/renderer/features/compose/__tests__/parseComposeLog.test.ts",
    reason: "bootstrap/parseComposeLog.ts parsed docker compose output and was deleted with the Compose provider (native runtime, phase 4a); native progress arrives as typed steps.",
    coveredBy: "vex-app/src/renderer/features/runtime/__tests__/steps.test.ts",
  },
  {
    path: "vex-app/src/renderer/features/compose/__tests__/useAggregatedServiceState.test.ts",
    reason: "bootstrap/useAggregatedServiceState.ts folded per-container Compose states and was deleted with the Compose provider (native runtime, phase 4a); native progress arrives as typed steps.",
    coveredBy: "vex-app/src/renderer/features/runtime/__tests__/steps.test.ts",
  },
  {
    path: "vex-app/src/renderer/features/docker/__tests__/BootstrapPanel.test.tsx",
    reason: "BootstrapPanel.tsx (install or start Docker) was deleted (native runtime, phase 4a); first-run startup is RuntimeBootstrap on the plate layout.",
    coveredBy: "vex-app/src/renderer/features/runtime/__tests__/RuntimeBootstrap.test.tsx",
  },
  {
    path: "vex-app/src/renderer/features/docker/__tests__/InstallProgress.test.tsx",
    reason: "InstallProgress.tsx showed the Docker Desktop install and was deleted: the app no longer installs Docker (native runtime, phase 4a); runtime startup progress is RuntimeBootstrap's.",
    coveredBy: "vex-app/src/renderer/features/runtime/__tests__/RuntimeBootstrap.test.tsx",
  },
  {
    path: "vex-app/src/renderer/features/docker/__tests__/LicenseNotice.test.tsx",
    reason: "LicenseNotice.tsx carried the Docker Desktop license notice before an install and was deleted: the app no longer installs Docker (native runtime, phase 4a).",
    coveredBy: "vex-app/src/renderer/features/runtime/__tests__/RuntimeBootstrap.test.tsx",
  },
  {
    path: "vex-app/src/shared/schemas/__tests__/docker.test.ts",
    reason: "shared/schemas/docker.ts was deleted with the Docker IPC surface (native runtime, phase 4a); the runtime's IPC schemas live in shared/schemas/runtime.ts.",
    coveredBy: "vex-app/src/shared/schemas/__tests__/runtime.test.ts",
  },
];

export const DELETED_TEST_ALLOWLIST_PATHS = new Set(
  DELETED_TEST_ALLOWLIST.map((entry) => entry.path),
);
