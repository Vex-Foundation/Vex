/**
 * "New Session" dialog. Owns the local form state and submits via
 * `useCreateSession()`. On success `uiStore.completeSessionCreate` selects
 * the new session automatically (so the panel opens straight onto it),
 * installs the mode-gated welcome reasoning-effort hand-off, and closes the
 * modal, all in one store transition.
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
  // The sidebar's active mode filter (all/agent/mission). When the operator is
  // already filtered to Mission and opens "New session", default the dialog to
  // Mission mode so they don't have to flip it by hand.
  const sessionModeFilter = useUiStore((s) => s.sessionModeFilter);
  const createSessionInitialTurn = useUiStore(
    (s) => s.createSessionInitialTurn,
  );
  const completeSessionCreate = useUiStore((s) => s.completeSessionCreate);
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
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Reset state on every (re)open so the next opening starts clean.
  useEffect(() => {
    if (open) {
      setName(
        createSessionInitialTurn !== null
          ? deriveSessionName(createSessionInitialTurn.message)
          : "",
      );
      setMode(sessionModeFilter === "mission" ? "mission" : "agent");
      setPermission("restricted");
      setSelectedEvmWalletId(null);
      setSelectedSolanaWalletId(null);
      setSubmitError(null);
    }
  }, [open, createSessionInitialTurn, sessionModeFilter]);

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
  const submitDisabled = nameInvalid || createMutation.isPending;

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (submitDisabled) return;
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
        setSigningState("signed");
        // Single atomic transition (E3/v2): install the MODE-GATED reasoning
        // effort into the hand-off turn, close the modal, and activate the
        // new session — the new composer's hand-off effect picks up the
        // (already gated) turn on mount. Mission sessions never carry a
        // reasoning pick: the welcome composer captures it mode-agnostically
        // (Send is pressed before Mode is even chosen here), so this is
        // where it gets stripped — main/ipc/chat.ts's own mission strip
        // stays defense-in-depth, not the only gate.
        const initialReasoningEffort =
          mode === "mission"
            ? null
            : (createSessionInitialTurn?.reasoningEffort ?? null);
        completeSessionCreate(outcome.data.id, initialReasoningEffort);
      } catch (error: unknown) {
        setSigningState("idle");
        throw error;
      }
    },
    [
      completeSessionCreate,
      createMutation,
      createSessionInitialTurn,
      mode,
      permission,
      selectedEvmWalletId,
      selectedSolanaWalletId,
      setSigningState,
      submitDisabled,
      trimmedName,
    ],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Brand chrome (raised ink panel, hairline, black/70 no-blur backdrop)
       * is the Dialog base since the rebrand — only width is per-modal. */}
      <DialogContent className="max-w-2xl">
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="gap-2.5 border-line-2 px-8 py-5">
            {/* The stamp becomes the landing eyebrow (mono micro-label +
             * leading rule). Same <h2>, same aria-labelledby id — only the
             * register changes; text stays "New session" (uppercased by
             * CSS) so the accessible name is untouched. */}
            <DialogTitle className="vex-eyebrow">New session</DialogTitle>
            {/* Ceremony line — the retired welcome headline promoted to the
             * display register (landing .prob-card h3: Archivo 700 19px),
             * read once per new act (where ceremony belongs). */}
            <p className="font-display text-[19px] font-bold leading-tight tracking-[-0.02em] text-ink-primary">
              Your chain. Your rules. I execute.
            </p>
            <DialogDescription className="text-xs text-ink-tertiary">
              Mode and permission are locked once the session is created.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="gap-6 px-8">
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

            <SubmitError submitError={submitError} />
          </DialogBody>

          <DialogFooter className="border-line-2 px-8 py-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={createMutation.isPending}
              className="text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
            >
              Cancel
            </Button>
            {/* THE primary action — the landing's filled cobalt pill
             * (Button default variant: mono uppercase, bg-primary), one
             * step heavier than Cancel (h-10 vs h-9). */}
            <Button type="submit" disabled={submitDisabled} className="h-10 px-6">
              {createMutation.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
