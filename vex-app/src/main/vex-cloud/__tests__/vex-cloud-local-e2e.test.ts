/**
 * LOCAL END TO END against a running VexVirtualsCompute gateway (phase 1b).
 *
 * GATED: runs only when `VEX_CLOUD_E2E_URL` names the gateway origin (for
 * example `http://localhost:8787`, which must equal the gateway's
 * `SIWE_URI`) and `VEX_CLOUD_E2E_BACKEND_DIR` points at its checkout (used
 * for one `pnpm admin:credit`). Start the gateway as its
 * `docs/environments.md` describes, with `VIRTUALS_UPSTREAM=fake`.
 *
 * REAL: the `vexCloud` IPC handlers through `registerHandler`, the sign-in
 * owner, the HTTP client, the strict EIP-4361 template signer with a keystore
 * on disk, the gateway (auth, ledger, registry, proxy, metering), and the
 * engine's `OpenRouterProvider` in Vex Cloud mode through the dev override.
 * FAKED: Electron and the vault (the session goes to memory and the env
 * mirror, as the vault would put it), and upstream inference (the gateway's
 * own recorded replays).
 *
 * The wallet is generated per run and never holds anything.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";

const E2E_URL = process.env.VEX_CLOUD_E2E_URL;
const BACKEND_DIR = process.env.VEX_CLOUD_E2E_BACKEND_DIR;
const REPORT = process.env.VEX_CLOUD_E2E_REPORT;
const enabled = E2E_URL !== undefined && BACKEND_DIR !== undefined;

const { testDir } = vi.hoisted(() => {
  const { join } = require("node:path");
  const { tmpdir: tmp } = require("node:os");
  return { testDir: join(tmp(), `vex-cloud-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`) };
});

vi.mock("@config/paths.js", () => ({
  CONFIG_DIR: testDir,
  CONFIG_FILE: `${testDir}/config.json`,
  KEYSTORE_FILE: `${testDir}/keystore.json`,
  SOLANA_KEYSTORE_FILE: `${testDir}/solana-keystore.json`,
  BACKUPS_DIR: `${testDir}/backups`,
  ENV_FILE: `${testDir}/.env`,
  SECRETS_VAULT_FILE: `${testDir}/secrets.vault.json`,
}));
vi.mock("@utils/env.js", () => ({
  requireKeystorePassword: () => "e2e-throwaway-password",
  getKeystorePassword: () => "e2e-throwaway-password",
}));

const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));
vi.mock("../../ipc/sender-validation.js", () => ({ assertTrustedSender: () => undefined }));
vi.mock("../../logger/index.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../production.js", () => ({
  productionVexCloudDeps: () => {
    throw new Error("the e2e builds its own deps");
  },
}));

interface Report {
  readonly steps: Array<Record<string, unknown>>;
}
const report: Report = { steps: [] };

interface Amount {
  readonly wei: string;
  readonly usdMicroEstimate: string | null;
}
interface IpcData {
  readonly created: boolean;
  readonly linkedNow: readonly string[];
  readonly state: string;
  readonly reason: string;
  readonly account: { readonly balances: { readonly available: Amount; readonly reserved: Amount } };
}

async function call(channel: string, payload: unknown): Promise<{ readonly ok: boolean; readonly data: IpcData }> {
  const fn = handlers.get(channel);
  if (fn === undefined) throw new Error(`no handler ${channel}`);
  return (await fn({ sender: {} }, { requestId: crypto.randomUUID(), payload })) as { ok: boolean; data: IpcData };
}

describe.skipIf(!enabled)("Vex Cloud, local end to end", () => {
  let session: string | null = null;
  let walletAddress = "";
  let CH: (typeof import("@shared/ipc/channels.js"))["CH"];

  beforeAll(async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(path.join(testDir, "config.json"), "{}");
    process.env.VEX_DEV_CLOUD_API_URL = E2E_URL;
    process.env.AGENT_PROVIDER = "vexcloud";
    process.env.AGENT_MODEL = "anthropic/claude-haiku-5.5";
    const endpoint = await import("@vex-lib/vex-cloud-endpoint.js");
    endpoint.allowVexCloudDevOverride(true);
    ({ CH } = await import("@shared/ipc/channels.js"));
    const { openExecutionGate } = await import("../../lifecycle/execution-gate.js");
    openExecutionGate();
    const { importEvmWalletEntry } = await import("@tools/wallet/inventory-create.js");
    const { listWallets } = await import("@tools/wallet/inventory.js");
    const { signVexCloudSiweMessage } = await import("@tools/wallet/siwe-signing.js");
    const { createVexCloudApi } = await import("../api-client.js");
    const { registerVexCloudHandlers } = await import("../../ipc/vex-cloud.js");
    const { resetProvider } = await import("@vex-agent/inference/registry.js");
    const { getAddress } = await import("viem");

    const entry = await importEvmWalletEntry(generatePrivateKey());
    walletAddress = getAddress(entry.address);
    const store = async (token: string | null) => {
      session = token;
      if (token === null) delete process.env.VEX_CLOUD_SESSION_TOKEN;
      else process.env.VEX_CLOUD_SESSION_TOKEN = token;
      resetProvider();
      return { ok: true as const, data: undefined };
    };
    registerVexCloudHandlers({
      api: createVexCloudApi(),
      signIn: {
        listEvmWallets: () => listWallets("evm"),
        isVaultUnlocked: () => true,
        signMessage: signVexCloudSiweMessage,
        binding: () => endpoint.vexCloudSiweBinding(),
        storeSession: (token) => store(token),
        now: () => new Date(),
      },
      account: {
        readSession: async () => ({ ok: true as const, data: session }),
        clearSession: () => store(null),
        localWallets: () => listWallets("evm").map((w) => getAddress(w.address)),
        pinnedDepositAddress: () => null,
        now: () => new Date(),
      },
      clearSession: () => store(null),
      deposit: {
        chain: () => {
          throw new Error("deposits are not exercised against the local gateway in this suite");
        },
        listEvmWallets: () => listWallets("evm"),
        isVaultUnlocked: () => true,
        isExecutionReady: () => true,
        pinnedDepositAddress: () => null,
        loadPrivateKey: async () => {
          throw new Error("deposits are not exercised against the local gateway in this suite");
        },
        now: () => new Date(),
      },
      withdrawalOrigins: (await import("./support/funding-fakes.js")).memoryWithdrawalOrigins(() => new Date()).guard,
    });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
    if (REPORT !== undefined) writeFileSync(REPORT, JSON.stringify(report, null, 2));
  });

  it("signs in (creates the account), is credited, streams with thinking, round-trips a tool, and is charged", async () => {
    // 1. Sign in: a fresh wallet has no account, so the flow creates one.
    const signedIn = await call(CH.vexCloud.signIn, { wallets: [walletAddress] });
    expect(signedIn.ok).toBe(true);
    expect(signedIn.data.created).toBe(true);
    expect(session).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    report.steps.push({ step: "signIn", created: signedIn.data.created, linkedNow: signedIn.data.linkedNow.length, wallet: walletAddress });

    // 2. Credit 1000 VEX to the new account (local admin tool, test wallet only).
    execFileSync("pnpm", ["admin:credit", "--", "--address", walletAddress, "--vex", "1000", "--key", `e2e-${Date.now()}`], {
      cwd: BACKEND_DIR,
      stdio: "pipe",
    });
    const before = await call(CH.vexCloud.account, {});
    expect(before.data.state).toBe("signed_in");
    const availableBefore = BigInt(before.data.account.balances.available.wei);
    expect(availableBefore).toBe(1000n * 10n ** 18n);
    report.steps.push({ step: "credited", availableWei: availableBefore.toString(), usdMicro: before.data.account.balances.available.usdMicroEstimate });

    // 3. The engine in Vex Cloud mode: catalogue from /v1/models.
    const { OpenRouterProvider } = await import("@vex-agent/inference/openrouter.js");
    const { inferenceNoticeBus } = await import("@vex-agent/inference/inference-notice-bus.js");
    const notices: unknown[] = [];
    const off = inferenceNoticeBus.subscribe((event) => notices.push(event));
    const provider = new OpenRouterProvider();
    expect(provider.id).toBe("vexcloud");
    const config = await provider.loadConfig();
    if (config === null) throw new Error("no config from /v1/models");
    expect(config.reasoningSupport?.efforts).not.toContain("none");
    expect(config.reasoningEffortDefault).toBe("medium");
    report.steps.push({ step: "models", efforts: config.reasoningSupport?.efforts, defaultEffort: config.reasoningEffortDefault });

    const context = { sessionId: "3f0d2f7a-1c2b-4b3c-8d4e-5f6a7b8c9d0e", missionRunId: null };
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "get_time",
          description: "Return the current time.",
          parameters: { type: "object" as const, properties: {}, additionalProperties: false },
        },
      },
    ];

    // 4. One streamed chat with thinking (the gateway replays a recorded
    //    reasoning stream for this marker) and tools on the request.
    const kinds = new Map<string, number>();
    let text = "";
    let reasoning = "";
    for await (const chunk of provider.chatCompletionStream(
      [{ role: "user", content: "What time is it? fake-scenario=venice-reasoning" }],
      tools,
      config,
      new AbortController().signal,
      context,
    )) {
      kinds.set(chunk.type, (kinds.get(chunk.type) ?? 0) + 1);
      if (chunk.type === "content") text += chunk.text ?? "";
      if (chunk.type === "reasoning") reasoning += chunk.reasoningText ?? "";
    }
    expect(kinds.get("reasoning") ?? 0).toBeGreaterThan(0);
    // The recorded reasoning stream ends in a streamed tool call.
    expect(kinds.get("tool_call_delta") ?? 0).toBeGreaterThan(0);
    expect(kinds.get("done")).toBe(1);
    report.steps.push({ step: "stream", chunkKinds: Object.fromEntries(kinds), reasoningChars: reasoning.length, contentChars: text.length });

    // 5. The tool round trip: the assistant's tool call and its result go
    //    back through the gateway, which bills and answers.
    const followUp: string[] = [];
    for await (const chunk of provider.chatCompletionStream(
      [
        { role: "user", content: "What time is it?" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_e2e_1", command: "get_time", args: {} }] },
        { role: "tool", content: JSON.stringify({ time: "12:00 UTC" }), toolCallId: "call_e2e_1" },
      ],
      tools,
      config,
      new AbortController().signal,
      context,
    )) {
      followUp.push(chunk.type);
    }
    expect(followUp).toContain("done");
    report.steps.push({ step: "toolRoundTrip", chunkKinds: [...new Set(followUp)] });

    // 6. D16: ask far above the model's per-effort ceiling; the gateway
    //    clamps and says so, and the engine turns it into a notice.
    await provider.chatCompletion([{ role: "user", content: "Say ok." }], [], { ...config, maxOutputTokens: 200_000 }, context);
    expect(notices).toEqual([expect.objectContaining({ kind: "max_tokens_clamped", reason: "model_limit", sessionId: context.sessionId })]);
    report.steps.push({ step: "d16", notice: notices[0] });
    off();

    // 7. The balance went down by what was charged (settlement runs after
    //    the response, so read until nothing is reserved).
    let after = await call(CH.vexCloud.account, {});
    for (let attempt = 0; attempt < 40 && after.data.account.balances.reserved.wei !== "0"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      after = await call(CH.vexCloud.account, {});
    }
    const availableAfter = BigInt(after.data.account.balances.available.wei);
    expect(after.data.account.balances.reserved.wei).toBe("0");
    expect(availableAfter).toBeLessThan(availableBefore);
    report.steps.push({
      step: "charged",
      availableBeforeWei: availableBefore.toString(),
      availableAfterWei: availableAfter.toString(),
      chargedWei: (availableBefore - availableAfter).toString(),
    });
  }, 120_000);

  it("a dead session leaves a clean signed-out state", async () => {
    session = "vxs_this_session_never_existed_000";
    const read = await call(CH.vexCloud.account, {});
    expect(read.data).toMatchObject({ state: "signed_out", reason: "session_expired" });
    expect(session).toBeNull();
    report.steps.push({ step: "deadSession", state: read.data.state, reason: read.data.reason });
  });
});
