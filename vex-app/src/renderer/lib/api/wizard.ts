/**
 * TanStack Query hooks over `vex.onboarding.{getWizardState,setWizardState,keystoreSet}`.
 *
 * `wizardState` runs at a short staleTime (5s) — short enough that a
 * refresh after the user crashed mid-wizard re-reads the persisted
 * state, but not so short that StrictMode dev double-mount + every
 * sidebar re-render thrashes the IPC. After `keystoreSet` succeeds,
 * the env state query is invalidated so a future skip-badge check
 * reflects the new password (codex turn 5 answer #4). The wizard
 * itself advances by mutating the local React step state and writing
 * the next `currentStepId` via `setWizardState`.
 */

import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import {
  WIZARD_STEP_IDS,
  type KeystoreSetInput,
  type KeystoreSetResult,
  type SetWizardStateInput,
  type WizardState,
  type WizardStepId,
} from "@shared/schemas/wizard.js";
import { onboardingKeys } from "./queryKeys.js";

/**
 * Compute the next persisted state for a forward step transition.
 * - Adds `current` to `completedSteps` (idempotent — no duplicates).
 * - Returns `next` as the new `currentStepId`.
 * - When `next === "review"` and the caller wants to mark the wizard
 *   completed, pass `markCompleted: true`.
 *
 * Pure helper — does no IPC. Used by step components to build the
 * `setWizardState` payload before calling `useSetWizardState().mutate`.
 */
export function nextWizardStateFor(args: {
  readonly completedSteps: ReadonlyArray<WizardStepId>;
  readonly current: WizardStepId;
  readonly next: WizardStepId;
  readonly markCompleted?: boolean;
}): SetWizardStateInput {
  const completed = args.completedSteps.includes(args.current)
    ? args.completedSteps
    : [...args.completedSteps, args.current];
  return {
    currentStepId: persistedNextStep(completed, args.next),
    completedSteps: completed,
    ...(args.markCompleted ? { completed: true } : {}),
  };
}

/**
 * The step the persisted state records after a save. Normally the step the
 * user moves to; after the wizard's Back (the user saved an earlier step
 * again) never behind the ground already covered: the step after the
 * furthest completed one (that step itself when it is the last). So the
 * `isForwardSafe` invariant holds, a relaunch lands where the user had got
 * to, and nothing already done is marked undone. The view moves to `next`
 * either way (`onAdvance`).
 */
function persistedNextStep(
  completed: ReadonlyArray<WizardStepId>,
  next: WizardStepId,
): WizardStepId {
  const furthest = Math.max(-1, ...completed.map((id) => WIZARD_STEP_IDS.indexOf(id)));
  const resume = WIZARD_STEP_IDS[Math.min(furthest + 1, WIZARD_STEP_IDS.length - 1)];
  if (resume === undefined) return next;
  return WIZARD_STEP_IDS.indexOf(next) >= WIZARD_STEP_IDS.indexOf(resume) ? next : resume;
}

/** The step before `current` (the wizard's Back), or null on the first step. */
export function previousStepId(current: WizardStepId): WizardStepId | null {
  const idx = WIZARD_STEP_IDS.indexOf(current);
  if (idx <= 0) return null;
  return WIZARD_STEP_IDS[idx - 1] ?? null;
}

/** Returns the canonical next step id, or null if `current` is the last step. */
export function nextStepId(current: WizardStepId): WizardStepId | null {
  const idx = WIZARD_STEP_IDS.indexOf(current);
  if (idx < 0 || idx >= WIZARD_STEP_IDS.length - 1) return null;
  return WIZARD_STEP_IDS[idx + 1] ?? null;
}

/**
 * M11: Wizard navigation mode. `first-pass` advances persisted
 * `currentStepId` forward and appends to `completedSteps`. `back-edit`
 * is local navigation only — the operator is editing a prior step
 * from the Review screen; persisted state stays at `currentStepId:
 * "review"` so the `isForwardSafe` schema invariant is never broken.
 */
export type WizardFlowMode = "first-pass" | "back-edit";

export interface AdvanceArgs {
  readonly flowMode: WizardFlowMode;
  readonly completedSteps: ReadonlyArray<WizardStepId>;
  readonly current: WizardStepId;
  readonly forwardNext: WizardStepId;
  readonly onAdvance: (next: WizardStepId) => void;
  readonly markCompleted?: boolean;
}

export interface UseStepAdvance {
  readonly advance: (
    args: AdvanceArgs,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  readonly isPending: boolean;
}

/**
 * Shared advance helper used by every wizard step. Centralises the
 * flowMode branch so all 9 steps behave identically when invoked from
 * Review's per-card "Edit" action.
 *
 * Uses `useMutation` inline (NOT `useSetWizardState`) so tests can mock
 * this hook as a single unit — calling `useSetWizardState` indirectly
 * would bypass vi.mock module overrides due to ESM in-module references.
 */
export function useStepAdvance(): UseStepAdvance {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (input: SetWizardStateInput) =>
      window.vex.onboarding.setWizardState(input),
    onSuccess: (result) => {
      if (result.ok) {
        queryClient.setQueryData(onboardingKeys.wizardState(), result);
      }
    },
  });
  return {
    isPending: mutation.isPending,
    advance: async (args) => {
      if (args.flowMode === "back-edit") {
        args.onAdvance("review");
        return { ok: true };
      }
      const next = nextWizardStateFor({
        completedSteps: args.completedSteps,
        current: args.current,
        next: args.forwardNext,
        ...(args.markCompleted ? { markCompleted: true } : {}),
      });
      const result = await mutation.mutateAsync(next);
      if (!result.ok) return { ok: false, message: result.error.message };
      args.onAdvance(args.forwardNext);
      return { ok: true };
    },
  };
}

export function wizardStateOptions() {
  return queryOptions({
    queryKey: onboardingKeys.wizardState(),
    queryFn: () => window.vex.onboarding.getWizardState(),
    staleTime: 5_000,
  });
}

export function useWizardState(): UseQueryResult<Result<WizardState>> {
  return useQuery(wizardStateOptions());
}

export function useSetWizardState(): UseMutationResult<
  Result<WizardState>,
  Error,
  SetWizardStateInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetWizardStateInput) =>
      window.vex.onboarding.setWizardState(input),
    onSuccess: (result) => {
      if (result.ok) {
        queryClient.setQueryData(onboardingKeys.wizardState(), result);
      }
    },
  });
}

export function useKeystoreSet(): UseMutationResult<
  Result<KeystoreSetResult>,
  Error,
  KeystoreSetInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: KeystoreSetInput) =>
      window.vex.onboarding.keystoreSet(input),
    onSuccess: (result) => {
      if (result.ok) {
        // The skip-badge layer reads `envState.hasKeystorePassword`;
        // invalidate it so the next mount (or any other panel that
        // gates on it) sees the freshly-persisted value (codex turn 5
        // answer #4). We intentionally do NOT refetch eagerly — the
        // wizard advances to Step 2 immediately, this mount unmounts.
        void queryClient.invalidateQueries({
          queryKey: onboardingKeys.envState(),
        });
      }
    },
  });
}
