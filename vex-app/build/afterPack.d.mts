/**
 * electron-builder's afterPack context, narrowed to the fields this hook
 * reads. app-builder-lib passes `arch` as its own numeric `Arch` enum.
 */
export interface AfterPackContext {
  readonly electronPlatformName: string;
  readonly appOutDir: string;
  readonly arch: number;
  readonly packager: { readonly appInfo: { readonly productFilename: string } };
  readonly executableName?: string;
}

/**
 * Assert that every bridge artifact this target carries is present, correct
 * and for the right machine, at the path electron-builder packaged it to.
 * Resolves to the artifact names accepted; rejects with the mismatch named.
 */
export function verifyPackagedBridge(context: AfterPackContext): Promise<string[]>;

/** A platform signature tool's answer about one file. */
export interface PlatformSignature {
  readonly verified: boolean;
  readonly detail: string;
}

/**
 * Assert that the packaged Lighter signer helpers are exactly this platform's
 * two, of the right format and machine, with their provenance proven the way
 * this platform's packaging order allows: the sha256 the pinned Go toolchain
 * recorded in `resources/lighter-signer/SHA256SUMS` on macOS and Linux, and on
 * Windows either that same digest (an unsigned build) or, once
 * electron-builder has Authenticode-signed the helper while copying it in, the
 * Authenticode CONTENT digest of this build's own helper plus a signature that
 * verifies. Returns the helper file names accepted; throws with the mismatch
 * named.
 *
 * `builtDir` is the build output and its digest manifest; `stagedDir` defaults
 * to that directory's staging sibling. `inspectSignature` is the signature tool
 * seam, faked by tests that have neither a Windows host nor a signing identity.
 */
export function verifyPackagedLighterSigner(
  context: AfterPackContext,
  options?: {
    readonly builtDir?: string;
    readonly stagedDir?: string;
    readonly inspectSignature?: (file: string, platform: string) => PlatformSignature;
  }
): string[];

export default function afterPack(context: AfterPackContext): Promise<void>;
