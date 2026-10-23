/**
 * Vex Cloud sign-in (EIP-4361, "Sign-In with Ethereum") - the strict template
 * signer for the in-app EVM wallets.
 *
 * A SEPARATE signer from the AgentScan handshake (`handshake-signing.ts`),
 * which stays exactly as strict as it is: each signer accepts one fixed
 * template and nothing else, so neither can be widened into the other's
 * shape. The blast radius is contained the same way, at two independent
 * layers:
 *
 *   - `buildVexCloudSiweMessage` validates every field before the message is
 *     assembled. `nonce`, `domain` and `uri` round-trip through a server this
 *     module does not control, so each is shape-checked (no CR or LF, no
 *     whitespace, closed charsets) and the caller (main's sign-in owner)
 *     has already refused a server `domain`/`uri` that differs from the host
 *     it dialed. The text itself is produced by viem's `createSiweMessage`,
 *     the same function the backend re-serialises with to demand byte
 *     equality (`VexVirtualsCompute/src/auth/siwe.ts`), so the two sides
 *     cannot drift on formatting (checksummed address, ISO dates with
 *     milliseconds, resource list layout);
 *   - `signVexCloudSiweMessage` refuses anything that is not the EXACT
 *     whole-message shape below (anchored, line by line, fixed statement,
 *     chain id 4663, version 1, no request id, no not-before, no scheme,
 *     only `urn:vex:` resources in canonical order), and refuses to sign for
 *     any address but the wallet's own. A future caller that assembles a
 *     message by hand still cannot get an unexpected line signed.
 *
 * Keys are loaded through `loadEvmKey`, which fails closed (`SIGNER_MISMATCH`)
 * when the decrypted key does not derive the entry's recorded address, the
 * discipline every other EVM signing path here uses. A locked vault surfaces
 * as the typed `KEYSTORE_PASSWORD_NOT_SET` from the keystore chokepoint.
 *
 * Reachable only from the main process's Vex Cloud sign-in owner. Not a tool,
 * not exported through any tool barrel: the model can never request a SIWE
 * signature.
 */

import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

import type { WalletInventoryEntry } from "../../config/store.js";
import { ErrorCodes, VexError } from "../../errors.js";
import { loadEvmKey } from "./inventory.js";

/** The one statement Vex Cloud accepts (`SIWE_STATEMENT` in the backend). */
export const VEX_CLOUD_SIWE_STATEMENT = "Sign in to Vex Cloud with this wallet.";
/** Robinhood Chain: the only chain id the backend accepts. */
export const VEX_CLOUD_SIWE_CHAIN_ID = 4663;
export const VEX_CLOUD_SIWE_VERSION = "1";
/**
 * The longest validity the app will ever sign for, whatever the server
 * advertises. The backend's own bound (`SIWE_MAX_VALIDITY_SECONDS`) is at
 * most 3600 by its config schema; a message signed for longer is refused.
 */
export const VEX_CLOUD_SIWE_MAX_VALIDITY_MS = 3_600_000;

export type VexCloudSiweIntent =
  | { readonly kind: "signin" }
  | { readonly kind: "create" }
  | { readonly kind: "link"; readonly accountId: string };

const INTENT_SIGNIN = "urn:vex:intent:signin";
const INTENT_CREATE = "urn:vex:intent:create";
const INTENT_LINK_PREFIX = "urn:vex:intent:link:";
const LINK_PREFIX = "urn:vex:link:";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;
/** EIP-4361 nonce: alphanumeric, at least 8 (the backend issues 32). */
const NONCE_SHAPE = /^[A-Za-z0-9]{8,128}$/;
/** A host name with an optional port: what an RFC 3986 authority looks like here. */
const DOMAIN_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?$/;
const CARRIAGE_OR_LINEFEED = /[\r\n]/;

/**
 * The full, ordered message shape, anchored on the WHOLE string (no `m` or
 * `s` flags): every value is a closed charset with no line break, so a value
 * cannot embed one and still match.
 */
