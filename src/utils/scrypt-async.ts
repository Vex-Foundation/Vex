import { scrypt, type ScryptOptions } from "node:crypto";

/**
 * Promise form of `crypto.scrypt`, shared by the wallet keystore and the
 * secret vault KDFs.
 *
 * The derive runs on the libuv threadpool, so an N=2^17 derive (~128 MiB,
 * ~400ms) no longer blocks the calling thread. In the desktop app that thread
 * is the Electron main process, which also hosts the agent engine and every
 * IPC handler, so a synchronous derive froze the whole app for its duration.
 *
 * Same inputs, same options (N/r/p/maxmem) and the same output bytes as
 * `scryptSync`. Parameter validation errors that `scryptSync` would throw are
 * thrown synchronously by `scrypt` inside the executor and so surface as a
 * rejection; runtime KDF errors arrive through the callback and reject too.
 * Callers await it inside the same try/catch that wrapped the sync call.
 */
export function scryptAsync(
  password: string,
  salt: Uint8Array,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}
