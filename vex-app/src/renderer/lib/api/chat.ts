import { useCallback, useRef } from "react";
import {
  useMutation,
  useMutationState,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  ChatSubmitInput,
  ChatSubmitResult,
} from "@shared/schemas/chat.js";
import { approvalsKeys, isUsageQueryForSession } from "./queryKeys.js";
import { sessionKeys } from "./sessions.js";

/**
 * Chat submit mutation + a stable `stop(sessionId)` that cancels the in-flight
 * turn OF THAT SESSION (9-5b). The active invocation's `cancel` is captured
 * per-call under its session id and cleared only when THAT same invocation
 * settles, so a newer submit started before the first resolves keeps its own
 * handle (same ownership rule as the stream-preview captured-streamId guard).
 *
 * WHY THE HANDLE IS SESSION-KEYED. The composer is RESIDENT: one hook instance
 * serves every session the user switches between. A single handle meant that
 * pressing Stop in session B cancelled whatever turn session A had left in
 * flight - a cancellation aimed at the wrong conversation. The caller must name
 * the session it is stopping, and an unknown session cancels nothing.
 *
 * `mutate`/`mutateAsync` are wrapped to call `mutation.reset()` once the turn
 * settles. TanStack Query v5's `MutationObserver.onUnsubscribe()` detaches the
 * observer from the in-flight mutation and never reattaches on resubscribe
 * (`query-core/src/mutationObserver.ts`). When the first turn is fired from a
 * mount effect (welcome→create hand-off) under React StrictMode, the dev
 * mount-effect replay unsubscribes/resubscribes the observer mid-flight, so it
 * misses the settle transition and `isPending` freezes at `true` (Send stays a
 * dead Stop button). `reset()` — which the component is still subscribed to —
 * returns the observer to idle. A per-call Symbol token guards it so a stale
 * older settle can never reset a newer in-flight turn (same rule as `cancel`),
 * and a never-settling promise never resets (Stop control stays mounted).
 */
export type UseSubmitChatResult = UseMutationResult<
  Result<ChatSubmitResult>,
  Error,
  ChatSubmitInput
> & { readonly stop: (sessionId: string) => void };

export const CHAT_SUBMIT_MUTATION_KEY = ["chat", "submit"] as const;

/**
 * Read the shared mutation cache instead of creating another submit observer.
 * This keeps shell-level status indicators live for the entire IPC request,
 * including quiet gaps between provider streams and tool execution.
 */
export function useIsChatSubmitting(sessionId: string | null): boolean {
  const pendingSessionIds = useMutationState({
    filters: {
      mutationKey: CHAT_SUBMIT_MUTATION_KEY,
      status: "pending",
    },
    select: (mutation) =>
      (mutation.state.variables as ChatSubmitInput | undefined)?.sessionId ??
      null,
  });
  return sessionId !== null && pendingSessionIds.includes(sessionId);
}

export function useSubmitChat(): UseSubmitChatResult {
  const queryClient = useQueryClient();
  // One cancel handle PER SESSION (see the header). Bounded by the number of
  // sessions with a turn actually in flight, and every entry is deleted by the
  // invocation that owns it when it settles.
  const cancelsRef = useRef<Map<string, () => void>>(new Map());
  const activeSubmitRef = useRef<symbol | null>(null);

  const mutation = useMutation({
    mutationKey: CHAT_SUBMIT_MUTATION_KEY,
    mutationFn: (input: ChatSubmitInput) => {
      const invocation = window.vex.chat.submit(input);
      const cancels = cancelsRef.current;
      cancels.set(input.sessionId, invocation.cancel);
      return invocation.promise.finally(() => {
        if (cancels.get(input.sessionId) === invocation.cancel) {
          cancels.delete(input.sessionId);
        }
      });
    },
    onSuccess: (result, variables) => {
      if (!result.ok) return;
      void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(variables.sessionId),
      });
      // A completed setup/chat turn may author or accept the session plan, so
      // refresh the plan query to keep the Plan badge deterministic — today it
      // only refreshes incidentally (e.g. when the plan modal is reopened).
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.plan(variables.sessionId),
      });
      // A restricted turn can enqueue an approval before chat.submit returns.
      // Refresh both the inline card and the app-wide inbox immediately instead
      // of waiting for their polling fallback.
      if (result.data.pendingApprovals?.length > 0) {
        void queryClient.invalidateQueries({
          queryKey: approvalsKeys.pending(variables.sessionId),
        });
        void queryClient.invalidateQueries({
          queryKey: approvalsKeys.pendingAll(),
        });
      }
      // A completed turn advances usage rows + the session token_count, so
      // refresh the runtime bar immediately (usage totals, last-turn, and
      // context window). The transcript-append live-sync is the backstop
      // for non-interactive turns (mission/wake).
      void queryClient.invalidateQueries({
        predicate: (query) =>
          isUsageQueryForSession(query.queryKey, variables.sessionId),
      });
    },
  });

  const { mutateAsync: rawMutateAsync, reset } = mutation;

  const submitTurn = useCallback<UseSubmitChatResult["mutateAsync"]>(
    async (input, options) => {
      const token = Symbol("chat-submit");
      activeSubmitRef.current = token;
      try {
        return await rawMutateAsync(input, options);
      } finally {
        // Only the most recent submit may flip the observer back to idle, so a
        // late settle from a superseded turn can't reset a fresh in-flight one.
        if (activeSubmitRef.current === token) {
          activeSubmitRef.current = null;
          reset();
        }
      }
    },
    [rawMutateAsync, reset],
  );

  const mutate = useCallback<UseSubmitChatResult["mutate"]>(
    (input, options) => {
      void submitTurn(input, options).catch(() => undefined);
    },
    [submitTurn],
  );

  const stop = useCallback((sessionId: string) => {
    cancelsRef.current.get(sessionId)?.();
  }, []);

  return { ...mutation, mutate, mutateAsync: submitTurn, stop };
}
