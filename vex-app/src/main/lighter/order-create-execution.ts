import { getLighterClient } from "@tools/lighter/client.js";
import { createLighterSignerBinaryAdapter } from "@tools/lighter/signer-binary-adapter.js";
import {
  configureLighterCreateOrderExecutionDeps,
  defaultLighterCreateOrderExecutionDeps,
} from "@vex-agent/tools/protocols/lighter/order-create-execution.js";
import { createUnlockedVaultLighterTradingSecretReader } from "../secrets/lighter-trading-credential.js";

export function installLighterOrderCreateExecutionDeps(): () => void {
  return configureLighterCreateOrderExecutionDeps(
    defaultLighterCreateOrderExecutionDeps({
      secretReader: createUnlockedVaultLighterTradingSecretReader(),
      signer: createLighterSignerBinaryAdapter(),
      client: getLighterClient(),
    }),
  );
}
