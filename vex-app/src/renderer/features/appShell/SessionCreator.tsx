/**
 * The new-session form (docs/design/R3-MINIMAL.md section 12): a sheet over the
 * centre column with both sidebars standing and no veil, a native `<dialog>`
 * underneath (`components/ui/sheet.tsx`), so focus is trapped, Escape closes
 * and focus returns to the trigger. Owns the local form state and submits via
 * `useCreateSession()`. On success `uiStore.completeSessionCreate` selects
 * the new session automatically (so the panel opens straight onto it),
 * installs the mode-gated welcome reasoning-effort hand-off, and closes the
 * sheet, all in one store transition.
 *
 * Form invariants mirror the IPC schema discriminated union:
 *   - mode + permission are immutable session axes
 *   - mission goal text is captured by the first chat submit, not here
 * The submit button stays disabled when the form is invalid.
 *
 * Presentational pieces (option catalogues, the `deriveSessionName` seed
 * helper, the `RadioCard`, and the form sections) live under
 * `./SessionCreator/` so this module keeps only the sheet shell + state
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
import { DialogDescription, DialogTitle } from "../../components/ui/dialog.js";
import { Sheet, SheetBody, SheetContent } from "../../components/ui/sheet.js";
import { useLiveAnnouncer } from "../../components/ui/live-region.js";
import { SubmitError } from "../../components/ui/submit-error.js";
import { useCreateSession } from "../../lib/api/sessions.js";
import { useAvailableWallets } from "../../lib/api/session-wallets.js";
import { useUiStore } from "../../stores/uiStore.js";
import { useDeskSessionName } from "./lighterTrading/desk-session.js";
import { deriveSessionName } from "./SessionCreator/deriveSessionName.js";
import {
  ModeFieldset,
  NameField,
  PermissionFieldset,
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
  // A session created from the Lighter desk is an agent session pinned to
  // that workspace: mission mode has no meaning there, so the fieldset hides
  // and the create input carries `workspace: "lighter"`.
  const lighter = useUiStore((s) => s.runtimeMode === "lighter");
  const deskSessionName = useDeskSessionName();
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
  /**
   * Whether the operator has touched the EVM field this opening. The desk
   * default below fills an UNANSWERED field, so it must never re-apply over a
   * deliberate clear back to none.
   */
  const evmChosen = useRef(false);
  // Announcement is driven by the SUBMIT PATH below, never by a role on the
  // error paragraph - see `components/ui/live-region.tsx`.
  const { announce, region: liveRegion } = useLiveAnnouncer();

  // Reset state on every (re)open so the next opening starts clean.
  useEffect(() => {
    if (open) {
      setName(
        createSessionInitialTurn !== null
          ? deriveSessionName(createSessionInitialTurn.message)
          : (deskSessionName ?? ""),
      );
      setMode(!lighter && sessionModeFilter === "mission" ? "mission" : "agent");
      setPermission("restricted");
      setSelectedEvmWalletId(null);
      setSelectedSolanaWalletId(null);
      setSubmitError(null);
      evmChosen.current = false;
    }
    // `deskSessionName` is read at open time only: the market list settling
    // while the dialog is up must not overwrite what the operator typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, createSessionInitialTurn, sessionModeFilter, lighter]);

  /**
   * THE DESK OPENS ON THE PRIMARY WALLET, and says so.
   *
   * Main already binds it: a create carrying `workspace: "lighter"` with no
   * selection is filled with the primary entry (`ipc/_wallet-refs.ts`,
   * `deskWalletRef`), because the desk mints sessions down routes that have no
   * picker in front of them at all. What was missing is that this form - the
   * one route that DOES show a picker - rendered that same session as an empty
   * field, which reads as "chat-only, no wallet" and is the opposite of what
   * the create would do.
   *
   * So the field is seeded rather than defaulted in main alone, and only here,
   * in the desk workspace: an ordinary session keeps opening empty, where an
   * empty field still means the chat-only session it says it means.
   *
   * Seeded in its own effect because the inventory is a query: at the moment
   * the dialog opens it may not have answered yet, and the reset above has
   * just cleared the field. This lands when the wallets arrive, once, and
   * never over an operator who has already answered.
   */
  // INDEX 0 IS THE PRIMARY, on both sides of the boundary: main's
  // `getPrimaryEvmEntry` is `cfg.wallet.evm[0]` and `wallets:listAvailable`
  // hands this list over in config order, unsorted. Sorting it anywhere in
  // between would leave the field showing one wallet and the create binding
  // another, which is worse than showing nothing.
  const primaryEvmWalletId = inventory.evm[0]?.id ?? null;
  useEffect(() => {
    if (!open || !lighter || evmChosen.current || primaryEvmWalletId === null) return;
    setSelectedEvmWalletId((current) => current ?? primaryEvmWalletId);
  }, [open, lighter, primaryEvmWalletId]);

  // Focus the Name input first when the dialog opens - it is the only
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
          : {
            mode: "agent",
            name: trimmedName,
            permission,
            selectedEvmWalletId,
            selectedSolanaWalletId,
            ...(lighter && { workspace: "lighter" as const }),
          };
      // The sidebar's New-session key mirrors this mutation: ink loop while
      // in flight, one-shot glint on success (the glint's animationend
      // returns the state to idle). The try/catch exists only so an
      // unexpected mutateAsync throw can never leave the stroke looping
      // forever - IPC normally resolves with a Result, never throws.
      setSigningState("signing");
      try {
        const outcome = await createMutation.mutateAsync(input);
        if (!outcome.ok) {
          setSigningState("idle");
          setSubmitError(outcome.error.message);
          announce("error", outcome.error.message);
          return;
        }
        setSigningState("signed");
        // Single atomic transition (E3/v2): install the MODE-GATED reasoning
        // effort into the hand-off turn, close the modal, and activate the
        // new session - the new composer's hand-off effect picks up the
        // (already gated) turn on mount. Mission sessions never carry a
        // reasoning pick: the welcome composer captures it mode-agnostically
        // (Send is pressed before Mode is even chosen here), so this is
        // where it gets stripped - main/ipc/chat.ts's own mission strip
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
      announce,
      completeSessionCreate,
      createMutation,
      createSessionInitialTurn,
      lighter,
      mode,
      permission,
      selectedEvmWalletId,
      selectedSolanaWalletId,
      setSigningState,
      submitDisabled,
      trimmedName,
    ],
  );

  // The sheet covers the centre column under the title bar. A new identity per
  // opening makes the sheet re-pin to the column as it stands NOW (a sidebar
  // may have opened or folded since the shell mounted).
  const anchor = useCallback((): Element | null => centreColumn(), [open]);

  // The form opens on Mission when the Missions nav row set the sidebar
  // filter; the foot says so while Mission is the chosen mode.
  const preselectedFromMissions =
    !lighter && sessionModeFilter === "mission" && mode === "mission";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent anchor={anchor}>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <SheetBody className="gap-0">
            <div className="mx-auto w-full max-w-[720px] pt-[34px]">
              {/* The panel title: sans 22 / 500 (section 1.3); the line under
               * it is the ceremony line, then the lock note. */}
              <DialogTitle className="m-0 text-[22px] leading-[1.3]">
                New session
              </DialogTitle>
              <p className="m-0 mt-1.5 text-[14.5px] leading-[1.45] text-ink-secondary">
                Your chain. Your rules. I execute.
              </p>
              <DialogDescription className="m-0 mt-1 text-[12.5px] leading-[1.45] text-ink-tertiary">
                Mode and permission are locked once the session is created.
              </DialogDescription>

              <div className="mt-[22px]">
                <NameField name={name} onNameChange={setName} nameRef={nameRef} />
              </div>

              {lighter ? null : (
                <div className="mt-[22px]">
                  <ModeFieldset mode={mode} onModeChange={setMode} />
                </div>
              )}

              <div className="mt-[22px]">
                <PermissionFieldset
                  permission={permission}
                  onPermissionChange={setPermission}
                />
              </div>

              <div className="mt-[22px]">
                <WalletFieldset
                  selectedEvmWalletId={selectedEvmWalletId}
                  selectedSolanaWalletId={selectedSolanaWalletId}
                  evmOptions={inventory.evm}
                  solanaOptions={inventory.solana}
                  onEvmChange={(id) => {
                    evmChosen.current = true;
                    setSelectedEvmWalletId(id);
                  }}
                  onSolanaChange={setSelectedSolanaWalletId}
                />
              </div>

              {liveRegion}

              {/* The foot follows the fields; when the form is taller than the
               * column it sticks to the bottom of the scroll, so Create and a
               * refusal stay in view beside the key that produced them. */}
              <div className="sticky bottom-0 mt-[26px] bg-surface-base">
                {submitError !== null ? (
                  <div className="pb-4">
                    <SubmitError submitError={submitError} />
                  </div>
                ) : null}
                <div className="flex items-center gap-2.5 border-t border-rule-quiet pb-6 pt-4">
                  <span className="min-w-0 text-[12.5px] leading-[1.45] text-ink-tertiary">
                    {preselectedFromMissions
                      ? "Opened from Missions, so Mission is preselected."
                      : null}
                  </span>
                  <span className="flex-1" />
                  <Button
                    type="button"
                    variant="quiet"
                    onClick={() => onOpenChange(false)}
                    disabled={createMutation.isPending}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={submitDisabled}>
                    {createMutation.isPending ? "Creating…" : "Create"}
                  </Button>
                </div>
              </div>
            </div>
          </SheetBody>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The box the sheet covers: the centre column under the title bar (section
 * 12), which is the body wrapper that follows the head in every mode. The
 * chat's own surface and the column under the head are the fallbacks; with
 * none of them (a test render) the sheet covers the element it is mounted in.
 */
function centreColumn(): Element | null {
  return (
    document.querySelector(
      '[data-vex-area="shell-frame"] .vex-shell-centre > .min-h-0.flex-1',
    ) ??
    document.querySelector('[data-vex-session-surface="shell"]') ??
    document.querySelector('[data-vex-area="shell-status-strip"]')
      ?.nextElementSibling ??
    null
  );
}
