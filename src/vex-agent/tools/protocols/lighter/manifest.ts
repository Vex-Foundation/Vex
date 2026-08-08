import type { ProtocolToolManifest } from "../types.js";
import { LIGHTER_READ_TOOLS } from "./manifests/read.js";

export const LIGHTER_TOOLS: readonly ProtocolToolManifest[] = [
  ...LIGHTER_READ_TOOLS,
];
