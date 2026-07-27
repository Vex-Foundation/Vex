/**
 * ActivityBadge — the ONE activity-vocabulary chip grammar for the shell
 * (Agent Scan renderer round). Replaces the three inlined stamp grammars that
 * used to live in TokenHistoryScreen, MovesBlock, and nowhere else reusable.
 *
 * Pins:
 *   - every kind renders its own label inside ONE solid accent chip — the
 *     owner-decreed treatment (the PREDICT chip, applied everywhere); a future
 *     edit cannot quietly reintroduce the rejected pale outline variants;
 *   - `eventRole` renders as the badge's second segment (`LEND·DEPOSIT`);
 *   - TOLERANT READER: an unknown kind, an unknown role, and an unknown
 *     status all render their raw value neutrally — the badge NEVER blanks on
 *     vocabulary it has not seen (a server that ships a new activity kind must
 *     not produce an empty row);
 *   - hostile/overlong vocabulary is bounded before it reaches the layout;
 *   - status follows the shell's existing "quiet unless it needs attention"
 *     posture: pending/failed render a chip, confirmed and null render none.
 */

import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import {
  AGENT_ACTIVITY_EVENT_ROLES,
  FEED_ACTIVITY_KINDS,
} from "@shared/agent-activity-vocabulary.js";
import { ActivityBadge } from "../ActivityBadge.js";

afterEach(() => {
  cleanup();
});

describe("ActivityBadge — kind vocabulary", () => {
  it.each([
    ["swap", "SWAP"],
    ["bridge", "BRIDGE"],
    ["lend", "LEND"],
    ["prediction", "PREDICT"],
    ["wrap", "WRAP"],
    ["transfer", "TRANSFER"],
    ["activity", "ACTIVITY"],
  ])("renders the known kind %s as %s", (kind, label) => {
    render(<ActivityBadge kind={kind} eventRole={null} status={null} />);
    expect(screen.getByText(label)).not.toBeNull();
  });

  it("covers every kind the shared feed vocabulary can carry", () => {
    for (const kind of FEED_ACTIVITY_KINDS) {
      render(<ActivityBadge kind={kind} eventRole={null} status={null} />);
      // A known kind never falls through to its own raw lower-case text.
      expect(screen.queryByText(kind)).toBeNull();
      cleanup();
    }
  });

  it("wears ONE solid accent fill for every kind (owner decree: the PREDICT chip everywhere)", () => {
    const treatments = new Set<string>();
    for (const kind of [...FEED_ACTIVITY_KINDS, "perps_unknown"]) {
      const { container } = render(
        <ActivityBadge kind={kind} eventRole={null} status={null} />,
      );
      const chip = container.querySelector("span");
      expect(chip).not.toBeNull();
      const className = chip?.className ?? "";
      // Solid accent fill + contrast ink — never a pale outline-only chip.
      expect(className).toContain("bg-[var(--vex-accent)]");
      expect(className).toContain("text-[var(--vex-accent-contrast)]");
      treatments.add(className);
      cleanup();
    }
    // Identical on every kind, including an unknown one: the WORD carries the
    // kind, the treatment never varies.
    expect(treatments.size).toBe(1);
  });

  it("renders an UNKNOWN kind as its raw uppercased value — never blank (tolerant reader)", () => {
    render(<ActivityBadge kind="perp_close" eventRole={null} status={null} />);
    expect(screen.getByText("PERP_CLOSE")).not.toBeNull();
  });

  it("renders the neutral ACTIVITY fallback when the kind is null or empty", () => {
    render(<ActivityBadge kind={null} eventRole={null} status={null} />);
    expect(screen.getByText("ACTIVITY")).not.toBeNull();
    cleanup();
    render(<ActivityBadge kind="   " eventRole={null} status={null} />);
    expect(screen.getByText("ACTIVITY")).not.toBeNull();
  });
});

