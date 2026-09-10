import type { ToolResult } from "../../types.js";
import type { BoundDebitPlan } from "./debit-plan.js";

/** Echo the authority, including on prose-only settlement outcomes, without changing success. */
export function withApprovedGasFees(result: ToolResult, plan: BoundDebitPlan): ToolResult {
  const approvedGasFees = {
    unit: "wei/gas",
    feeHeadroomBps: plan.feeHeadroomBps ?? 0,
    legs: plan.legs.map(({ role, feeCap }) => ({ role, feeCap })),
    gasUnits: "freshly estimated; no fixed total gas bill",
  };
  let payload: unknown;
  try { payload = JSON.parse(result.output); } catch { /* Prose results remain prose. */ }
  return {
    ...result,
    output: typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? JSON.stringify({ ...payload, approvedGasFees }, null, 2)
      : `${result.output}\nApproved gas fee ceilings: ${JSON.stringify(approvedGasFees)}`,
    data: { ...result.data, approvedGasFees },
  };
}
