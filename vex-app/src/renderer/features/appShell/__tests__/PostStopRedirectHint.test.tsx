/**
 * `PostStopRedirectHint` — the chat post-stop "do it differently" affordance.
 *
 * It adds no capability (the composer is already ungated on a terminal
 * status), so what is worth testing is that it is CHROME and stays chrome:
 * it appears only after a stop, it hands focus to the composer, it dismisses,
 * and it never touches the send path.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { PostStopRedirectHint } from "../PostStopRedirectHint.js";

describe("PostStopRedirectHint", () => {
  it("offers the redirect framing", () => {
    render(
      <PostStopRedirectHint onRedirect={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(
      screen.getByText(/tell vex what to do differently/i),
    ).not.toBeNull();
  });

  it("hands focus to the composer when the offer is taken", () => {
    const onRedirect = vi.fn();
    render(
      <PostStopRedirectHint onRedirect={onRedirect} onDismiss={vi.fn()} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /do it differently/i }),
    );

    expect(onRedirect).toHaveBeenCalledTimes(1);
  });

  it("is dismissible", () => {
    const onDismiss = vi.fn();
    render(
      <PostStopRedirectHint onRedirect={vi.fn()} onDismiss={onDismiss} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("announces politely — a stop is not an error", () => {
    const { container } = render(
      <PostStopRedirectHint onRedirect={vi.fn()} onDismiss={vi.fn()} />,
    );
    const region = container.querySelector('[data-vex-area="post-stop-redirect"]');
    expect(region?.getAttribute("role")).toBe("status");
  });
});
