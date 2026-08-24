/**
 * Greeting pools - bucket seams (4/5, 11/12, 17/18, midnight wrap), the
 * eligibility invariants of the name/nameless draw, deterministic index
 * selection from the injected rand, and {name} substitution.
 */

import { describe, expect, it } from "vitest";
import {
  AFTERNOON_GREETINGS,
  EVENING_GREETINGS,
  MORNING_GREETINGS,
  greetingForHour,
  greetingPoolForHour,
  pickGreeting,
} from "../greeting.js";

const ALL_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** Rands hitting every index of a 4-variant pool, plus both edges. */
const RAND_SWEEP = [0, 0.24, 0.25, 0.5, 0.75, 0.999] as const;

describe("greetingForHour bucket seams", () => {
  it("flips Evening to Morning exactly at 5 (4 is still Evening)", () => {
    expect(greetingForHour(4)).toBe("Evening");
    expect(greetingForHour(5)).toBe("Morning");
  });

  it("flips Morning to Afternoon exactly at 12 (11 is still Morning)", () => {
    expect(greetingForHour(11)).toBe("Morning");
    expect(greetingForHour(12)).toBe("Afternoon");
  });

  it("flips Afternoon to Evening exactly at 18 (17 is still Afternoon)", () => {
    expect(greetingForHour(17)).toBe("Afternoon");
    expect(greetingForHour(18)).toBe("Evening");
  });

  it("Evening wraps through midnight - 23, 0 and 4 all draw from the evening pool", () => {
    expect(greetingPoolForHour(23)).toBe(EVENING_GREETINGS);
    expect(greetingPoolForHour(0)).toBe(EVENING_GREETINGS);
    expect(greetingPoolForHour(4)).toBe(EVENING_GREETINGS);
    expect(greetingPoolForHour(5)).toBe(MORNING_GREETINGS);
    expect(greetingPoolForHour(12)).toBe(AFTERNOON_GREETINGS);
  });
});

describe("pickGreeting eligibility", () => {
  it("a null displayName never yields a name variant, at any hour or rand", () => {
    for (const hour of ALL_HOURS) {
      const namelessTexts = greetingPoolForHour(hour)
        .filter((variant) => !variant.withName)
        .map((variant) => variant.text);
      for (const rand of RAND_SWEEP) {
        const picked = pickGreeting(hour, null, rand);
        expect(namelessTexts).toContain(picked);
        expect(picked).not.toContain("{name}");
      }
    }
  });

  it("a blank displayName counts as unset - same nameless-only draw", () => {
    expect(pickGreeting(9, "   ", 0)).toBe("Morning. DeFi time?");
  });

  it("a set displayName makes the WHOLE bucket eligible - nameless lines still appear", () => {
    // Afternoon pool order: name, nameless, name, nameless - rand 0.25 lands
    // on index 1, a nameless line, even though a name is set.
    expect(pickGreeting(13, "desu", 0.25)).toBe("Afternoon.");
    expect(pickGreeting(13, "desu", 0.75)).toBe("What are we executing?");
  });
});

describe("pickGreeting index selection", () => {
  it("rand 0 picks the first eligible variant", () => {
    expect(pickGreeting(9, "desu", 0)).toBe("Morning, desu");
  });

  it("rand at the last index boundary picks the final variant", () => {
    // 4 eligible variants: [0.75, 1) is the final index's band.
    expect(pickGreeting(9, "desu", 0.75)).toBe("Morning moves?");
    expect(pickGreeting(9, "desu", 0.999)).toBe("Morning moves?");
    // Nameless draw has 2 eligible variants: [0.5, 1) is the final band.
    expect(pickGreeting(9, null, 0.5)).toBe("Morning moves?");
    expect(pickGreeting(9, null, 0.49)).toBe("Morning. DeFi time?");
  });

  it("an out-of-range rand clamps to the pool edges instead of throwing", () => {
    expect(pickGreeting(9, "desu", 1)).toBe("Morning moves?");
    expect(pickGreeting(9, "desu", -0.5)).toBe("Morning, desu");
  });
});

describe("pickGreeting {name} substitution", () => {
  it("substitutes the trimmed displayName into every name variant's placeholder", () => {
    expect(pickGreeting(9, " desu ", 0.25)).toBe("gm, desu");
    expect(pickGreeting(13, "desu", 0.5)).toBe("Vexing, desu?");
    expect(pickGreeting(20, "desu", 0.5)).toBe("Vexing tonight, desu?");
  });
});
