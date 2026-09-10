import type { Result } from "@shared/ipc/result.js";
import type {
  ForgetLighterCredentialConnectionInput,
  ForgetLighterCredentialConnectionResult,
  InspectLighterCredentialConnectionsResult,
} from "@shared/schemas/lighter-integration.js";

export async function inspectStoredLighterConnections(): Promise<
  Result<InspectLighterCredentialConnectionsResult>
> {
  return window.vex.settings.inspectLighterCredentialConnections();
}

export async function forgetStoredLighterConnection(
  input: ForgetLighterCredentialConnectionInput,
): Promise<Result<ForgetLighterCredentialConnectionResult>> {
  return window.vex.settings.forgetLighterCredentialConnection(input);
}