const ISO_MS = "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z";
const MESSAGE_SHAPE = new RegExp(
  [
    "^(?<domain>[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?) wants you to sign in with your Ethereum account:",
    "(?<address>0x[0-9a-fA-F]{40})",
    "",
    "Sign in to Vex Cloud with this wallet\\.",
    "",
    "URI: (?<uri>https?://[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?)",
    "Version: 1",
    "Chain ID: 4663",
    "Nonce: (?<nonce>[A-Za-z0-9]{8,128})",
    `Issued At: (?<issuedAt>${ISO_MS})`,
    `Expiration Time: (?<expirationTime>${ISO_MS})`,
    "Resources:",
    "- (?<intent>urn:vex:intent:(?:signin|create|link:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))(?<links>(?:\\n- urn:vex:link:0x[0-9a-f]{40})*)$",
  ].join("\\n"),
);

export interface VexCloudSiweMessageInput {
  /** The host the app dialed (`vexCloudSiweBinding().domain`). */
  readonly domain: string;
  /** The origin the app dialed (`vexCloudSiweBinding().uri`). */
  readonly uri: string;
  /** The signing wallet, any casing; checksummed in the message. */
  readonly address: string;
  /** Server-issued, single use. UNTRUSTED. */
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expirationTime: Date;
  readonly intent: VexCloudSiweIntent;
  /** Wallets this request links (empty for sign-in). */
  readonly linkSet: readonly string[];
}

function rejectTemplate(field: string): never {
  throw new VexError(
    ErrorCodes.VEX_CLOUD_SIWE_TEMPLATE_REJECTED,
    `Refusing to sign a Vex Cloud sign-in message: invalid ${field}.`,
    "This field does not match the Vex Cloud sign-in contract.",
  );
}

/**
 * The resources a message carries for an intent and a link set, in the
 * backend's canonical form (`intentResources`): the intent first, then each
 * linked address lowercased, deduplicated and sorted.
 */
