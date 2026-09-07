/**
 * Image locker (C2) — public entry point.
 *
 * The locker is the GLOBAL, persistent library of pre-staged token-launch
 * images. It exists because an agent filling a launch form has no image, and
 * a Vex launch REQUIRES one (our product rule — the Diamond accepts empty
 * image bytes; we do not), so a FULL-autonomy mission needs images staged
 * ahead of time by a human who is no longer present.
 *
 * Explicit re-exports, no `export *`: the surface below is the contract, and
 * the two things NOT on it are the point.
 *  - `byte-store.ts` is internal. Nothing outside this folder resolves a path
 *    into the locker directory; callers pass an opaque `imageId`.
 *  - raw bytes leave through exactly ONE door, `mountLaunchImageByteResolver`,
 *    into the signing path - two lanes behind that one door since the per-lane
 *    image decision (2026-08-19): the stored ORIGINAL for pools.fun, and the
 *    derived on-chain copy for Trench. Every other consumer (the sidebar card, the
 *    `trench.images` agent tool) sees metadata, or a `data:` URL the locker
 *    itself built.
 */

export {
  deleteLockerImage,
  getLockerImage,
  listLockerImages,
  readLockerImageDataUrl,
  storeLockerImageFromFile,
  type DeleteLockerImageOutcome,
  type LiveIntentReference,
  type StoreImageOutcome,
} from "./locker.js";

export {
  mountLaunchImageByteResolver,
  resolveLockerImageBytesForLaunch,
} from "./byte-resolver.js";

export {
  BOARD_ICON_MAX_BYTES,
  BOARD_ICON_MAX_DIMENSION,
  createBoardIconService,
  mountBoardIconService,
  resolveBoardIcon,
  type BoardIconFetcher,
  type BoardIconResolution,
  type BoardIconService,
} from "./board-icon-service.js";

export {
  deriveLockerImageLabel,
  validateLockerImageBytes,
  type LockerImageRejection,
  type LockerImageValidation,
} from "./image-validation.js";
