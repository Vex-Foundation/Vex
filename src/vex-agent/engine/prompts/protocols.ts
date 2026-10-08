/** Stable facade for the static protocol layer and dynamic bridge projection. */

export {
  buildProtocolsPrompt,
  PROTOCOLS_PROMPT_LEAN,
  protocolAvailabilityFingerprint,
  renderProtocolsPrompt,
  resetProtocolsPromptCache,
} from "./protocol-capabilities.js";
export { buildBridgeCapabilityPrompt } from "./bridge-capability.js";
