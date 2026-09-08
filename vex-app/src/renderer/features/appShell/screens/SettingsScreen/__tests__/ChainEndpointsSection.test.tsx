import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChainEndpointsSection } from "../ChainEndpointsSection.js";
const getChainEndpoints = vi.fn();
const setChainEndpoints = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "vex", { configurable: true, value: { settings: { getChainEndpoints, setChainEndpoints } } });
  getChainEndpoints.mockResolvedValue({ ok: true, data: { chainId: 4663, rpcUrl: null, blockscoutBaseUrl: null } });
});
afterEach(cleanup);
it("loads defaults and saves both per-chain endpoints together", async () => {
  setChainEndpoints.mockResolvedValue({ ok: true });
  render(<ChainEndpointsSection />);
  await waitFor(() => expect((screen.getByRole("button", { name: "Save endpoints" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("EVM RPC URL"), { target: { value: "http://localhost:8545" } });
  fireEvent.change(screen.getByLabelText("Blockscout base URL"), { target: { value: "https://proxy.example/rhc" } });
  fireEvent.click(screen.getByRole("button", { name: "Save endpoints" }));
  await waitFor(() => expect(setChainEndpoints).toHaveBeenCalledWith({ chainId: 4663, rpcUrl: "http://localhost:8545", blockscoutBaseUrl: "https://proxy.example/rhc" }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "Saved. The next chain read uses these endpoints.");
});
it("surfaces the named invalid-override refusal from main", async () => {
  setChainEndpoints.mockResolvedValue({ ok: false, error: { message: "BLOCKSCOUT_OVERRIDE_INVALID: Use HTTPS or loopback HTTP." } });
  render(<ChainEndpointsSection />);
  await waitFor(() => expect((screen.getByRole("button", { name: "Save endpoints" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Save endpoints" }));
  expect((await screen.findByRole("status")).textContent).toContain("BLOCKSCOUT_OVERRIDE_INVALID");
});
it("a failed read cannot overwrite existing endpoints with empty defaults", async () => {
  getChainEndpoints.mockResolvedValue({ ok: false, error: { message: "Read failed" } });
  render(<ChainEndpointsSection />);
  await screen.findByRole("status");
  expect((screen.getByRole("button", { name: "Save endpoints" }) as HTMLButtonElement).disabled).toBe(true);
  expect(setChainEndpoints).not.toHaveBeenCalled();
});
