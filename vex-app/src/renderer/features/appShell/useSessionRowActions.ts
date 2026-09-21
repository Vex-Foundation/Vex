/**
 * Pin, rename and remove for a sessions rail. The agent rail and the Lighter
 * rail list different sessions but act on a row the same way, so the
 * mutations and the remove-confirmation state live here once.
 */

import { useCallback, useState } from "react";
import type { SessionDeleteOutcome, SessionListItem } from "@shared/schemas/sessions.js";
import { useDeleteSession, useRenameSession, useSetSessionPinned } from "../../lib/api/sessions.js";

export function useSessionRowActions() {
  const pinMutation = useSetSessionPinned();
  const deleteMutation = useDeleteSession();
  const renameMutation = useRenameSession();
  // TanStack Query exposes the last variables sent to the mutation; we
  // use it to disable the star button on the in-flight row only.
  const pendingPinId =
    pinMutation.isPending && pinMutation.variables
      ? pinMutation.variables.id
      : null;
  const [removeTarget, setRemoveTarget] = useState<SessionListItem | null>(null);
  const [removeBlocked, setRemoveBlocked] =
    useState<SessionDeleteOutcome | null>(null);

  const handleTogglePin = useCallback(
    (id: string, nextPinned: boolean): void => {
      pinMutation.mutate({ id, pinned: nextPinned });
    },
    [pinMutation],
  );

  const handleRename = useCallback(
    (id: string, name: string): void => {
      renameMutation.mutate({ id, name });
    },
    [renameMutation],
  );

  const handleRequestRemove = useCallback((row: SessionListItem): void => {
    setRemoveTarget(row);
    setRemoveBlocked(null);
  }, []);

  const handleCancelRemove = useCallback((): void => {
    setRemoveTarget(null);
    setRemoveBlocked(null);
  }, []);

  const handleConfirmRemove = useCallback(async (): Promise<void> => {
    if (removeTarget === null) return;
    const result = await deleteMutation.mutateAsync({ id: removeTarget.id });
    if (!result.ok) {
      setRemoveBlocked("state_changed");
      return;
    }
    const outcome = result.data.outcome;
    if (
      outcome === "removed" ||
      outcome === "not_found" ||
      outcome === "already_removed"
    ) {
      setRemoveTarget(null);
      setRemoveBlocked(null);
      return;
    }
    // blocked_active_mission | blocked_pending_approval | state_changed
    setRemoveBlocked(outcome);
  }, [deleteMutation, removeTarget]);

  return {
    pendingPinId,
    removeTarget,
    removeBlocked,
    removePending: deleteMutation.isPending,
    handleTogglePin,
    handleRename,
    handleRequestRemove,
    handleCancelRemove,
    handleConfirmRemove,
  };
}
