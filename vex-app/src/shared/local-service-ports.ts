/**
 * The loopback Postgres port the previous release's container stack
 * published. The data move from that release renders its stack on this
 * port (compose/render, paths/service-ports), and the e2e door and the e2e
 * stack refuse it so a test can never address a developer's old install.
 * Declared ONCE here instead of re-hardcoded per file (a prior
 * triple-declaration desync hazard). The bundled native runtime does not
 * use it: it keeps its last port while that is free, else takes one the
 * OS assigns.
 *
 * It is a deliberately UNCOMMON FIXED port in the registered range, BELOW
 * the Windows TCP dynamic/ephemeral range (49152-65535): Hyper-V/WinNAT
 * carves reboot-shifting *excluded* port blocks out of that range, and
 * binding inside one fails with WSAEACCES ("...forbidden by its access
 * permissions", Winsock 10013). Microsoft's guidance (KB 3039044) is to
 * use a port NOT in 49152-65535, so it is a quiet registered-range value
 * away from common dev ports and 5432.
 *
 * The embeddings runtime default (`DEFAULT_EMBED_PORT`) lives in
 * `embedding-defaults.ts` because the renderer mirrors it for wizard
 * placeholders; it follows the same below-the-dynamic-range rule.
 */
export const DEFAULT_PG_PORT = 27432;
