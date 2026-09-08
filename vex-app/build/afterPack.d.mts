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

/**
 * Assert that the packaged Lighter signer helpers are exactly this platform's
 * two, of the right format and machine, with the sha256 the pinned Go
 * toolchain recorded in `resources/lighter-signer/SHA256SUMS`. Returns the
 * helper file names accepted; throws with the mismatch named.
 */
export function verifyPackagedLighterSigner(
  context: AfterPackContext,
  options?: { readonly builtDir?: string }
): string[];

export default function afterPack(context: AfterPackContext): Promise<void>;
