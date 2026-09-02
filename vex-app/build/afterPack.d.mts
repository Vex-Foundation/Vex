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

export default function afterPack(context: AfterPackContext): Promise<void>;
