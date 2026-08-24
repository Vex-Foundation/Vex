/** Stable facade for the static protocol layer and dynamic bridge projection. */

export {
  buildProtocolsPrompt,
  protocolAvailabilityFingerprint,
  resetProtocolsPromptCache,
} from "./protocol-capabilities.js";
export { buildBridgeCapabilityPrompt } from "./bridge-capability.js";
