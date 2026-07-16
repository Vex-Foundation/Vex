/**
 * "New Session" dialog. Owns the local form state and submits via
 * `useCreateSession()`. On success the new session is selected
 * automatically (`uiStore.setActiveSessionId`) so the panel opens
 * straight onto it.
 *
 * Form invariants mirror the IPC schema discriminated union:
 *   - mode + permission are immutable session axes
 *   - mission goal text is captured by the first chat submit, not here
 * The submit button stays disabled when the form is invalid.
 *
 * Presentational pieces (option catalogues, the `deriveSessionName` seed
 * helper, the `RadioCard`, and the form sections) live under
 * `./SessionCreator/` so this module keeps only the dialog shell + state
 * ownership.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
  type SessionCreateInput,
  type SessionMode,
  type SessionPermission,
} from "@shared/schemas/sessions.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { useCreateSession } from "../../lib/api/sessions.js";
import { useAvailableWallets } from "../../lib/api/session-wallets.js";
import { useUiStore } from "../../stores/uiStore.js";
import { deriveSessionName } from "./SessionCreator/deriveSessionName.js";
import {
  ModeFieldset,
  NameField,
  PermissionFieldset,
  SubmitError,
  WalletFieldset,
} from "./SessionCreator/FormSections.js";

interface SessionCreatorProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
}

export function SessionCreator({
  open,
  onOpenChange,
}: SessionCreatorProps): JSX.Element {
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);
  // The sidebar's active mode filter (all/agent/mission). When the operator is
  // already filtered to Mission and opens "New session", default the dialog to
  // Mission mode so they don't have to flip it by hand.
  const sessionModeFilter = useUiStore((s) => s.sessionModeFilter);
  const createSessionInitialMessage = useUiStore(
    (s) => s.createSessionInitialMessage,
  );
  const createSessionPreset = useUiStore((s) => s.createSessionPreset);
  const setPendingFirstMessage = useUiStore((s) => s.setPendingFirstMessage);
  const setSigningState = useUiStore((s) => s.setSigningState);
  const createMutation = useCreateSession();
  const availableWallets = useAvailableWallets();
  const inventory =
    availableWallets.data?.ok === true
      ? availableWallets.data.data
      : { evm: [], solana: [] };

  const [name, setName] = useState<string>("");
  const [mode, setMode] = useState<SessionMode>("agent");
  const [permission, setPermission] = useState<SessionPermission>("restricted");
  const [selectedEvmWalletId, setSelectedEvmWalletId] = useState<string | null>(null);
  const [selectedSolanaWalletId, setSelectedSolanaWalletId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [createdHyperliquidSessionId, setCreatedHyperliquidSessionId] =
    useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Reset state on every (re)open so the next opening starts clean.
  useEffect(() => {
    if (open) {
      setName(
        createSessionInitialMessage !== null
          ? deriveSessionName(createSessionInitialMessage)
          : createSessionPreset === "hyperliquid"
            ? "Hyperliquid"
            : "",
      );
      setMode(
        createSessionPreset === "hyperliquid"
          ? "agent"
          : sessionModeFilter === "mission"
            ? "mission"
            : "agent",
      );
      setPermission("restricted");
      setSelectedEvmWalletId(null);
      setSelectedSolanaWalletId(null);
      setSubmitError(null);
      setOpeningWorkspace(false);
      setCreatedHyperliquidSessionId(null);
    }
  }, [
    open,
    createSessionInitialMessage,
    createSessionPreset,
    sessionModeFilter,
  ]);

  // Focus the Name input first when the dialog opens — it is the only
  // text field in this modal. Mission goal capture happens in chat.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      nameRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  const trimmedName = name.trim();
  const nameInvalid = trimmedName.length === 0;
  const submitDisabled =
    (nameInvalid && createdHyperliquidSessionId === null) ||
    createMutation.isPending ||
    openingWorkspace;

  const openHyperliquidWorkspace = useCallback(
    async (sessionId: string): Promise<boolean> => {
      setOpeningWorkspace(true);
      setSubmitError(null);
      try {
        const result = await window.vex.hyperliquid.enterWorkspace({ sessionId });
        if (!result.ok) {
          setSigningState("idle");
          setSubmitError(
            `The session was created, but Hypervexing could not open: ${result.error.message}`,
          );
          return false;
        }
        setSigningState("signed");
        setActiveSessionId(sessionId);
        onOpenChange(false);
        return true;
      } catch {
        setSigningState("idle");
        setSubmitError(
          "The session was created, but Hypervexing could not open. Retry opening it.",
        );
        return false;
      } finally {
        setOpeningWorkspace(false);
      }
    },
    [onOpenChange, setActiveSessionId, setSigningState],
  );

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (submitDisabled) return;
      if (createdHyperliquidSessionId !== null) {
        await openHyperliquidWorkspace(createdHyperliquidSessionId);
        return;
      }
      setSubmitError(null);
      const input: SessionCreateInput =
        mode === "mission"
          ? { mode: "mission", name: trimmedName, permission, selectedEvmWalletId, selectedSolanaWalletId }
          : { mode: "agent", name: trimmedName, permission, selectedEvmWalletId, selectedSolanaWalletId };
      // The sidebar's New-session key mirrors this mutation: ink loop while
      // in flight, one-shot glint on success (the glint's animationend
      // returns the state to idle). The try/catch exists only so an
      // unexpected mutateAsync throw can never leave the stroke looping
      // forever — IPC normally resolves with a Result, never throws.
      setSigningState("signing");
      try {
        const outcome = await createMutation.mutateAsync(input);
        if (!outcome.ok) {
          setSigningState("idle");
          setSubmitError(outcome.error.message);
          return;
        }
        if (createSessionPreset === "hyperliquid") {
          // Create first, then ask main to enter before selecting the session.
          // When selection changes, the workspace controller's authoritative
          // mode read sees the completed transition without racing a live push.
          setCreatedHyperliquidSessionId(outcome.data.id);
          await openHyperliquidWorkspace(outcome.data.id);
          return;
        }
        setSigningState("signed");
        // Hand the welcome-typed first message to the new session's composer,
        // which owns the actual chat.submit (+ failure/preserve UX). Set the
        // hand-off BEFORE activating so the composer's consume-effect sees it on
        // mount; `closeCreateSession` (via onOpenChange) clears only modal state,
        // never this hand-off.
        if (createSessionInitialMessage !== null) {
          setPendingFirstMessage({
            sessionId: outcome.data.id,
            message: createSessionInitialMessage,
          });
        }
        setActiveSessionId(outcome.data.id);
        onOpenChange(false);
      } catch (error: unknown) {
        setSigningState("idle");
        throw error;
      }
    },
    [
      createMutation,
      createSessionInitialMessage,
      createSessionPreset,
      createdHyperliquidSessionId,
      mode,
      openHyperliquidWorkspace,
      onOpenChange,
      permission,
      selectedEvmWalletId,
      selectedSolanaWalletId,
      setActiveSessionId,
      setPendingFirstMessage,
      setSigningState,
      submitDisabled,
      trimmedName,
    ],
  );

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (!next && createdHyperliquidSessionId !== null) {
        // The database create already succeeded. If opening the room failed or
        // the user dismisses the retry state, continue in that normal session
        // instead of leaving an invisible duplicate behind.
        setActiveSessionId(createdHyperliquidSessionId);
      }
      onOpenChange(next);
    },
    [createdHyperliquidSessionId, onOpenChange, setActiveSessionId],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* Brand chrome (raised ink panel, hairline, black/70 no-blur backdrop)
       * is the Dialog base since the rebrand — only width is per-modal. */}
      <DialogContent className="max-w-2xl">
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="gap-2.5 border-[var(--vex-line)] px-8 py-5">
            {/* The stamp becomes the landing eyebrow (mono micro-label +
             * leading rule). Same <h2>, same aria-labelledby id — only the
             * register changes; text stays "New session" (uppercased by
             * CSS) so the accessible name is untouched. */}
            <DialogTitle className="vex-eyebrow">
              {createSessionPreset === "hyperliquid"
                ? "New Hyperliquid session"
                : "New session"}
            </DialogTitle>
            {/* Ceremony line — the retired welcome headline promoted to the
             * display register (landing .prob-card h3: Archivo 700 19px),
             * read once per new act (where ceremony belongs). */}
            <p className="font-display text-[19px] font-bold leading-tight tracking-[-0.02em] text-[var(--vex-text)]">
              Your chain. Your rules. I execute.
            </p>
            <DialogDescription className="text-xs text-[var(--vex-text-3)]">
              {createSessionPreset === "hyperliquid"
                ? "Public market scans work without a wallet. Select an EVM wallet to trade; mode and permission lock after creation."
                : "Mode and permission are locked once the session is created."}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="gap-6 px-8">
            <fieldset
              disabled={createdHyperliquidSessionId !== null}
              className="contents"
            >
              <NameField name={name} onNameChange={setName} nameRef={nameRef} />

              <ModeFieldset mode={mode} onModeChange={setMode} />

              <PermissionFieldset
                permission={permission}
                onPermissionChange={setPermission}
              />

              <WalletFieldset
                selectedEvmWalletId={selectedEvmWalletId}
                selectedSolanaWalletId={selectedSolanaWalletId}
                evmOptions={inventory.evm}
                solanaOptions={inventory.solana}
                onEvmChange={setSelectedEvmWalletId}
                onSolanaChange={setSelectedSolanaWalletId}
              />
            </fieldset>

            <SubmitError submitError={submitError} />
          </DialogBody>

          <DialogFooter className="border-[var(--vex-line)] px-8 py-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              disabled={createMutation.isPending || openingWorkspace}
              className="text-[var(--vex-text-2)] hover:bg-white/[0.06] hover:text-foreground"
            >
              {createdHyperliquidSessionId === null ? "Cancel" : "Continue in Vex"}
            </Button>
            {/* THE primary action — the landing's filled cobalt pill
             * (Button default variant: mono uppercase, bg-primary), one
             * step heavier than Cancel (h-10 vs h-9). */}
            <Button type="submit" disabled={submitDisabled} className="h-10 px-6">
              {openingWorkspace
                ? "Opening…"
                : createdHyperliquidSessionId !== null
                  ? "Retry opening"
                  : createMutation.isPending
                    ? "Creating…"
                    : createSessionPreset === "hyperliquid"
                      ? "Create & open"
                      : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
