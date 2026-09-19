/**
 * Same-process handoff for Desk settlement writes that could not reach the DB.
 * The scheduled approval sweep retries only this terminal write; it never has
 * enough authority to run the approved tool again.
 */

export interface DeskSettlementRepair {
  readonly approvalId: string;
  readonly resultHash: string;
}

const pending = new Map<string, DeskSettlementRepair>();

export function registerDeskSettlementRepair(repair: DeskSettlementRepair): void {
  pending.set(repair.approvalId, repair);
}

export function listDeskSettlementRepairs(): readonly DeskSettlementRepair[] {
  return [...pending.values()];
}

export function finishDeskSettlementRepair(approvalId: string): void {
  pending.delete(approvalId);
}

export function deskSettlementRepairCount(): number {
  return pending.size;
}

/** Test seam; production entries otherwise live until a sweep or process exit. */
export function resetDeskSettlementRepairsForTests(): void {
  pending.clear();
}
