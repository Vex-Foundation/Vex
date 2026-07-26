import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvState } from "@shared/schemas/onboarding.js";

const { WalletsCard } = await import("../WalletsCard.js");

const EVM_ADDRESS = "0x637d1234567890abcdef1234567890abcdef39C2";
const SOLANA_ADDRESS = "9T9weh1234567890abcdefghijkLmnoPqrstuvbTpE";
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WalletsCard address copy", () => {
  it("copies a public address inline without entering Edit", async () => {
    const onEdit = vi.fn();
    render(
      <WalletsCard
        envState={makeEnvState()}
        onEdit={onEdit}
        editDisabled={false}
      />,
    );

    const copyEvm = screen.getByRole("button", {
      name: "Copy EVM wallet address",
    });
    expect(
      screen.getByRole("button", { name: "Copy Solana wallet address" }),
    ).toBeTruthy();

    fireEvent.click(copyEvm);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(EVM_ADDRESS));
    expect(await screen.findByText("Address copied")).toBeTruthy();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("never renders a private-key export action (export lives only in Settings)", () => {
    render(
      <WalletsCard
        envState={makeEnvState()}
        onEdit={() => {}}
        editDisabled={false}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Copy EVM wallet address" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy Solana wallet address" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Export EVM private key" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Export Solana private key" }),
    ).toBeNull();
  });

  it("does not render a copy action when a wallet address is unavailable", () => {
    render(
      <WalletsCard
        envState={makeEnvState({ evm: null })}
        onEdit={() => {}}
        editDisabled={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Copy EVM wallet address" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Copy Solana wallet address" }),
    ).toBeTruthy();
  });
});

function makeEnvState(
  addresses: Partial<{
    readonly evm: string | null;
    readonly solana: string | null;
  }> = {},
): EnvState {
  return {
    hasKeystorePassword: true,
    hasJupiterApiKey: false,
    apiKeys: {
      jupiterConfigured: false,
      tavilyConfigured: false,
      rettiwtConfigured: false,
    },
    secrets: { vaultConfigured: true, unlocked: true },
    embeddings: {
      configured: true,
      reachable: true,
      baseUrlRedacted: "http://127.0.0.1:27134/v1",
      allFieldsConfigured: true,
      dbReachable: true,
    },
    walletStatus: { evm: "present", solana: "present" },
    walletAddresses: {
      evm: EVM_ADDRESS,
      solana: SOLANA_ADDRESS,
      ...addresses,
    },
    provider: {
      configured: true,
      name: "openrouter",
      modelLabel: "openrouter/auto",
    },
    setupCompleteFlag: true,
  };
}
