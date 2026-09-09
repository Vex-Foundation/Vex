import { loadConfig, saveConfig } from "@config/store.js";
import { validateBlockscoutBaseUrl } from "@config/chain-blockscout-overrides.js";
import { CH } from "@shared/ipc/channels.js";
import { err, ok } from "@shared/ipc/result.js";
import { chainEndpointsSchema, getChainEndpointsInputSchema, setChainEndpointsInputSchema } from "@shared/schemas/chain-endpoints.js";
import { registerHandler } from "./register-handler.js";

export function registerChainEndpointSettingsHandlers(): Array<() => void> {
  return [
    registerHandler({
      channel: CH.settings.getChainEndpoints,
      domain: "settings",
      inputSchema: getChainEndpointsInputSchema,
      outputSchema: chainEndpointsSchema,
      handle: async ({ chainId }) => {
        const config = loadConfig();
        return ok({ chainId, rpcUrl: config.localChainRpcUrls?.[String(chainId)] ?? null,
          blockscoutBaseUrl: config.blockscoutBaseUrls?.[String(chainId)] ?? null });
      },
    }),
    registerHandler({
      channel: CH.settings.setChainEndpoints,
      domain: "settings",
      inputSchema: setChainEndpointsInputSchema,
      outputSchema: chainEndpointsSchema,
      handle: async (input, ctx) => {
        let blockscoutBaseUrl: string | null;
        try {
          blockscoutBaseUrl = input.blockscoutBaseUrl === null ? null : validateBlockscoutBaseUrl(input.blockscoutBaseUrl);
        } catch {
          return err({ code: "validation.invalid_input", domain: "settings", retryable: false,
            userActionable: true, redacted: true, correlationId: ctx.requestId,
            message: "BLOCKSCOUT_OVERRIDE_INVALID: Use HTTPS or loopback HTTP without URL credentials, query parameters or fragments." });
        }
        const rpcUrl = input.rpcUrl?.trim() ?? null;
        if (rpcUrl !== null && !/^https?:\/\/\S+$/i.test(rpcUrl)) {
          return err({ code: "validation.invalid_input", domain: "settings", retryable: false,
            userActionable: true, redacted: true, correlationId: ctx.requestId,
            message: "RPC_OVERRIDE_INVALID: Use an HTTP or HTTPS RPC URL." });
        }
        const config = loadConfig();
        const key = String(input.chainId);
        const localChainRpcUrls = { ...config.localChainRpcUrls };
        const blockscoutBaseUrls = { ...config.blockscoutBaseUrls };
        if (rpcUrl === null) delete localChainRpcUrls[key]; else localChainRpcUrls[key] = rpcUrl;
        if (blockscoutBaseUrl === null) delete blockscoutBaseUrls[key]; else blockscoutBaseUrls[key] = blockscoutBaseUrl;
        saveConfig({ ...config, localChainRpcUrls, blockscoutBaseUrls });
        return ok({ chainId: input.chainId, rpcUrl, blockscoutBaseUrl });
      },
    }),
  ];
}
