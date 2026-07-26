/**
 * `program-error-reason` — recovering an on-chain program's OWN failure text
 * from a rejected Solana submit.
 *
 * The defect this closes: web3.js renders a `SendTransactionError` as prose
 * with the program logs embedded as a JSON array, and the repo's scrub boundary
 * replaces any balanced `[…]`/`{…}` span with `[body]` — deleting the only
 * place the program's error NAME appeared. The 200-char cap then spends the
 * tail on "Catch the `SendTransactionError` and call `getLogs()`", a method
 * this process cannot call. The agent is left with `custom program error:
 * 0x1773` and nothing in this tree decodes Anchor error numbers.
 *
 * The log strings below are the shapes `anchor-lang` actually emits through
 * `msg!` (`AnchorError occurred. …`, and the account-constraint variant
 * `AnchorError caused by account: …`), wrapped in the runtime's `Program log:`
 * prefix exactly as they appear in `meta.logMessages`.
 */

import { describe, expect, it } from "vitest";
import { SendTransactionError } from "@solana/web3.js";

import {
  extractProgramErrorMessage,
  solanaProgramErrorReason,
} from "@tools/solana-ecosystem/shared/solana-transaction/program-error-reason.js";

/** The Jupiter Lend Earn dust rejection, as the cluster reports it. */
const EARN_DUST_LOGS = [
  "Program jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc invoke [1]",
  "Program log: Instruction: Deposit",
  "Program log: AnchorError occurred. Error Code: FTokenDepositInsignificant. Error Number: 6003. Error Message: Deposit amount is too small.",
  "Program jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc consumed 12345 of 200000 compute units",
  "Program jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc failed: custom program error: 0x1773",
];

describe("extractProgramErrorMessage", () => {
  it("lifts the program's own sentence out of an AnchorError log line", () => {
    expect(extractProgramErrorMessage(EARN_DUST_LOGS)).toBe("Deposit amount is too small.");
  });

  it("handles the account-constraint AnchorError variant", () => {
    const logs = [
      "Program log: Instruction: Borrow",
      "Program log: AnchorError caused by account: vault. Error Code: ConstraintRaw. Error Number: 2003. Error Message: A raw constraint was violated.",
    ];
    expect(extractProgramErrorMessage(logs)).toBe("A raw constraint was violated.");
  });

  it("handles the plainer `Program log: Error Message: <text>` form", () => {
    expect(extractProgramErrorMessage(["Program log: Error Message: Debt is below the vault minimum"]))
      .toBe("Debt is below the vault minimum");
  });

  it("returns the FIRST message — with a CPI the inner program's error is the root cause", () => {
    const logs = [
      "Program INNER invoke [2]",
      "Program log: AnchorError occurred. Error Code: InsufficientLiquidity. Error Number: 6010. Error Message: Not enough liquidity in the vault.",
      "Program INNER failed: custom program error: 0x177a",
      "Program log: AnchorError occurred. Error Code: CpiFailed. Error Number: 6001. Error Message: The inner call failed.",
    ];
    expect(extractProgramErrorMessage(logs)).toBe("Not enough liquidity in the vault.");
  });

  it("ignores runtime-authored failure lines that carry no program sentence", () => {
    const logs = [
      "Program jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc invoke [1]",
      "Program jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc failed: custom program error: 0x1773",
    ];
    expect(extractProgramErrorMessage(logs)).toBeUndefined();
  });

  it("returns undefined for absent or empty logs rather than inventing text", () => {
    expect(extractProgramErrorMessage(undefined)).toBeUndefined();
    expect(extractProgramErrorMessage([])).toBeUndefined();
    expect(extractProgramErrorMessage(["Program log: Error Message:   "])).toBeUndefined();
  });
});

describe("solanaProgramErrorReason", () => {
  it("recovers the reason from a real SendTransactionError carrying Anchor logs", () => {
    const err = new SendTransactionError({
      action: "simulate",
      signature: "",
      transactionMessage:
        "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1773",
      logs: EARN_DUST_LOGS,
    });

    expect(solanaProgramErrorReason(err)).toBe("Deposit amount is too small.");
    // The formatted message is exactly what the agent used to be handed: an
    // undecodable hex code plus a bracketed dump the scrub boundary erases.
    expect(err.message).toContain("0x1773");
    expect(err.message).toContain("getLogs()");
  });

  it("returns undefined when the SendTransactionError carries NO logs (degrade unchanged)", () => {
    const err = new SendTransactionError({
      action: "simulate",
      signature: "",
      transactionMessage: "Transaction simulation failed: insufficient funds for rent",
    });
    expect(solanaProgramErrorReason(err)).toBeUndefined();
  });

  it("returns undefined for a non-SendTransactionError throw", () => {
    expect(solanaProgramErrorReason(new Error("ECONNRESET"))).toBeUndefined();
    expect(solanaProgramErrorReason("a string rejection")).toBeUndefined();
    expect(solanaProgramErrorReason(undefined)).toBeUndefined();
  });

  it("never triggers a network round-trip — getLogs is not called on the error path", () => {
    const err = new SendTransactionError({
      action: "simulate",
      signature: "SigThatWouldNeedAnRpcLookup",
      transactionMessage: "Transaction simulation failed",
      logs: EARN_DUST_LOGS,
    });
    let getLogsCalls = 0;
    const originalGetLogs = err.getLogs.bind(err);
    err.getLogs = async (...args: Parameters<typeof originalGetLogs>) => {
      getLogsCalls += 1;
      return originalGetLogs(...args);
    };

    expect(solanaProgramErrorReason(err)).toBe("Deposit amount is too small.");
    expect(getLogsCalls).toBe(0);
  });
});
