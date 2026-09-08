import type { ChainEndpoints } from "@shared/schemas/chain-endpoints.js";
export const getChainEndpoints = (chainId: number) => window.vex.settings.getChainEndpoints({ chainId });
export const setChainEndpoints = (input: ChainEndpoints) => window.vex.settings.setChainEndpoints(input);