export function vexCloudSiweResources(intent: VexCloudSiweIntent, linkSet: readonly string[]): string[] {
  const head =
    intent.kind === "signin"
      ? INTENT_SIGNIN
      : intent.kind === "create"
        ? INTENT_CREATE
        : `${INTENT_LINK_PREFIX}${intent.accountId}`;
  const links = [...new Set(linkSet.map((address) => address.toLowerCase()))]
    .sort()
    .map((address) => `${LINK_PREFIX}${address}`);
  return [head, ...links];
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validateInput(input: VexCloudSiweMessageInput): void {
  if (CARRIAGE_OR_LINEFEED.test(input.domain) || !DOMAIN_SHAPE.test(input.domain)) rejectTemplate("domain");
  let uri: URL;
  try {
    uri = new URL(input.uri);
  } catch {
    return rejectTemplate("uri");
  }
  if (CARRIAGE_OR_LINEFEED.test(input.uri) || uri.origin !== input.uri) rejectTemplate("uri");
  if (uri.hostname !== input.domain.replace(/:[0-9]+$/, "")) rejectTemplate("uri");
  if (!ADDRESS_SHAPE.test(input.address)) rejectTemplate("address");
  if (!NONCE_SHAPE.test(input.nonce)) rejectTemplate("nonce");
  if (!validDate(input.issuedAt) || !validDate(input.expirationTime)) rejectTemplate("time");
  const window = input.expirationTime.getTime() - input.issuedAt.getTime();
  if (window <= 0 || window > VEX_CLOUD_SIWE_MAX_VALIDITY_MS) rejectTemplate("expirationTime");
  if (input.intent.kind === "link" && !UUID_SHAPE.test(input.intent.accountId)) rejectTemplate("accountId");
  for (const address of input.linkSet) {
    if (!ADDRESS_SHAPE.test(address)) rejectTemplate("linkSet");
  }
  const linking = new Set(input.linkSet.map((address) => address.toLowerCase())).size;
  if (input.intent.kind === "signin" && linking > 0) rejectTemplate("linkSet");
  if (input.intent.kind !== "signin" && linking === 0) rejectTemplate("linkSet");
}

/**
 * Build the exact EIP-4361 text the backend re-serialises and compares byte
 * for byte. Pure: no I/O, no key material. Every field is validated first,
 * and the result passes the signer's own shape check before it is returned.
 */
export function buildVexCloudSiweMessage(input: VexCloudSiweMessageInput): string {
  validateInput(input);
  const message = createSiweMessage({
    address: getAddress(input.address),
    chainId: VEX_CLOUD_SIWE_CHAIN_ID,
    domain: input.domain,
    nonce: input.nonce,
    uri: input.uri,
    version: VEX_CLOUD_SIWE_VERSION,
    statement: VEX_CLOUD_SIWE_STATEMENT,
    issuedAt: input.issuedAt,
    expirationTime: input.expirationTime,
    resources: vexCloudSiweResources(input.intent, input.linkSet),
  });
  assertVexCloudSiweMessage(message);
  return message;
}

/** What the shape check extracted from a well-formed message. */
export interface VexCloudSiweMessageFields {
  readonly domain: string;
  readonly address: `0x${string}`;
  readonly uri: string;
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expirationTime: Date;
  readonly resources: readonly string[];
}

/**
 * Second, independent layer: the whole-message shape, plus the invariants a
 * regex cannot state (checksummed address, canonical link order, intent and
 * link set agreeing, a bounded validity window). Throws the typed template
 * rejection on any miss.
 */
export function assertVexCloudSiweMessage(message: string): VexCloudSiweMessageFields {
  const match = MESSAGE_SHAPE.exec(message);
  const groups = match?.groups;
  if (groups === undefined) return rejectTemplate("message shape");
  const { domain, address, uri, nonce, issuedAt, expirationTime, intent, links } = groups;
  if (
    domain === undefined ||
    address === undefined ||
    uri === undefined ||
    nonce === undefined ||
    issuedAt === undefined ||
    expirationTime === undefined ||
    intent === undefined
  ) {
    return rejectTemplate("message shape");
  }
  if (getAddress(address) !== address) rejectTemplate("address checksum");
  const linkSet = (links ?? "")
    .split("\n- ")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(LINK_PREFIX.length));
  const canonical = [...new Set(linkSet)].sort();
  if (canonical.length !== linkSet.length || canonical.some((value, index) => value !== linkSet[index])) {
    rejectTemplate("resources order");
  }
  if (intent === INTENT_SIGNIN && linkSet.length > 0) rejectTemplate("resources");
  if (intent !== INTENT_SIGNIN && linkSet.length === 0) rejectTemplate("resources");
  const issued = new Date(issuedAt);
  const expires = new Date(expirationTime);
  if (issued.toISOString() !== issuedAt || expires.toISOString() !== expirationTime) rejectTemplate("time");
  const window = expires.getTime() - issued.getTime();
  if (window <= 0 || window > VEX_CLOUD_SIWE_MAX_VALIDITY_MS) rejectTemplate("expirationTime");
  return {
    domain,
    address: address as `0x${string}`,
    uri,
    nonce,
    issuedAt: issued,
    expirationTime: expires,
    resources: [intent, ...linkSet.map((value) => `${LINK_PREFIX}${value}`)],
  };
}

/**
 * EIP-191 `personal_sign` over the message, with the wallet's own key, only
 * when the message is the exact Vex Cloud shape AND names this wallet. The
 * shape check runs BEFORE the keystore is touched.
 */
export async function signVexCloudSiweMessage(entry: WalletInventoryEntry, message: string): Promise<Hex> {
  const fields = assertVexCloudSiweMessage(message);
  if (!ADDRESS_SHAPE.test(entry.address) || getAddress(entry.address) !== fields.address) {
    rejectTemplate("signer address");
  }
  const { privateKey } = await loadEvmKey(entry);
  const account = privateKeyToAccount(privateKey);
  return account.signMessage({ message });
}