describe("ActivityBadge — event role segment", () => {
  // The DB roles are kind-PREFIXED (`lend_deposit`); the prefix is dropped in
  // the badge because the kind segment already carries it.
  it.each([
    ["lend", "lend_deposit", "LEND·DEPOSIT"],
    ["lend", "lend_withdraw", "LEND·WITHDRAW"],
    ["lend", "lend_borrow_operate", "LEND·BORROW"],
    ["prediction", "predict_buy", "PREDICT·BUY"],
    ["prediction", "predict_sell", "PREDICT·SELL"],
    ["prediction", "predict_claim", "PREDICT·CLAIM"],
    ["prediction", "predict_close", "PREDICT·CLOSE"],
    ["bridge", "bridge_fee", "BRIDGE·FEE"],
    ["bridge", "bridge_deposit", "BRIDGE·DEPOSIT"],
    ["bridge", "bridge_fill_expected", "BRIDGE·FILL"],
    ["bridge", "bridge_refund", "BRIDGE·REFUND"],
    ["swap", "allowance", "SWAP·ALLOWANCE"],
    ["wrap", "unwrap", "WRAP·UNWRAP"],
  ])("renders %s + %s as %s", (kind, role, expected) => {
    render(<ActivityBadge kind={kind} eventRole={role} status={null} />);
    expect(screen.getByText(expected)).not.toBeNull();
  });

  it("omits a role that only repeats its own kind (no SWAP·SWAP)", () => {
    render(<ActivityBadge kind="swap" eventRole="swap" status={null} />);
    expect(screen.getByText("SWAP")).not.toBeNull();
    cleanup();
    render(<ActivityBadge kind="wrap" eventRole="wrap" status={null} />);
    expect(screen.getByText("WRAP")).not.toBeNull();
  });

  it("renders an UNKNOWN role as its raw uppercased value rather than dropping it", () => {
    render(<ActivityBadge kind="lend" eventRole="rollover" status={null} />);
    expect(screen.getByText("LEND·ROLLOVER")).not.toBeNull();
  });

  it("resolves a role LONGER than the display bound (regression: the bound must not clamp before the lookup)", () => {
    // `bridge_fill_expected` is 20 chars — longer than the 16-char display
    // bound. Clamping before the known-value lookup turned this legitimate
    // role into raw `BRIDGE_FILL_EXPE` text.
    render(
      <ActivityBadge
        kind="bridge"
        eventRole="bridge_fill_expected"
        status={null}
      />,
    );
    expect(screen.getByText("BRIDGE·FILL")).not.toBeNull();
    expect(screen.queryByText(/BRIDGE_FILL_EXPE/)).toBeNull();
  });

  it("covers every event role the shared vocabulary can carry", () => {
    for (const role of AGENT_ACTIVITY_EVENT_ROLES) {
      const { container } = render(
        <ActivityBadge kind="swap" eventRole={role} status={null} />,
      );
      // Every known role has a curated label, so no badge may leak the raw
      // snake_case identifier — that is what an UNRESOLVED role looks like.
      expect(container.textContent ?? "").not.toContain("_");
      cleanup();
    }
  });

  it("omits the segment entirely for a null or blank role", () => {
    render(<ActivityBadge kind="lend" eventRole="  " status={null} />);
    expect(screen.getByText("LEND")).not.toBeNull();
  });

  it("bounds hostile/overlong vocabulary before it reaches the layout", () => {
    render(
      <ActivityBadge
        kind={"k".repeat(200)}
        eventRole={"r".repeat(200)}
        status={null}
      />,
    );
    const chip = screen.getByText(/^K+·R+$/);
    // Bounded on BOTH segments — an unbounded provider string must never be
    // able to stretch a 9px chip across the row.
    const [kindText, roleText] = (chip.textContent ?? "").split("·");
    expect(kindText?.length).toBeLessThanOrEqual(16);
    expect(roleText?.length).toBeLessThanOrEqual(16);
  });
});

describe("ActivityBadge — status", () => {
  it("renders a PENDING chip", () => {
    render(<ActivityBadge kind="swap" eventRole={null} status="pending" />);
    expect(screen.getByText("PENDING")).not.toBeNull();
  });

  it("renders a FAILED chip, carrying the failure reason as its tooltip", () => {
    render(
      <ActivityBadge
        kind="swap"
        eventRole={null}
        status="failed"
        statusTitle="slippage"
      />,
    );
    const chip = screen.getByText("FAILED");
    expect(chip.getAttribute("title")).toBe("slippage");
  });

  it("stays QUIET for confirmed and null status (the shell's existing posture)", () => {
    render(<ActivityBadge kind="swap" eventRole={null} status="confirmed" />);
    expect(screen.queryByText("CONFIRMED")).toBeNull();
    cleanup();
    render(<ActivityBadge kind="swap" eventRole={null} status={null} />);
    expect(screen.queryByText("CONFIRMED")).toBeNull();
    expect(screen.queryByText("PENDING")).toBeNull();
    expect(screen.queryByText("FAILED")).toBeNull();
  });

  it("surfaces an UNKNOWN status verbatim rather than swallowing it", () => {
    render(<ActivityBadge kind="swap" eventRole={null} status="reverted" />);
    expect(screen.getByText("REVERTED")).not.toBeNull();
  });

  it("gives pending and failed DIFFERENT tones (amber vs danger)", () => {
    const { container: pendingBox } = render(
      <ActivityBadge kind="swap" eventRole={null} status="pending" />,
    );
    const pending = pendingBox.querySelectorAll("span")[1]?.className ?? "";
    cleanup();
    const { container: failedBox } = render(
      <ActivityBadge kind="swap" eventRole={null} status="failed" />,
    );
    const failed = failedBox.querySelectorAll("span")[1]?.className ?? "";
    expect(pending).not.toBe(failed);
    expect(pending).toContain("warning");
    expect(failed).toContain("destructive");
  });
});
