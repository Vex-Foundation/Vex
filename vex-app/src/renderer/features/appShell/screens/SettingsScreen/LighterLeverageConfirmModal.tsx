/**
 * The consent surface for a leverage change on a real Lighter account.
 *
 * WHAT IT RENDERS IS MAIN'S PROPOSAL, NOT THE RENDERER'S IDEA OF ONE. The user
 * picks a market, a leverage and a margin mode; main resolves that selector
 * against live account and market state, persists the exact proposal, and hands
 * back the DTO this modal paints. Confirm sends only `{ proposalId }`, so the
 * values the person read and the values that get signed are the same row in the
 * database rather than two copies that could drift.
 *
 * WHAT IT NEVER DOES: soften the sentence, hide the expiry, or default focus to
 * the action. Cancel takes initial focus (`DIALOG_INITIAL_FOCUS`), Escape
 * cancels through the primitive's own `cancel` path, and the consequence strip
 * sits outside the body's scroll region so it cannot be scrolled away from the
 * button that performs the change. That is this repository's consent grammar,
 * and it is the same stance the deepseek-harness approval seam takes: the
 * decision fails closed and the answerer is never nudged toward "yes".
 *
 * Liquidation price and open orders are OBSERVATIONS. They are labelled as such
 * because they are not bound into what is signed: main revalidates the terms
 * (current leverage, mode, position) immediately before signing and refuses on
 * drift, but a liquidation price is a moving number nobody can promise.
 */

import { useEffect, useRef, type JSX } from "react";
import type { LighterIntegrationEnvironment } from "@shared/schemas/lighter-integration.js";
import type { LighterLeverageProposal } from "@shared/schemas/lighter-trading-limits.js";
import { Button } from "../../../../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogConsequence,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DIALOG_INITIAL_FOCUS,
} from "../../../../components/ui/dialog.js";
import {
  COLLATERAL_UNIT,
  CONFIRM_CANCEL,
  CONFIRM_CONFIRM,
  CONFIRM_LABEL_ACCOUNT,
  CONFIRM_LABEL_LEVERAGE,
  CONFIRM_LABEL_LIQUIDATION,
  CONFIRM_LABEL_MARKET,
  CONFIRM_LABEL_MODE,
  CONFIRM_LABEL_ORDERS,
  CONFIRM_LABEL_POSITION,
  CONFIRM_NO_POSITION,
  CONFIRM_OBSERVATION_NOTE,
  CONFIRM_SUBMITTING,
  CONFIRM_UNKNOWN,
  confirmExpiry,
  confirmOrdersLine,
  confirmPositionLine,
  confirmTitle,
  confirmTransition,
  leverageConsequenceSentence,
} from "./lighter-trading-setup-copy.js";
import { formatProposalExpiry } from "./lighter-leverage-view.js";

/** The issued proposal branch: the union's other branch signs nothing. */
export type LighterLeverageIssuedProposal = Extract<
  LighterLeverageProposal,
  { readonly kind: "proposal" }
>;

export interface LighterLeverageConfirmModalProps {
  readonly proposal: LighterLeverageIssuedProposal;
  readonly environment: LighterIntegrationEnvironment;
  /** True while Confirm is in flight; both buttons stop accepting a second press. */
  readonly submitting: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (proposalId: string) => void;
}

export function LighterLeverageConfirmModal({
  proposal,
  environment,
  submitting,
  onCancel,
  onConfirm,
}: LighterLeverageConfirmModalProps): JSX.Element {
  const quoteUnit = COLLATERAL_UNIT[environment];

  /**
   * FOCUS COMES BACK, on every exit.
   *
   * The dialog primitive restores focus on the element's own `close` event,
   * which covers Escape and the controlled close. This surface also disappears
   * by UNMOUNTING - the card drops the proposal once main answers - and an
   * unmounted `<dialog>` fires no `close`, so focus would land on the body and
   * a keyboard user would be back at the top of Settings. The element that had
   * focus when the proposal opened is the Apply button that opened it.
   */
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(
    () => () => {
      const target = returnFocusRef.current;
      if (target !== null && document.contains(target)) target.focus();
    },
    [],
  );
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Escape and backdrop both arrive here. A close intent while the change
        // is in flight is ignored rather than pretended: the signing is already
        // main's, and closing the surface would not recall it.
        if (!next && !submitting) onCancel();
      }}
    >
      <DialogContent
        closeOnBackdropClick={false}
        data-vex-lighter-leverage-confirm={proposal.symbol}
      >
        <DialogHeader>
          <DialogTitle>{confirmTitle(proposal.symbol)}</DialogTitle>
          <DialogDescription>
            {confirmTransition(
              `${proposal.current.leverageDisplay}x ${proposal.current.marginMode}`,
              `${proposal.target.leverageDisplay}x ${proposal.target.marginMode}`,
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogConsequence>
          <span>{leverageConsequenceSentence(proposal.symbol)}</span>
          <span>{confirmExpiry(formatProposalExpiry(proposal.expiresAt))}</span>
        </DialogConsequence>

        <DialogBody>
          <dl className="flex flex-col gap-2 text-[13px] leading-[20px]">
            <Row label={CONFIRM_LABEL_MARKET} value={proposal.symbol} />
            <Row
              label={CONFIRM_LABEL_LEVERAGE}
              value={confirmTransition(
                `${proposal.current.leverageDisplay}x`,
                `${proposal.target.leverageDisplay}x`,
              )}
            />
            <Row
              label={CONFIRM_LABEL_MODE}
              value={confirmTransition(
                proposal.current.marginMode,
                proposal.target.marginMode,
              )}
            />
            <Row
              label={CONFIRM_LABEL_POSITION}
              value={
                proposal.openPosition === null
                  ? CONFIRM_NO_POSITION
                  : confirmPositionLine(
                      proposal.openPosition.side,
                      proposal.openPosition.size,
                      proposal.symbol,
                    )
              }
            />
            <Row
              label={CONFIRM_LABEL_LIQUIDATION}
              // Null is what main sends for an account Lighter reports no
              // liquidation price for. It reads as "Not reported", never as a
              // number the person could mistake for a real level.
              value={
                proposal.observations.liquidationPrice === null
                  ? CONFIRM_UNKNOWN
                  : `${proposal.observations.liquidationPrice} ${quoteUnit}`
              }
            />
            <Row
              label={CONFIRM_LABEL_ORDERS}
              value={confirmOrdersLine(proposal.observations.openOrders.count)}
            />
            <Row
              label={CONFIRM_LABEL_ACCOUNT}
              value={`${proposal.walletAddress} - account ${proposal.accountIndex}`}
            />
          </dl>
          <p className="text-[12px] leading-[18px] text-ink-tertiary">
            {CONFIRM_OBSERVATION_NOTE}
          </p>
          {submitting ? (
            <p role="status" aria-live="polite" className="text-[12px] leading-[18px] text-ink-secondary">
              {CONFIRM_SUBMITTING}
            </p>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={submitting}
            onClick={onCancel}
            data-vex-lighter-leverage-confirm-cancel
            {...DIALOG_INITIAL_FOCUS}
          >
            {CONFIRM_CANCEL}
          </Button>
          <Button
            variant="primary"
            disabled={submitting}
            onClick={() => onConfirm(proposal.proposalId)}
            data-vex-lighter-leverage-confirm-submit
          >
            {CONFIRM_CONFIRM}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <dt className="text-ink-secondary">{label}</dt>
      <dd className="text-right font-mono text-[12px] leading-[18px] text-ink-primary">
        {value}
      </dd>
    </div>
  );
}
