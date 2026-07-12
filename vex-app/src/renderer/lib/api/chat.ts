import { useCallback, useRef } from "react";
import {
  useMutation,
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
 * Chat submit mutation + a stable `stop()` that cancels the in-flight turn
 * (9-5b). The active invocation's `cancel` is captured per-call and cleared
 * only when THAT same invocation settles, so a newer submit started before
 * the first resolves keeps its own handle (same ownership rule as the
 * stream-preview captured-streamId guard).
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
> & { readonly stop: () => void };

export function useSubmitChat(): UseSubmitChatResult {
  const queryClient = useQueryClient();
  const cancelRef = useRef<(() => void) | null>(null);
  const activeSubmitRef = useRef<symbol | null>(null);

  const mutation = useMutation({
    mutationFn: (input: ChatSubmitInput) => {
      const invocation = window.vex.chat.submit(input);
      cancelRef.current = invocation.cancel;
      return invocation.promise.finally(() => {
        if (cancelRef.current === invocation.cancel) cancelRef.current = null;
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

  const stop = useCallback(() => {
    cancelRef.current?.();
  }, []);

  return { ...mutation, mutate, mutateAsync: submitTurn, stop };
}
