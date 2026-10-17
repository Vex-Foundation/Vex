/**
 * The token toggle's button (`K2TokenButton.tsx`). Regressions this catches: a button that is not a
 * native button (no Enter or Space), a name that changes with its state (read as "Show Vex,
 * pressed") or a state not carried by `aria-pressed`, a press that does not reach its caller, a box
 * that is not where the caller placed it, and a target smaller than 44 px round a small coin.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { K2TokenButton, TOKEN_BUTTON_NAME, TOKEN_TARGET_MIN, targetBox } from "../K2TokenButton.js";

describe("K2TokenButton", () => {
  it("is a native button named Hide Vex in both states, its state in aria-pressed", () => {
    const { rerender } = render(<K2TokenButton tokenOnly={false} onPress={() => undefined} />);
    const button = screen.getByRole("button", { name: TOKEN_BUTTON_NAME });
    expect(TOKEN_BUTTON_NAME).toBe("Hide Vex");
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    rerender(<K2TokenButton tokenOnly onPress={() => undefined} />);
    expect(screen.getByRole("button", { name: "Hide Vex", pressed: true })).toBe(button);
    expect(screen.queryByRole("button", { name: /show vex/i })).toBeNull();
  });

  it("a press reaches its caller, and the caller's box and class place it", () => {
    const onPress = vi.fn();
    render(
      <K2TokenButton
        tokenOnly={false}
        onPress={onPress}
        className="vex-welcome__token"
        style={{ left: 130, top: 226, width: 60, height: 58 }}
      />,
    );
    const button = screen.getByRole("button", { name: "Hide Vex" });
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(button.className).toBe("vex-welcome__token");
    expect(button.style.left).toBe("130px");
    expect(button.style.height).toBe("58px");
  });

  it("the target grows round the coin's centre to at least 44 px, never shrinks a larger one", () => {
    expect(TOKEN_TARGET_MIN).toBe(44);
    expect(targetBox({ left: 145, top: 250, right: 175, bottom: 270 })).toEqual({
      left: 138,
      top: 238,
      right: 182,
      bottom: 282,
    });
    const big = { left: 100, top: 200, right: 160, bottom: 260 };
    expect(targetBox(big)).toEqual(big);
  });
});
