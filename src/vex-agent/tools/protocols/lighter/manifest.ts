import type { ProtocolToolManifest } from "../types.js";
import { LIGHTER_READ_TOOLS } from "./manifests/read.js";
import { LIGHTER_WRITE_TOOLS } from "./manifests/write.js";

export const LIGHTER_TOOLS: readonly ProtocolToolManifest[] = [
  ...LIGHTER_READ_TOOLS,
  ...LIGHTER_WRITE_TOOLS,
];
